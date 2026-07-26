import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import type { RunOptions, RunResult, TokenUsage } from "../claude/runner.js";
import { registerCliRun, type CliRunHandle } from "../core/cliBridge.js";
import { memory, formatMemoriesForPrompt } from "../core/memory.js";
import { log } from "../logger.js";
import { codexLaunch, writeBridgeFile, HOOK_TRUST_FLAG, MCP_BRIDGE_SCRIPT } from "./codexHome.js";
import { buildCodexPrompt, markCodexSystemInjected } from "./prompt.js";
import { mapCodexTool } from "./toolMap.js";

/**
 * Drive one turn through OpenAI's `codex` CLI, spawned as a subprocess — the
 * same "wrap the provider's own agentic CLI" approach used for `claude`
 * (src/claude/runner.ts), `grok`, `agy` and `cursor-agent`. Codex's own tool
 * belt and sandboxing run inside the subprocess.
 *
 * `codex exec --json` emits newline-delimited JSON events: `thread.started`
 * (carries the resumable session id), `item.started`/`item.completed` (a
 * `command_execution` item is a shell call, with a real exit code, or an
 * `agent_message` item is the response text, delivered whole rather than as
 * incremental deltas), and `turn.completed` (carries real token usage). `codex
 * exec resume <threadId>` continues a session; unlike the first invocation it
 * takes no `--cd`/`--sandbox` — those are fixed from the original session.
 *
 * Three things the Claude backend gets for free are built around the CLI here,
 * all hanging off the private CODEX_HOME in src/codex/codexHome.ts:
 * - **Our MCP tools** (memory, kanban, crew, connectors, send_file, …) are
 *   republished to the CLI by a stdio MCP server that proxies back into this
 *   process (src/core/cliBridge.ts). Registration is pure `-c` flags, no file.
 * - **Approvals** for codex's own tools come from a PreToolUse hook calling the
 *   same bridge, so risky calls still reach the user's Approve/Deny buttons.
 * - **The system prompt** (persona, work.md, known paths, crew, memories) is
 *   carried in the prompt text, since `exec` has no flag for it
 *   (src/codex/prompt.ts).
 *
 * Permissions: `exec` is headless, so there is no interactive approval to defer
 * to and the sandbox tier is codex's only native safety knob. That is kept —
 * "bypassPermissions" drops the sandbox, everything else runs in
 * `workspace-write` — with the hook gate layered on top, which is what makes an
 * approval prompt possible at all. Without the private home the gate does not
 * exist, so the turn falls back to plain codex (no MyAgens tools either).
 *
 * Tool status and results come from two channels on purpose: the hook announces
 * and gates a call before it runs, and the `--json` stream reports how a shell
 * call ended, since the PostToolUse payload carries the output but no exit code.
 * A denied call never reaches the stream at all, so the two never double-count.
 *
 * Still missing versus the Claude backend: external MCP connectors that run as
 * their own process/endpoint rather than in ours (Unreal, Unity, Browser
 * Sketchpad).
 */

/** Quote a value for a `-c key=value` TOML override. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Codex could not find the thread we asked it to resume. */
function isMissingThread(output: string): boolean {
  return /no rollout found|thread\/resume failed/i.test(output);
}

interface CodexItem {
  type?: string;
  text?: string;
  command?: string;
  exit_code?: number | null;
}
interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
  };
}

