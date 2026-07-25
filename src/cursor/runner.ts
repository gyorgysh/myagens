import { spawn } from "node:child_process";
import type { RunOptions, RunResult, TokenUsage } from "../claude/runner.js";
import { log } from "../logger.js";

/**
 * Drive one turn through Cursor's `cursor-agent` CLI, spawned as a subprocess,
 * the same "wrap the provider's own agentic CLI" approach used for `claude`
 * (src/claude/runner.ts), `grok`, `codex` and `agy`. Cursor's own tool belt
 * (file edits, shell, search) and sandboxing run inside the subprocess.
 *
 * `-p --output-format stream-json` emits newline-delimited JSON events:
 * `system`/`init` (carries the resumable `session_id`), `user` (the echoed
 * prompt), `thinking` deltas (reasoning, not surfaced), `assistant` messages,
 * `tool_call` started/completed pairs, and a final `result` carrying
 * `is_error`, the whole reply and real token usage, so this backend has both
 * tool-call visibility and usage data, like the Codex one.
 *
 * With `--stream-partial-output`, assistant text arrives as deltas AND is
 * repeated once as a consolidated message at the end of each segment (before a
 * tool call, and at the end of the turn). Those repeats are dropped by
 * comparing a message against the deltas accumulated since the last
 * consolidation (see `segment` below). The undocumented `timestamp_ms` field is
 * deliberately NOT used as the discriminator: consolidated messages sometimes
 * carry it too.
 *
 * `--trust` is mandatory, not a convenience: without it (or `--force`)
 * cursor-agent refuses to touch an untrusted directory, printing a plain-text
 * notice and exiting 0, with no JSON at all. We're driving it deliberately in the
 * session cwd, so the workspace is trusted by construction; a run that still
 * produces no `result` event is reported with the CLI's own text (which is also
 * how "not logged in" surfaces).
 *
 * Permission mapping is coarse, like agy's: print mode has all tools including
 * write and shell, and auto-approves them (there is no interactive prompt to
 * defer to), so `canUseTool` never comes into play. "bypassPermissions" passes
 * `--force` (run everything unless explicitly denied) plus `--approve-mcps` so
 * a user's Cursor MCP servers can't stall the turn on an approval nobody can
 * answer; every other mode gets `--sandbox enabled` as the best containment on
 * offer.
 */
export async function runTurn(opts: RunOptions): Promise<RunResult> {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--workspace",
    opts.cwd,
    "--trust",
  ];
  if (opts.permissionMode === "bypassPermissions") args.push("--force", "--approve-mcps");
  else args.push("--sandbox", "enabled");
  if (opts.resume) args.push("--resume", opts.resume);
  if (opts.model) args.push("--model", opts.model);
  // Terminate flag parsing with `--` and pass the prompt as the final
  // positional: a prompt starting with `-` (an ordinary "- bullet" message)
  // would otherwise be rejected as an unknown flag, and text matching a real
  // flag (e.g. `--force`) would be parsed as one: flag injection that drops
  // the sandbox, the only safety knob here.
  args.push("--", opts.prompt);

  interface CursorToolCall {
    args?: Record<string, unknown>;
    result?: Record<string, unknown>;
  }
  interface CursorEvent {
    type?: string;
    subtype?: string;
    session_id?: string;
    is_error?: boolean;
    result?: string;
    message?: { content?: Array<{ type?: string; text?: string }> };
    tool_call?: Record<string, CursorToolCall>;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  }

  const startedAt = Date.now();
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn("cursor-agent", args, {
      cwd: opts.cwd,
      signal: opts.abortController.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    let text = "";
    /** Deltas streamed since the last consolidated message, used to recognise
     *  (and drop) that consolidation instead of emitting the text twice. */
    let segment = "";
    let gotEnd = false;
    let isError = false;
    let tokens: TokenUsage | undefined;
    /** Non-JSON stdout lines: how the CLI reports a refusal (untrusted
     *  workspace, missing login) before it ever emits an event. */
    const noise: string[] = [];
    const stderr: string[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let evt: CursorEvent;
        try {
          evt = JSON.parse(line);
        } catch {
          noise.push(line);
          continue;
        }
        if (evt.type === "system" && evt.subtype === "init") {
          if (evt.session_id) opts.onSessionId(evt.session_id);
        } else if (evt.type === "assistant") {
          const chunkText = (evt.message?.content ?? [])
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text)
            .join("");
          if (!chunkText) continue;
          if (chunkText === segment) {
            // The consolidated repeat of what we already streamed as deltas.
            segment = "";
            continue;
          }
          text += chunkText;
          segment += chunkText;
          opts.onText(chunkText);
        } else if (evt.type === "tool_call") {
          const [name, call] = Object.entries(evt.tool_call ?? {})[0] ?? [];
          if (!name || !call) continue;
          if (evt.subtype === "started") {
            opts.onToolUse(toolLabel(name), call.args ?? {});
          } else if (evt.subtype === "completed") {
            // A completed call carries either a `success` or a `failure` body.
            opts.onToolResult?.(call.result ? !("success" in call.result) : false);
          }
        } else if (evt.type === "result") {
          gotEnd = true;
          isError = evt.is_error === true;
          // Only fall back to the result's own copy of the reply if nothing was
          // streamed (e.g. an error turn with no assistant message).
          if (!text && typeof evt.result === "string") text = evt.result;
          if (evt.usage) {
            tokens = {
              inputTokens: evt.usage.inputTokens ?? 0,
              outputTokens: evt.usage.outputTokens ?? 0,
              cacheReadTokens: evt.usage.cacheReadTokens ?? 0,
              cacheWriteTokens: evt.usage.cacheWriteTokens ?? 0,
            };
          }
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line) {
        stderr.push(line);
        log.debug("cursor-agent stderr", { line: line.slice(0, 500) });
      }
    });

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      if (!gotEnd) {
        // Includes the exit-0-with-a-plain-text-notice cases (untrusted
        // workspace, not signed in), so the user sees the actual reason.
        const tail = [...noise, ...stderr].slice(-8).join("\n");
        reject(new Error(`cursor-agent produced no result (exit ${code})${tail ? `: ${tail}` : ""}`));
        return;
      }
      if (code !== 0) {
        log.warn("cursor-agent exited non-zero after a completed turn, using the captured result", { code });
      }
      resolve({ isError, text, durationMs: Date.now() - startedAt, tokens });
    });
  });
}

/** "shellToolCall" -> "Shell", "editToolCall" -> "Edit". The event key is the
 *  only name the stream gives a tool call, so make it presentable. */
function toolLabel(key: string): string {
  const base = key.replace(/ToolCall$/, "");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * List the model ids the signed-in Cursor account can run (`cursor-agent
 * models` prints `<id> - <label>` lines, and `<id>` is what `--model` accepts).
 * Empty array when the CLI is missing or errors, so the panel's fetch button
 * degrades quietly.
 */
export async function listCursorModels(): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn("cursor-agent", ["models"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", () => resolve([]));
    child.on("close", (code) => {
      if (code !== 0) return resolve([]);
      resolve(
        out
          .split("\n")
          .map((l) => l.trim().match(/^([\w.-]+) {1,3}- /)?.[1])
          .filter((id): id is string => Boolean(id)),
      );
    });
  });
}
