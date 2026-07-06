/**
 * Claude authentication helpers for the first-run setup wizard: detect an
 * existing CLI login, drive `claude setup-token` from the browser, and validate
 * a pasted API key. Mirrors the invocation conventions of core/claudeUsage.ts
 * (claude.cmd + shell on Windows) without importing config-dependent modules.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CLAUDE_CLI = process.platform === "win32" ? "claude.cmd" : "claude";
const CLAUDE_EXEC_OPTS = { shell: process.platform === "win32" } as const;

export interface ClaudeAuthState {
  cliInstalled: boolean;
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
}

export async function claudeAuthStatus(): Promise<ClaudeAuthState> {
  let cliInstalled = false;
  try {
    await execFileAsync(CLAUDE_CLI, ["--version"], { timeout: 8_000, ...CLAUDE_EXEC_OPTS });
    cliInstalled = true;
  } catch {
    /* not on PATH */
  }
  if (cliInstalled) {
    try {
      const { stdout } = await execFileAsync(CLAUDE_CLI, ["auth", "status"], {
        timeout: 8_000,
        ...CLAUDE_EXEC_OPTS,
      });
      const data = JSON.parse(stdout.trim()) as Record<string, unknown>;
      return {
        cliInstalled,
        loggedIn: Boolean(data.loggedIn),
        email: typeof data.email === "string" ? data.email : undefined,
        subscriptionType: typeof data.subscriptionType === "string" ? data.subscriptionType : undefined,
      };
    } catch {
      /* fall through to credential-store check */
    }
  }
  // Fallback: stored OAuth credentials imply a login even when `claude auth
  // status` is unavailable (old CLI) or slow.
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    if (existsSync(credPath)) {
      const creds = JSON.parse(readFileSync(credPath, "utf8")) as {
        claudeAiOauth?: { accessToken?: string };
      };
      if (creds.claudeAiOauth?.accessToken) return { cliInstalled, loggedIn: true };
    }
  } catch {
    /* unreadable — treat as logged out */
  }
  return { cliInstalled, loggedIn: false };
}

/** Cheaply verify a pasted Anthropic API key against the models endpoint. */
export async function validateApiKey(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, error: "Anthropic rejected this key. Check it for typos." };
    return { ok: false, error: `Anthropic answered with HTTP ${res.status}. Try again in a moment.` };
  } catch {
    return { ok: false, error: "Couldn't reach api.anthropic.com. Check your internet connection." };
  }
}

export interface LoginFlowState {
  running: boolean;
  /** OAuth URL scraped from the CLI output, for the wizard to open. */
  url?: string;
  /** True once the CLI appears to be waiting for the pasted authorization code. */
  waitingForCode: boolean;
  exitCode?: number | null;
  error?: string;
}

const URL_RE = /https:\/\/[^\s\x1b"'<>)\]]+/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Drives `claude setup-token` (the only launchable Pro/Max login path) on behalf
 * of the browser wizard. Prefers a PTY (node-pty is an existing optional dep) so
 * the CLI behaves exactly as in a terminal; falls back to plain pipes, which
 * newer CLI builds accept as well. The wizard shows the scraped OAuth URL and
 * relays the pasted authorization code back to the child's stdin.
 */
export class SetupTokenFlow {
  readonly state: LoginFlowState = { running: false, waitingForCode: false };
  private child: ChildProcessWithoutNullStreams | null = null;
  private pty: { write(data: string): void; kill(): void } | null = null;
  private output = "";

  async start(): Promise<void> {
    if (this.state.running) return;
    this.output = "";
    Object.assign(this.state, { running: true, url: undefined, waitingForCode: false, exitCode: undefined, error: undefined });
    try {
      const { spawn: ptySpawn } = await import("node-pty");
      const pty = ptySpawn(CLAUDE_CLI, ["setup-token"], {
        name: "xterm-256color",
        cols: 200,
        rows: 50,
        cwd: homedir(),
        env: process.env as Record<string, string>,
      });
      this.pty = pty;
      pty.onData((data: string) => this.consume(data));
      pty.onExit(({ exitCode }: { exitCode: number }) => this.finish(exitCode));
      return;
    } catch {
      /* node-pty unavailable (optional dep) — fall back to pipes */
    }
    try {
      const child = spawn(CLAUDE_CLI, ["setup-token"], {
        cwd: homedir(),
        stdio: ["pipe", "pipe", "pipe"],
        ...CLAUDE_EXEC_OPTS,
      });
      this.child = child;
      child.stdout.on("data", (d: Buffer) => this.consume(d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => this.consume(d.toString("utf8")));
      child.on("error", (err) => {
        this.state.error = err.message.includes("ENOENT")
          ? "The `claude` CLI isn't installed. Use an API key instead, or install Claude Code first."
          : err.message;
        this.finish(null);
      });
      child.on("exit", (code) => this.finish(code));
    } catch (err) {
      this.state.error = err instanceof Error ? err.message : String(err);
      this.finish(null);
    }
  }

  private consume(chunk: string): void {
    this.output = (this.output + chunk).slice(-65_536);
    const clean = this.output.replace(ANSI_RE, "");
    if (!this.state.url) {
      const m = clean.match(URL_RE);
      if (m) this.state.url = m[0];
    }
    if (/paste|code here|authorization code/i.test(clean)) this.state.waitingForCode = true;
  }

  sendCode(code: string): void {
    const line = code.trim();
    if (!line) return;
    if (this.pty) this.pty.write(`${line}\r`);
    else this.child?.stdin.write(`${line}\n`);
  }

  cancel(): void {
    try {
      this.pty?.kill();
      this.child?.kill();
    } catch {
      /* already gone */
    }
  }

  private finish(code: number | null): void {
    this.state.running = false;
    this.state.exitCode = code;
    this.pty = null;
    this.child = null;
  }
}
