import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import type { RunOptions, RunResult, TokenUsage } from "../claude/runner.js";
import { registerCliRun, type CliRunHandle } from "../core/cliBridge.js";
import { memory, formatMemoriesForPrompt } from "../core/memory.js";
import { log } from "../logger.js";
import { opencodeLaunch } from "./launch.js";
import { buildOpencodePrompt, markOpencodeSystemInjected } from "./prompt.js";
import { mapOpencodeTool } from "./toolMap.js";

/**
 * Drive one turn through OpenCode's `opencode` CLI, spawned as a subprocess —
 * the same "wrap the provider's own agentic CLI" approach used for `claude`
 * (src/claude/runner.ts), `grok`, `codex`, `agy` and `cursor-agent`. OpenCode's
 * own tool belt and permission model run inside the subprocess.
 *
 * `opencode run --format json` emits newline-delimited JSON events: `text`
 * (assistant reply, whole segment rather than token deltas), `tool_use` (a
 * completed or failed tool call, with real input/output), `step_start` /
 * `step_finish` (the latter carries token usage), and `error`. The resumable
 * `sessionID` is on every event. Resume with `--session <id>`.
 *
 * Three things the Claude backend gets for free are built around the CLI here
 * (src/opencode/launch.ts):
 * - **Our MCP tools** (memory, kanban, crew, connectors, send_file, …) are
 *   republished by a stdio MCP server that proxies back into this process
 *   (src/core/cliBridge.ts), registered via `OPENCODE_CONFIG_CONTENT`.
 * - **Approvals** for OpenCode's own tools come from a plugin
 *   (`tool.execute.before`) that calls the same bridge. OpenCode has no
 *   shell-command PreToolUse hook like codex/cursor.
 * - **The system prompt** (persona, work.md, known paths, crew, memories) is
 *   carried in the prompt text, since `run` has no flag for it
 *   (src/opencode/prompt.ts).
 *
 * Permissions: headless `run` auto-rejects any permission set to "ask", and
 * `--auto` would approve them without our gate. So when the plugin is in place
 * every tool is set to "allow" in our inline config and the plugin is the real
 * gate (it fails closed when the bot is unreachable). Without the launch env
 * the turn falls back to plain opencode.
 *
 * Still missing versus the Claude backend: external MCP connectors that run as
 * their own process/endpoint rather than in ours (Unreal, Unity, Browser
 * Sketchpad).
 */

interface OpencodeToolState {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  metadata?: { exit?: number; [k: string]: unknown };
}

interface OpencodePart {
  type?: string;
  tool?: string;
  callID?: string;
  text?: string;
  state?: OpencodeToolState;
  tokens?: {
    input?: number;
    output?: number;
    cache?: { read?: number; write?: number };
  };
  reason?: string;
}

interface OpencodeEvent {
  type?: string;
  sessionID?: string;
  part?: OpencodePart;
  error?: unknown;
}

/** OpenCode could not find the session we asked it to resume. */
function isMissingSession(output: string): boolean {
  return /session not found|unknown session|no such session/i.test(output);
}