export async function runTurn(opts: RunOptions): Promise<RunResult> {
  // Same recall the Claude backend does, honouring the per-agent "memory"
  // prompt-slimming exclusion (skip the store entirely, inject nothing).
  const recalled = opts.promptExclude?.includes("memory")
    ? []
    : await memory.recallForPromptAsync(opts.prompt);
  const memoryBlock = recalled.length ? formatMemoriesForPrompt(recalled) : undefined;
  const { prompt, systemHash } = buildCodexPrompt(opts, memoryBlock);

  // The private home and the hook-trust bypass flag are produced together and
  // used together: our hooks.json is silently ignored without that flag, which
  // would leave every tool running ungated.
  let launch = await codexLaunch();
  if (launch && !launch.args.includes(HOOK_TRUST_FLAG)) {
    // Belt and braces for the one mistake that fails OPEN rather than closed:
    // the private home's hooks.json is silently ignored without that flag, and
    // codex reports nothing when it skips an untrusted hook. Rather than run
    // every tool ungated, drop back to the user's own codex setup.
    log.error("codex backend: hook-trust bypass missing — refusing to run with a hook codex would ignore");
    launch = null;
  }
  let bridge: CliRunHandle | undefined;
  let bridgeFile: string | null = null;
  if (launch) {
    bridge = await registerCliRun({
      mcpServers: opts.mcpServers,
      permissionMode: opts.permissionMode,
      canUseTool: opts.canUseTool,
      onToolUse: opts.onToolUse,
      onToolResult: opts.onToolResult,
      mapTool: mapCodexTool,
      backend: "codex",
    });
    bridgeFile = await writeBridgeFile(bridge.url, bridge.token);
  }

  const buildArgs = (resume: string | undefined): string[] => {
    const args = ["exec"];
    if (resume) args.push("resume", resume);
    args.push("--json", "--skip-git-repo-check");
    if (launch) args.push(...launch.args);
    if (!resume) {
      args.push("--cd", opts.cwd);
      if (opts.permissionMode === "bypassPermissions") {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      } else {
        args.push("--sandbox", "workspace-write");
      }
    }
    if (bridgeFile) {
      // Registered per invocation; codex needs no MCP config file. The
      // `approve` mode is mandatory: headless exec auto-cancels the MCP
      // elicitation round trip otherwise, and every call fails as "user
      // cancelled". PreToolUse still fires, so the gate is unaffected.
      const cfg = (key: string, value: string) => args.push("-c", `mcp_servers.myagens.${key}=${value}`);
      cfg("command", tomlString(process.execPath));
      cfg("args", `[${tomlString(MCP_BRIDGE_SCRIPT)}]`);
      // Codex does not pass its own env to MCP children, so the coordinates
      // travel in an explicit env map — the file path, never the token itself,
      // since `-c` values end up in the command line.
      cfg("env", `{MYAGENS_BRIDGE_FILE=${tomlString(bridgeFile)}}`);
      cfg("default_tools_approval_mode", tomlString("approve"));
      cfg("startup_timeout_sec", "30");
      // A tool call can block on the user's Approve/Deny answer, so this has to
      // outlast an approval prompt rather than the usual few seconds.
      cfg("tool_timeout_sec", "900");
    }
    if (opts.model) args.push("--model", opts.model);
    // Terminate flag parsing with `--` and pass the prompt as the final
    // positional. Codex is a clap CLI: without this, a prompt beginning with
    // `-` (an ordinary "- bullet" message) is rejected as an unknown flag, and
    // text that matches a real flag (e.g.
    // `--dangerously-bypass-approvals-and-sandbox`) would be parsed as one.
    args.push("--", prompt);
    return args;
  };

  const startedAt = Date.now();

  const attempt = (resume: string | undefined): Promise<RunResult> =>
    new Promise<RunResult>((resolve, reject) => {
      const child = spawn("codex", buildArgs(resume), {
        cwd: opts.cwd,
        signal: opts.abortController.signal,
        // stdin ignored (not piped): `codex exec` reads stdin as extra context
        // when it's available at all, and blocks waiting for EOF if left open.
        stdio: ["ignore", "pipe", "pipe"],
        // opts.env is deliberately ignored (codex manages its own auth, like
        // the other CLI backends). CODEX_HOME points at our private home, and
        // the bridge coordinates are picked up from here by the hook — which,
        // unlike an MCP child, does inherit this environment.
        env: {
          ...process.env,
          ...(launch ? { CODEX_HOME: launch.home } : {}),
          ...(bridge ? { MYAGENS_BRIDGE_URL: bridge.url, MYAGENS_BRIDGE_TOKEN: bridge.token } : {}),
        },
      });

      let buffer = "";
      let text = "";
      let gotEnd = false;
      let threadId: string | undefined;
      let tokens: TokenUsage | undefined;
      const stderr: string[] = [];
      /** Non-JSON output, which is where codex reports a failed resume. */
      const plain: string[] = [];

      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let evt: CodexEvent;
          try {
            evt = JSON.parse(line);
          } catch {
            plain.push(line); // banners, and the "no rollout found" resume error
            continue;
          }
          if (evt.type === "thread.started" && evt.thread_id) {
            threadId = evt.thread_id;
            opts.onSessionId(evt.thread_id);
          } else if (evt.type === "item.started" && evt.item?.type === "command_execution") {
            // With the bridge in place the PreToolUse hook has already
            // announced (and gated) this call; announcing it again would
            // double it in the chat.
            if (!bridge) opts.onToolUse("Bash", { command: evt.item.command });
          } else if (evt.type === "item.completed") {
            const item = evt.item;
            if (item?.type === "command_execution") {
              // The only place a shell call's exit code appears: the hook's
              // PostToolUse payload carries the output but no status.
              opts.onToolResult?.(typeof item.exit_code === "number" && item.exit_code !== 0);
            } else if (item?.type === "agent_message" && typeof item.text === "string") {
              text += item.text;
              opts.onText(item.text);
            }
          } else if (evt.type === "turn.completed") {
            gotEnd = true;
            if (evt.usage) {
              tokens = {
                inputTokens: evt.usage.input_tokens ?? 0,
                outputTokens: evt.usage.output_tokens ?? 0,
                cacheReadTokens: evt.usage.cached_input_tokens ?? 0,
                cacheWriteTokens: evt.usage.cache_write_input_tokens ?? 0,
              };
            }
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const line = chunk.toString("utf8").trim();
        if (line) {
          stderr.push(line);
          log.debug("codex stderr", { line: line.slice(0, 500) });
        }
      });

      child.on("error", (err) => reject(err));

      child.on("close", (code) => {
        if (!gotEnd) {
          const output = [...plain, ...stderr].join("\n");
          if (resume && isMissingThread(output)) {
            // Our sessions live in the private CODEX_HOME, so a thread id
            // recorded against another home (or since pruned) cannot be
            // resumed. Signal the caller to start a fresh thread instead.
            reject(new MissingThreadError());
            return;
          }
          const tail = stderr.slice(-8).join("\n");
          reject(new Error(`codex exited with code ${code}${tail ? ` — ${tail}` : ""}`));
          return;
        }
        if (code !== 0) {
          log.warn("codex exited non-zero after a successful turn — using the captured result", { code });
        }
        // Record that this thread now carries the system block, so the next
        // turn on it only sends the volatile part.
        if (threadId) markCodexSystemInjected(threadId, systemHash);
        resolve({
          isError: false,
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
      if (!(err instanceof MissingThreadError)) throw err;
      log.info("codex: stored thread could not be resumed — starting a fresh one", { thread: opts.resume });
      return await attempt(undefined);
    }
  } finally {
    bridge?.dispose();
    if (bridgeFile) await rm(bridgeFile, { force: true }).catch(() => {});
  }
}

/** Internal signal: the resume id is unusable, retry the turn without it. */
class MissingThreadError extends Error {
  constructor() {
    super("codex: no such thread");
  }
}
