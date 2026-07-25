import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunOptions, RunResult } from "../claude/runner.js";
import { memory, formatMemoriesForPrompt } from "../core/memory.js";
import { log } from "../logger.js";
import { registerAgyRun, type AgyRunHandle } from "./bridge.js";
import { ensureAgyCustomization } from "./customization.js";
import { buildAgyPrompt, markAgySystemInjected } from "./prompt.js";

/**
 * Drive one turn through Google's Antigravity CLI (`agy`), spawned as a
 * subprocess — the same "wrap the provider's own agentic CLI" approach the
 * grok/codex/cursor backends use. Antigravity's own tool belt (file edits,
 * terminal, browser) runs inside the subprocess.
 *
 * `agy --print` streams plain prose to stdout progressively and emits no
 * structured events, so three things the Claude backend gets for free have to
 * be built around the CLI instead. All three hang off a customization root we
 * write under the data dir and pass as an extra `--add-dir`
 * (src/agy/customization.ts) — Antigravity scans every workspace directory for
 * customizations, so this stays scoped to our runs and never touches the user's
 * own `agy` setup:
 * - **Our MCP tools** (memory, kanban, crew, connectors, send_file, …) are
 *   republished to the CLI by a stdio MCP server that proxies back into this
 *   process (src/agy/bridge.ts).
 * - **Tool visibility and approvals** for Antigravity's own tools come from a
 *   PreToolUse/PostToolUse hook that calls the same bridge, so `onToolUse`
 *   fires live and risky calls still reach the user's Approve/Deny buttons.
 * - **The system prompt** (persona, work.md, known paths, crew, memories) is
 *   carried in the prompt text, since the CLI has no flag for it
 *   (src/agy/prompt.ts).
 *
 * Permissions: Antigravity's print mode auto-approves file edits and terminal
 * commands (there is no interactive prompt to defer to) and hard-denies MCP
 * calls it cannot prompt for. So whenever the hook gate is in place we pass
 * `--dangerously-skip-permissions` and let the hook be the real gate — that is
 * strictly tighter than the CLI's own headless behaviour, and it is what makes
 * the MCP tools usable at all. If the customization root can't be written we
 * fall back to the CLI's own containment: `--sandbox` for interactive turns.
 *
 * The conversation id (Antigravity's resume token) is only ever printed to the
 * CLI's log file, so each turn passes `--log-file` pointing at a temp file and
 * parses `Print mode: conversation=<uuid>` out of it afterwards. Resuming with
 * a stale/unknown id doesn't error — agy silently starts a fresh conversation
 * and logs the new id, so a dead resume token self-heals via `onSessionId`.
 *
 * Without `--add-dir`, agy treats its own scratch directory as the workspace
 * and writes files there — so the session cwd is always passed as a workspace
 * root in addition to being the spawn cwd.
 *
 * Still missing versus the Claude backend: token/cost accounting (the CLI
 * reports none) and external MCP connectors that run as their own
 * process/endpoint rather than in ours (Unreal, Unity, Browser Sketchpad).
 */
export async function runTurn(opts: RunOptions): Promise<RunResult> {
  // Same recall the Claude backend does, honouring the per-agent "memory"
  // prompt-slimming exclusion (skip the store entirely, inject nothing).
  const recalled = opts.promptExclude?.includes("memory")
    ? []
    : await memory.recallForPromptAsync(opts.prompt);
  const memoryBlock = recalled.length ? formatMemoriesForPrompt(recalled) : undefined;
  const { prompt, systemHash } = buildAgyPrompt(opts, memoryBlock);

  const root = await ensureAgyCustomization();
  let bridge: AgyRunHandle | undefined;
  if (root) {
    bridge = await registerAgyRun({
      mcpServers: opts.mcpServers,
      permissionMode: opts.permissionMode,
      canUseTool: opts.canUseTool,
      onToolUse: opts.onToolUse,
      onToolResult: opts.onToolResult,
    });
  }

  // The conversation id only appears in agy's log — capture it per turn in a
  // throwaway file rather than tailing the shared default log.
  const logFile = path.join(tmpdir(), `agy-turn-${randomUUID()}.log`);
  const args = ["--print", prompt];
  // Our customization root is a workspace dir too, and Antigravity treats the
  // LAST one as the place to put new files — so it goes first and the session
  // cwd goes last, or the agent would write its work into our config folder.
  if (root) args.push("--add-dir", root);
  args.push(
    "--add-dir",
    opts.cwd,
    "--log-file",
    logFile,
    // agy's print mode defaults to a 5-minute wait; long agentic turns need
    // more. The stall guard wrapping every backend still catches stuck turns.
    "--print-timeout",
    "30m",
  );
  if (bridge || opts.permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--sandbox");
  }
  if (opts.resume) args.push("--conversation", opts.resume);
  if (opts.model) args.push("--model", opts.model);

  const startedAt = Date.now();
  try {
    return await new Promise<RunResult>((resolve, reject) => {
      const child = spawn("agy", args, {
        cwd: opts.cwd,
        signal: opts.abortController.signal,
        stdio: ["ignore", "pipe", "pipe"],
        // opts.env is deliberately ignored (agy manages its own auth, like the
        // other CLI backends); the bridge coordinates are added so the MCP
        // server and hooks agy spawns can call back into this turn.
        env: {
          ...process.env,
          ...(bridge
            ? { MYAGENS_AGY_BRIDGE_URL: bridge.url, MYAGENS_AGY_BRIDGE_TOKEN: bridge.token }
            : {}),
        },
      });

      let text = "";
      const stderr: string[] = [];

      child.stdout.on("data", (chunk: Buffer) => {
        const delta = chunk.toString("utf8");
        text += delta;
        opts.onText(delta);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const line = chunk.toString("utf8").trim();
        if (line) {
          stderr.push(line);
          log.debug("agy stderr", { line: line.slice(0, 500) });
        }
      });

      child.on("error", (err) => reject(err));

      child.on("close", (code) => {
        void (async () => {
          if (code !== 0) {
            const tail = stderr.slice(-8).join("\n");
            reject(new Error(`agy exited with code ${code}${tail ? ` — ${tail}` : ""}`));
            return;
          }
          // Parse the resume token out of the per-turn log. When a stale
          // --conversation id was passed, agy starts fresh and this picks up
          // the NEW conversation's id, healing the stored session.
          try {
            const logText = await readFile(logFile, "utf8");
            const m = logText.match(/Print mode: conversation=([0-9a-f-]{36})/);
            if (m) {
              opts.onSessionId(m[1]);
              // Record that this conversation now carries the system block, so
              // the next turn on it only sends the volatile part.
              markAgySystemInjected(m[1], systemHash);
            }
          } catch (err) {
            log.warn("agy: could not read turn log for conversation id", { err: String(err) });
          }
          resolve({
            isError: false,
            text,
            durationMs: Date.now() - startedAt,
            toolCalls: bridge?.toolCalls ?? [],
          });
        })().catch(reject);
      });
    });
  } finally {
    bridge?.dispose();
    await rm(logFile, { force: true }).catch(() => {});
  }
}

/**
 * List the model labels the installed agy CLI can run (`agy models` output,
 * e.g. "Gemini 3.1 Pro (High)") — these exact labels are what `--model`
 * accepts. Empty array when the CLI is missing or errors, so the panel's
 * fetch button degrades quietly.
 */
export async function listAgyModels(): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn("agy", ["models"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", () => resolve([]));
    child.on("close", (code) => {
      if (code !== 0) return resolve([]);
      resolve(
        out
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      );
    });
  });
}
