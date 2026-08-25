/**
 * In-process Claude CLI diagnostics. Same checks as scripts/doctor.mjs, but
 * callable from a running app (Telegram /doctor) so the report uses the bot's
 * real environment instead of a different shell.
 */
import { spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import { claudeAuthStatus } from "../setup/claude.js";
import { config, normalizeModelId } from "../config.js";
import { mainSettingsView } from "./mainSettings.js";
import { log } from "../logger.js";

const CLAUDE_CLI = process.platform === "win32" ? "claude.cmd" : "claude";
const CLAUDE_EXEC_OPTS = { shell: process.platform === "win32" } as const;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export type DoctorLevel = "ok" | "fail" | "warn" | "info";

export interface DoctorCheck {
  level: DoctorLevel;
  text: string;
  output?: string;
}

export interface DoctorReport {
  platform: string;
  node: string;
  checks: DoctorCheck[];
  loggedIn: boolean;
  promptOk: boolean;
  sdkOk: boolean;
}

export interface PromptTestResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function redact(s: string): string {
  return stripAnsi(s)
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…")
    .replace(/claude_oauth_[A-Za-z0-9_-]+/g, "claude_oauth_…")
    .replace(/sk-[A-Za-z0-9]{16,}/g, "sk-…");
}

function clip(s: string, max = 800): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function runClaude(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_CLI, args, {
      ...CLAUDE_EXEC_OPTS,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ stdout, stderr: stderr || "timed out", code: null });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, code: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin?.end();
  });
}

/** Headless `claude -p hi`. This is the silent-crash failure mode. */
export async function runClaudePromptTest(timeoutMs = 45_000): Promise<PromptTestResult> {
  const r = await runClaude(["-p", "hi"], timeoutMs);
  return {
    ok: r.code === 0,
    code: r.code,
    stdout: redact(r.stdout),
    stderr: redact(r.stderr),
  };
}

export async function runClaudeDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const plat = platform();
  const node = process.version;

  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (baseUrl) {
    checks.push({
      level: "warn",
      text: `ANTHROPIC_BASE_URL=${baseUrl} is set. Headless turns go to that proxy, not Anthropic.`,
    });
  }
  if (authToken) {
    checks.push({
      level: "warn",
      text: "ANTHROPIC_AUTH_TOKEN is set. It overrides the Claude subscription login.",
    });
  }
  if (config.ANTHROPIC_API_KEY) {
    checks.push({
      level: "warn",
      text: "ANTHROPIC_API_KEY is set. Headless `claude -p` uses the key, not the /claude_login subscription.",
    });
  }

  const ver = await runClaude(["--version"], 15_000);
  const version = clip(redact(ver.stdout) || redact(ver.stderr), 120);
  const cliOk = ver.code === 0;
  if (cliOk) {
    checks.push({ level: "ok", text: `claude CLI: ${version || "ok"}` });
  } else {
    checks.push({
      level: "fail",
      text: "claude CLI is not runnable (not installed, or not on PATH for this process).",
      output: clip(version),
    });
  }

  const auth = await claudeAuthStatus();
  if (auth.loggedIn) {
    const who = auth.email ? ` as ${auth.email}` : "";
    const plan = auth.subscriptionType ? ` (${auth.subscriptionType})` : "";
    checks.push({ level: "ok", text: `Claude login found${who}${plan}.` });
  } else if (auth.cliInstalled) {
    checks.push({
      level: "fail",
      text: "No Claude login for this process. /claude_login on Telegram, or `claude auth login --claudeai` on the host.",
    });
  } else {
    checks.push({
      level: "fail",
      text: "Claude CLI is not installed. npm install -g @anthropic-ai/claude-code",
    });
  }

  let promptOk = false;
  if (cliOk) {
    const prompt = await runClaudePromptTest(60_000);
    promptOk = prompt.ok;
    if (prompt.ok) {
      checks.push({
        level: "ok",
        text: 'Test prompt `claude -p "hi"` succeeded.',
        output: clip(prompt.stdout, 300) || undefined,
      });
    } else {
      const empty = !prompt.stdout.trim() && !prompt.stderr.trim();
      checks.push({
        level: "fail",
        text: empty
          ? `Test prompt failed (exit ${prompt.code ?? "timeout"}) with no output. Same failure as the silent crash.`
          : `Test prompt failed (exit ${prompt.code ?? "timeout"}).`,
        output: clip([prompt.stdout, prompt.stderr].filter((s) => s.trim()).join("\n")) || undefined,
      });
    }
  }

  let sdkOk = false;
  if (cliOk) {
    const model = normalizeModelId(mainSettingsView().effectiveModel || config.CLAUDE_MODEL);
    const sdkStderr: string[] = [];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 90_000);
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      let resultText = "";
      let isError = false;
      const resp = query({
        prompt: "reply with exactly: ok",
        options: {
          cwd: homedir(),
          model,
          abortController: ac,
          settingSources: ["user"],
          stderr: (d: string) => {
            const s = String(d).trim();
            if (s) sdkStderr.push(redact(s));
          },
        },
      });
      for await (const msg of resp as AsyncIterable<{ type?: string; result?: string; is_error?: boolean }>) {
        if (msg?.type === "result") {
          resultText = msg.result ?? "";
          isError = Boolean(msg.is_error);
        }
      }
      sdkOk = !isError;
      if (isError) {
        checks.push({
          level: "fail",
          text: `Agent SDK turn failed (model ${model}). This is the path MyAgens uses.`,
          output: clip(redact(resultText) || sdkStderr.join("\n")),
        });
      } else {
        checks.push({
          level: "ok",
          text: `Agent SDK turn succeeded (model ${model}).`,
          output: clip(redact(resultText), 120) || undefined,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checks.push({
        level: "fail",
        text: `Agent SDK turn failed (model ${model}). This is the path MyAgens uses.`,
        output: clip([redact(message), sdkStderr.join("\n")].filter(Boolean).join("\n")),
      });
    } finally {
      clearTimeout(timer);
      if (sdkStderr.length && !checks.some((c) => c.output && c.text.includes("Agent SDK"))) {
        checks.push({
          level: "info",
          text: "Agent SDK stderr",
          output: clip(sdkStderr.join("\n"), 1500),
        });
      }
    }
  }

  log.info("Claude doctor finished", {
    loggedIn: auth.loggedIn,
    promptOk,
    sdkOk,
    fails: checks.filter((c) => c.level === "fail").length,
  });

  return {
    platform: plat,
    node,
    checks,
    loggedIn: auth.loggedIn,
    promptOk,
    sdkOk,
  };
}
