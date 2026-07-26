import { spawn } from "node:child_process";
import type { RunOptions, RunResult, TokenUsage } from "../claude/runner.js";
import { registerCliRun, type CliRunHandle } from "../core/cliBridge.js";
import { memory, formatMemoriesForPrompt } from "../core/memory.js";
import { log } from "../logger.js";
import { installCursorConfig, type CursorConfigHandle } from "./customization.js";
import { buildCursorPrompt, markCursorSystemInjected } from "./prompt.js";
import { mapCursorTool } from "./toolMap.js";

/**
 * Drive one turn through Cursor's `cursor-agent` CLI, spawned as a subprocess,
 * the same "wrap the provider's own agentic CLI" approach used for `claude`
 * (src/claude/runner.ts), `grok`, `codex` and `agy`. Cursor's own tool belt
 * (file edits, shell, search) and sandboxing run inside the subprocess.
 *
 * Three things the Claude backend gets for free are built around the CLI here,
 * all hanging off the project config in src/cursor/customization.ts:
 * - **Our MCP tools** (memory, kanban, crew, connectors, send_file, …) are
 *   republished to the CLI by a stdio MCP server that proxies back into this
 *   process (src/core/cliBridge.ts).
 * - **Approvals** for cursor's own tools come from a `preToolUse` hook calling
 *   the same bridge, so risky calls still reach the user's Approve/Deny buttons.
 * - **The system prompt** (persona, work.md, known paths, crew, memories) is
 *   carried in the prompt text, since the CLI has no flag for it
 *   (src/cursor/prompt.ts).
 *
 * That config has to live in `<cwd>/.cursor/`, the user's own project directory
 * (cursor loads it from nowhere else), so it is installed for the turn and
 * restored afterwards, and an agent can opt out of the whole arrangement with
 * `cursorTools: false` — see customization.ts for how the project is kept safe.
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
 * Permissions: `--force --approve-mcps` is passed at EVERY autonomy level once
 * the hook gate is in place, which looks alarming and is not. Below `--force`,
 * cursor's own decision provider silently auto-rejects every MCP tool call
 * ("User rejected MCP: …") no matter what our hook returns, so the MyAgens
 * tools would be advertised and unusable; and print mode auto-approves shell
 * and file writes anyway, so `--sandbox enabled` was never gating those in a
 * way the hook does not gate better. The `preToolUse` hook is the real gate,
 * and it fails closed when the bot is unreachable. Without the project config
 * (it could not be written, or the agent opted out) there is no gate, so the
 * old mapping stands: `--force` only for bypassPermissions, `--sandbox enabled`
 * otherwise.
 */
export async function runTurn(opts: RunOptions): Promise<RunResult> {
  // Same recall the Claude backend does, honouring the per-agent "memory"
  // prompt-slimming exclusion (skip the store entirely, inject nothing).
  const recalled = opts.promptExclude?.includes("memory")
    ? []
    : await memory.recallForPromptAsync(opts.prompt);
  const memoryBlock = recalled.length ? formatMemoriesForPrompt(recalled) : undefined;
  const { prompt, systemHash } = buildCursorPrompt(opts, memoryBlock);

  // Default-on: only an explicit false opts out (see RunOptions.cursorTools).
  // The bridge comes first because the project config has to name it, and it is
  // torn down again if the config can't be installed: the MyAgens tools are
  // unreachable without it, and the gate would not exist.
  let project: CursorConfigHandle | null = null;
  let bridge: CliRunHandle | undefined;
  if (opts.cursorTools !== false) {
    bridge = await registerCliRun({
      mcpServers: opts.mcpServers,
      permissionMode: opts.permissionMode,
      canUseTool: opts.canUseTool,
      onToolUse: opts.onToolUse,
      onToolResult: opts.onToolResult,
      mapTool: mapCursorTool,
      backend: "cursor",
      // Cursor's own stream reports how every one of its tool calls ended, a
      // denied one included, so the bridge must not report those a second time.
      toolResultsFromStream: true,
    });
    project = await installCursorConfig(opts.cwd, { url: bridge.url, token: bridge.token });
    if (!project) {
      bridge.dispose();
      bridge = undefined;
    }
  }

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--workspace",
    opts.cwd,
    "--trust",
  ];
  if (bridge || opts.permissionMode === "bypassPermissions") args.push("--force", "--approve-mcps");
  else args.push("--sandbox", "enabled");
  if (opts.resume) args.push("--resume", opts.resume);
  if (opts.model) args.push("--model", opts.model);
  // Terminate flag parsing with `--` and pass the prompt as the final
  // positional: a prompt starting with `-` (an ordinary "- bullet" message)
  // would otherwise be rejected as an unknown flag, and text matching a real
  // flag (e.g. `--force`) would be parsed as one: flag injection that drops
  // the sandbox, the only safety knob here.
  args.push("--", prompt);

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
  const run = new Promise<RunResult>((resolve, reject) => {
    const child = spawn("cursor-agent", args, {
      cwd: opts.cwd,
      signal: opts.abortController.signal,
      stdio: ["ignore", "pipe", "pipe"],
      // opts.env is deliberately ignored (cursor manages its own auth, like the
      // other CLI backends); the bridge coordinates are added so the MCP server
      // and hooks cursor spawns can call back into this turn.
      env: {
        ...process.env,
        ...(bridge ? { MYAGENS_BRIDGE_URL: bridge.url, MYAGENS_BRIDGE_TOKEN: bridge.token } : {}),
      },
    });

    let buffer = "";
    let text = "";
    let sessionId: string | undefined;
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
          if (evt.session_id) {
            sessionId = evt.session_id;
            opts.onSessionId(evt.session_id);
          }
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
            // With the bridge in place the preToolUse hook has already announced
            // (and gated) this call under its canonical name; announcing it again
            // would double it in the chat.
            if (!bridge) opts.onToolUse(toolLabel(name), call.args ?? {});
          } else if (evt.subtype === "completed") {
            // A completed call carries either a `success` or a `failure` body.
            // This is the only place a result appears: cursor's postToolUse
            // payload has the tool's output but no success/failure signal, so
            // the hook deliberately reports nothing. MCP calls are skipped
            // because the bridge already reported their result itself.
            if (bridge && /^mcp/i.test(name)) continue;
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
      // Record that this session now carries the system block, so the next turn
      // on it only sends the volatile part.
      if (sessionId) markCursorSystemInjected(sessionId, systemHash);
      resolve({
        isError,
        text,
        durationMs: Date.now() - startedAt,
        tokens,
        toolCalls: bridge?.toolCalls ?? [],
      });
    });
  });

  try {
    return await run;
  } finally {
    bridge?.dispose();
    // Puts the project's own .cursor/ files back; the last agent running cursor
    // in this directory is the one that actually restores them.
    await project?.dispose();
  }
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