export async function runTurn(opts: RunOptions): Promise<RunResult> {
  // Same recall the Claude backend does, honouring the per-agent "memory"
  // prompt-slimming exclusion (skip the store entirely, inject nothing).
  const recalled = opts.promptExclude?.includes("memory")
    ? []
    : await memory.recallForPromptAsync(opts.prompt);
  const memoryBlock = recalled.length ? formatMemoriesForPrompt(recalled) : undefined;
  const { prompt, systemHash } = buildOpencodePrompt(opts, memoryBlock);

  let bridge: CliRunHandle | undefined;
  let launch: Awaited<ReturnType<typeof opencodeLaunch>> | null = null;
  bridge = await registerCliRun({
    mcpServers: opts.mcpServers,
    permissionMode: opts.permissionMode,
    canUseTool: opts.canUseTool,
    onToolUse: opts.onToolUse,
    onToolResult: opts.onToolResult,
    mapTool: mapOpencodeTool,
    backend: "opencode",
    // OpenCode's json stream reports how every one of its tool calls ended, a
    // denied one included, so the bridge must not report those a second time.
    toolResultsFromStream: true,
  });
  launch = await opencodeLaunch({ url: bridge.url, token: bridge.token });
  if (!launch) {
    // No plugin / MCP helpers: drop the bridge so we do not leave a dead token
    // hanging, and run plain opencode without MyAgens tools or the gate.
    bridge.dispose();
    bridge = undefined;
  }

  const buildArgs = (resume: string | undefined): string[] => {
    const args = ["run", "--format", "json", "--dir", opts.cwd];
    // With the plugin gate in place, `--auto` is harmless (permission is already
    // "allow") and covers any OpenCode-internal ask the plugin does not see.
    // Without the gate, only bypassPermissions gets `--auto`; otherwise
    // OpenCode's default allow-all still runs tools freely, matching a bare
    // `opencode run`.
    if (launch || opts.permissionMode === "bypassPermissions") args.push("--auto");
    if (resume) args.push("--session", resume);
    if (opts.model) args.push("--model", opts.model);
    // Terminate flag parsing with `--` and pass the prompt as the final
    // positional: a prompt starting with `-` would otherwise be rejected as an
    // unknown flag, and text matching a real flag would be parsed as one.
    args.push("--", prompt);
    return args;
  };

  const startedAt = Date.now();

  const attempt = (resume: string | undefined): Promise<RunResult> =>
    new Promise<RunResult>((resolve, reject) => {
      const child = spawn("opencode", buildArgs(resume), {
        cwd: opts.cwd,
        signal: opts.abortController.signal,
        stdio: ["ignore", "pipe", "pipe"],
        // opts.env is deliberately ignored (opencode manages its own auth, like
        // the other CLI backends). Launch env carries OPENCODE_* and the bridge
        // coordinates the plugin and MCP child need.
        env: {
          ...process.env,
          ...(launch?.env ?? {}),
        },
      });

      let buffer = "";
      let text = "";
      let sessionId: string | undefined;
      let gotEnd = false;
      let isError = false;
      let tokens: TokenUsage | undefined;
      const stderr: string[] = [];
      /** Non-JSON stdout: banners and "session not found" style failures. */
      const plain: string[] = [];

      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let evt: OpencodeEvent;
          try {
            evt = JSON.parse(line);
          } catch {
            plain.push(line);
            continue;
          }

          if (evt.sessionID && !sessionId) {
            sessionId = evt.sessionID;
            opts.onSessionId(evt.sessionID);
          }

          if (evt.type === "text") {
            const chunkText = evt.part?.text ?? "";
            if (!chunkText) continue;
            text += chunkText;
            opts.onText(chunkText);
          } else if (evt.type === "tool_use") {
            const part = evt.part;
            const tool = part?.tool ?? "";
            const state = part?.state;
            if (!tool || !state) continue;
            // MCP calls are answered by the bridge itself (onToolUse + result),
            // so the stream must not double-count them when the bridge is live.
            const isMcp = tool.startsWith("myagens_") || tool.startsWith("mcp__");
            if (bridge && isMcp) continue;
            // With the bridge the plugin already announced (and gated) native
            // tools; announcing them again would double them in the chat.
            if (!bridge && (state.status === "completed" || state.status === "error")) {
              opts.onToolUse(toolLabel(tool), state.input ?? {});
            }
            if (state.status === "completed" || state.status === "error") {
              const failed =
                state.status === "error" ||
                (typeof state.metadata?.exit === "number" && state.metadata.exit !== 0);
              opts.onToolResult?.(failed);
            }
          } else if (evt.type === "step_finish") {
            // A turn can span several steps (tool call, then final answer). Sum
            // tokens across them; the last step_finish with reason "stop" is
            // still just one step's usage.
            const t = evt.part?.tokens;
            if (t) {
              tokens = {
                inputTokens: (tokens?.inputTokens ?? 0) + (t.input ?? 0),
                outputTokens: (tokens?.outputTokens ?? 0) + (t.output ?? 0),
                cacheReadTokens: (tokens?.cacheReadTokens ?? 0) + (t.cache?.read ?? 0),
                cacheWriteTokens: (tokens?.cacheWriteTokens ?? 0) + (t.cache?.write ?? 0),
              };
            }
            if (evt.part?.reason === "stop") gotEnd = true;
          } else if (evt.type === "error") {
            isError = true;
            gotEnd = true;
            const msg =
              typeof evt.error === "string"
                ? evt.error
                : evt.error && typeof evt.error === "object" && "message" in evt.error
                  ? String((evt.error as { message?: unknown }).message ?? evt.error)
                  : JSON.stringify(evt.error ?? "unknown error");
            if (msg && !text) text = msg;
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const line = chunk.toString("utf8").trim();
        if (line) {
          stderr.push(line);
          log.debug("opencode stderr", { line: line.slice(0, 500) });
        }
      });

      child.on("error", (err) => reject(err));

      child.on("close", (code) => {
        // A clean stop with only tool steps and no final "stop" reason still
        // counts as finished if we saw any step_finish (e.g. the model ended
        // after a tool with no trailing text). Treat exit 0 + any progress as ok.
        if (!gotEnd && code === 0 && (text || tokens || sessionId)) gotEnd = true;

        if (!gotEnd) {
          const output = [...plain, ...stderr].join("\n");
          if (resume && isMissingSession(output)) {
            reject(new MissingSessionError());
            return;
          }
          const tail = [...plain, ...stderr].slice(-8).join("\n");
          reject(new Error(`opencode exited with code ${code}${tail ? ` — ${tail}` : ""}`));
          return;
        }
        if (code !== 0) {
          log.warn("opencode exited non-zero after a completed turn, using the captured result", { code });
        }
        if (sessionId) markOpencodeSystemInjected(sessionId, systemHash);
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
    try {
      return await attempt(opts.resume);
    } catch (err) {
      if (!(err instanceof MissingSessionError)) throw err;
      log.info("opencode: stored session could not be resumed — starting a fresh one", {
        session: opts.resume,
      });
      return await attempt(undefined);
    }
  } finally {
    bridge?.dispose();
    if (launch?.bridgeFile) await rm(launch.bridgeFile, { force: true }).catch(() => {});
  }
}

/** "bash" -> "Bash", "myagens_mcp__x" -> "Myagens_mcp__x". */
function toolLabel(name: string): string {
  if (!name) return "Tool";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Internal signal: the resume id is unusable, retry the turn without it. */
class MissingSessionError extends Error {
  constructor() {
    super("opencode: no such session");
  }
}

/**
 * List the model ids the installed OpenCode CLI can run (`opencode models`
 * prints `provider/model` lines, which is what `--model` accepts). Empty array
 * when the CLI is missing or errors, so the panel's fetch button degrades
 * quietly.
 */
export async function listOpencodeModels(): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn("opencode", ["models"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", () => resolve([]));
    child.on("close", (code) => {
      if (code !== 0) return resolve([]);
      resolve(
        out
          .split("\n")
          .map((l) => l.trim())
          // provider/model, including scoped providers like opencode-go/…
          .filter((id) => /^[\w.-]+\/[\w./:-]+$/.test(id)),
      );
    });
  });
}
