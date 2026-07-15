import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunOptions, RunResult } from "../claude/runner.js";
import { log } from "../logger.js";

/**
 * Drive one turn through Google's Antigravity CLI (`agy`), spawned as a
 * subprocess — the same "wrap the provider's own agentic CLI" approach the
 * grok/codex backends use. Antigravity's own tool belt (file edits, terminal,
 * browser) runs inside the subprocess; this captures its streamed text and
 * final conversation id.
 *
 * `agy --print` streams plain prose to stdout progressively (no structured
 * event output exists as of agy 1.1.2), so `onToolUse`/`onToolResult` never
 * fire and `RunResult.tokens`/`costUsd` are always empty for this backend —
 * the same accepted limitation as grok-cli. The conversation id (Antigravity's
 * resume token) is only ever printed to the CLI's log file, so each turn
 * passes `--log-file` pointing at a temp file and parses
 * `Print mode: conversation=<uuid>` out of it afterwards. Resuming with a
 * stale/unknown id doesn't error — agy silently starts a fresh conversation
 * and logs the new id, so a dead resume token self-heals via `onSessionId`.
 *
 * Permission mapping is coarser than the other CLI backends: print mode
 * auto-approves file edits AND terminal commands even without
 * `--dangerously-skip-permissions` (there is no interactive prompt to defer
 * to). "default" mode therefore adds `--sandbox` (terminal restricted to the
 * workspace) as the best available containment; "bypassPermissions" passes
 * `--dangerously-skip-permissions` to also lift sandbox/review gates.
 *
 * Without `--add-dir`, agy treats its own scratch directory as the workspace
 * and writes files there — so the session cwd is always passed as a workspace
 * root in addition to being the spawn cwd.
 */
export async function runTurn(opts: RunOptions): Promise<RunResult> {
  // The conversation id only appears in agy's log — capture it per turn in a
  // throwaway file rather than tailing the shared default log.
  const logFile = path.join(tmpdir(), `agy-turn-${randomUUID()}.log`);
  const args = [
    "--print",
    opts.prompt,
    "--add-dir",
    opts.cwd,
    "--log-file",
    logFile,
    // agy's print mode defaults to a 5-minute wait; long agentic turns need
    // more. The stall guard wrapping every backend still catches stuck turns.
    "--print-timeout",
    "30m",
  ];
  if (opts.permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  else args.push("--sandbox");
  if (opts.resume) args.push("--conversation", opts.resume);
  if (opts.model) args.push("--model", opts.model);

  const startedAt = Date.now();
  try {
    return await new Promise<RunResult>((resolve, reject) => {
      const child = spawn("agy", args, {
        cwd: opts.cwd,
        signal: opts.abortController.signal,
        stdio: ["ignore", "pipe", "pipe"],
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
            if (m) opts.onSessionId(m[1]);
          } catch (err) {
            log.warn("agy: could not read turn log for conversation id", { err: String(err) });
          }
          resolve({ isError: false, text, durationMs: Date.now() - startedAt });
        })().catch(reject);
      });
    });
  } finally {
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
