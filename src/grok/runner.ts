import { spawn } from "node:child_process";
import type { RunOptions, RunResult } from "../claude/runner.js";
import { log } from "../logger.js";

/**
 * Drive one turn through xAI's `grok` CLI, spawned as a subprocess — the same
 * "wrap the provider's own agentic CLI" approach src/claude/runner.ts uses for
 * the `claude` CLI. Grok's own tool belt, sandboxing, and permission handling
 * all run inside the subprocess; this only captures its streamed text and
 * final session id.
 *
 * Grok's `--output-format streaming-json` emits newline-delimited JSON events
 * of three kinds: `{type:"thought",data}` (reasoning deltas, not surfaced to
 * the user), `{type:"text",data}` (response text deltas), and a final
 * `{type:"end",stopReason,sessionId,requestId}`. No tool-call or usage/cost
 * events appear in this output mode, so `onToolUse`/`onToolResult` never fire
 * here and `RunResult.tokens`/`costUsd` are always empty for this backend —
 * an accepted limitation of wrapping the CLI's plain output rather than a bug.
 */
export async function runTurn(opts: RunOptions): Promise<RunResult> {
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "streaming-json",
    "--cwd",
    opts.cwd,
    // Grok's --permission-mode accepts the exact same "default"/"bypassPermissions"
    // strings RunOptions.permissionMode already uses, so no translation needed.
    "--permission-mode",
    opts.permissionMode,
  ];
  if (opts.resume) args.push("--resume", opts.resume);
  if (opts.model) args.push("--model", opts.model);

  const startedAt = Date.now();
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn("grok", args, {
      cwd: opts.cwd,
      signal: opts.abortController.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    let text = "";
    let gotEnd = false;
    const stderr: string[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let evt: { type?: string; data?: string; sessionId?: string };
        try {
          evt = JSON.parse(line);
        } catch {
          continue; // skip malformed/non-JSON lines
        }
        if (evt.type === "text" && typeof evt.data === "string") {
          text += evt.data;
          opts.onText(evt.data);
        } else if (evt.type === "end") {
          gotEnd = true;
          if (evt.sessionId) opts.onSessionId(evt.sessionId);
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line) {
        stderr.push(line);
        log.debug("grok stderr", { line: line.slice(0, 500) });
      }
    });

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      if (code !== 0 && !gotEnd) {
        const tail = stderr.slice(-8).join("\n");
        reject(new Error(`grok exited with code ${code}${tail ? ` — ${tail}` : ""}`));
        return;
      }
      if (code !== 0) {
        log.warn("grok exited non-zero after a successful stream — using the captured result", { code });
      }
      resolve({ isError: false, text, durationMs: Date.now() - startedAt });
    });
  });
}
