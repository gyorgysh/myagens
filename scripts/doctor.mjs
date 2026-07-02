#!/usr/bin/env node
// doctor.mjs — diagnose why the bot's Claude turns fail.
//
// The bot drives the `claude` CLI via the Agent SDK. When that CLI exits 1 with
// no output, Telegram only shows "Claude Code process exited with code 1". This
// runs the same CLI directly and prints the REAL stdout/stderr/exit code, plus
// checks the CLI is installed and logged in.
//
//   npm run doctor

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo, platform } from "node:os";
import { join } from "node:path";

const pexec = promisify(execFile);
const isWin = platform() === "win32";
// Windows ships claude.cmd; run through the shell so PATHEXT resolves it.
const CLAUDE = isWin ? "claude.cmd" : "claude";

const C = { g: "\x1b[32m", r: "\x1b[31m", c: "\x1b[36m", y: "\x1b[33m", z: "\x1b[0m" };
const ok = (m) => console.log(`${C.g}+${C.z} ${m}`);
const bad = (m) => console.log(`${C.r}x${C.z} ${m}`);
const info = (m) => console.log(`${C.c}*${C.z} ${m}`);

// Run the claude CLI, closing stdin immediately so `claude -p` doesn't wait ~3s
// for piped input. Resolves on exit 0, rejects with {code,stdout,stderr} otherwise.
function runClaude(args, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, args, { shell: isWin, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT", stdout, stderr }));
    }, timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(Object.assign(e, { stdout, stderr }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`exited with code ${code}`), { code, stdout, stderr }));
    });
    child.stdin.end();
  });
}

// Load .env into process.env (without overriding the real shell env) so the
// checks below run with the SAME variables the bot sees — e.g. a bad
// ANTHROPIC_API_KEY in .env would break the bot but not a bare shell.
function loadEnv() {
  try {
    for (const line of readFileSync(join(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch {
    /* no .env */
  }
}
loadEnv();

console.log(`\n${C.y}MyAgens doctor${C.z} — checking the Claude Code connection\n`);
info(`platform: ${platform()}   node: ${process.version}`);
if (process.env.ANTHROPIC_API_KEY) info("ANTHROPIC_API_KEY is set in the environment (overrides the CLI login).");
if (process.env.ANTHROPIC_BASE_URL) info(`ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL} (a provider/proxy, not Anthropic).`);

// 1) Is the CLI installed and runnable?
let cliOk = false;
try {
  const { stdout } = await runClaude(["--version"], 15000);
  ok(`claude CLI: ${stdout.trim()}`);
  cliOk = true;
} catch (e) {
  bad(`claude CLI not runnable (${e.code ?? e.message}).`);
  bad("  Fix: npm install -g @anthropic-ai/claude-code, and make sure it's on PATH.");
}

// 2) Are there credentials? (Keychain on macOS, ~/.claude/.credentials.json elsewhere)
let creds = false;
if (isWin === false && platform() === "darwin") {
  try {
    await pexec(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-a", userInfo().username, "-w"],
      { timeout: 5000 },
    );
    ok("Claude login found in the macOS Keychain.");
    creds = true;
  } catch {
    /* not in keychain; check the file next */
  }
}
const credFile = join(homedir(), ".claude", ".credentials.json");
if (!creds && existsSync(credFile)) {
  ok(`Claude login found at ${credFile}.`);
  creds = true;
}
if (!creds) {
  if (process.env.ANTHROPIC_API_KEY) {
    ok("ANTHROPIC_API_KEY is set (API-key auth, no login needed).");
    creds = true;
  } else {
    bad("No Claude login found and no ANTHROPIC_API_KEY.");
    bad("  Fix: run `claude setup-token` (needs Pro/Max), or set ANTHROPIC_API_KEY in .env.");
  }
}

// 3) The real test: run a prompt exactly like the bot does and show the output.
if (cliOk) {
  info('Running a test prompt: claude -p "hi" ...');
  try {
    const { stdout, stderr } = await runClaude(["-p", "hi"]);
    ok("Test prompt succeeded — the bot should work.");
    if (stdout.trim()) console.log(`  output: ${stdout.trim().slice(0, 300)}`);
    if (stderr.trim()) info(`  stderr: ${stderr.trim().slice(0, 500)}`);
  } catch (e) {
    bad("Test prompt FAILED — this is exactly what your bot hits:");
    console.log(`  exit code: ${e.code}`);
    if (e.stdout && e.stdout.trim()) console.log(`  stdout: ${e.stdout.trim().slice(0, 1500)}`);
    if (e.stderr && e.stderr.trim()) console.log(`  stderr: ${e.stderr.trim().slice(0, 1500)}`);
    if (!e.stdout?.trim() && !e.stderr?.trim()) {
      console.log("  (the CLI produced no output — almost always a login problem)");
      console.log("  Fix: run `claude setup-token`, then `claude -p hi` should reply.");
    }
  }
}

// 4) Definitive test: drive the Agent SDK exactly like the bot. If `claude -p`
// works but this fails, the problem is the SDK invocation (model, the bundled
// CLI, MCP, the run cwd) — not your shell login.
const MODEL = resolveModel();
info(`Running via the Agent SDK (the real bot path, model: ${MODEL}) ...`);
const sdkStderr = [];
try {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  let resultText = "";
  let isError = false;
  const resp = query({
    prompt: "reply with exactly: ok",
    options: {
      model: MODEL,
      stderr: (d) => {
        const s = String(d).trim();
        if (s) sdkStderr.push(s);
      },
      settingSources: ["user", "project", "local"],
    },
  });
  for await (const msg of resp) {
    if (msg?.type === "result") {
      resultText = msg.result ?? "";
      isError = Boolean(msg.is_error);
    }
  }
  if (isError) bad(`SDK turn returned an error result: ${resultText.slice(0, 300)}`);
  else ok(`SDK turn succeeded (model ${MODEL}). Output: ${resultText.trim().slice(0, 120)}`);
} catch (e) {
  bad("SDK turn FAILED — this is exactly what the bot hits:");
  console.log(`  message: ${e?.message ?? e}`);
} finally {
  if (sdkStderr.length) {
    info("SDK stderr (the real reason):");
    console.log("  " + sdkStderr.join("\n  ").slice(0, 2000));
  } else {
    console.log("  (the SDK produced no stderr — if the turn failed, try a different model:");
    console.log("   set a model in the panel, e.g. claude-opus-4-8, and re-run)");
  }
}

console.log("");

// Resolve the model the bot would use: panel override (data/mainAgent.json),
// then CLAUDE_MODEL from .env, then the default.
function resolveModel() {
  try {
    const m = JSON.parse(readFileSync(join(process.cwd(), "data", "mainAgent.json"), "utf8"));
    if (m?.settings?.model) return m.settings.model;
  } catch {
    /* no panel override */
  }
  try {
    const env = readFileSync(join(process.cwd(), ".env"), "utf8");
    const line = env.split(/\r?\n/).find((l) => /^\s*CLAUDE_MODEL\s*=/.test(l));
    if (line) return line.slice(line.indexOf("=") + 1).trim();
  } catch {
    /* no .env */
  }
  return "claude-opus-4-8";
}
