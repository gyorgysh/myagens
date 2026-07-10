import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import type { RunOptions, RunResult, TokenUsage } from "../claude/runner.js";
import { log } from "../logger.js";

/**
 * Drive one turn as plain chat against a local Ollama server's /api/chat,
 * NOT by wrapping an agentic CLI the way src/claude, src/grok, and src/codex
 * do. The reason it exists: small local models (14-24B) cannot prefill the
 * Claude CLI's ~30k-token system prompt in usable time, so this backend hands
 * Ollama a tiny hand-built system prompt (<2k tokens) and reimplements the
 * bare minimum of a tool loop (exactly one Bash tool) itself. That keeps a
 * local model responsive and fully Anthropic-independent.
 *
 * Ollama has no server-side sessions, so conversation history is persisted per
 * session id as JSON under data/ollama-sessions/. Models without function
 * calling degrade to plain chat automatically (tool-less fallback).
 */

/** A stored history entry (only user/assistant text, no tool traffic). */
interface StoredMsg {
  role: "user" | "assistant";
  content: string;
}

/** One tool call as Ollama returns it on message.tool_calls. */
interface OllamaToolCall {
  function?: { name?: string; arguments?: Record<string, unknown> };
}

/** A message in the /api/chat wire format. */
interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Raw base64 image strings (Ollama's multimodal wire format). */
  images?: string[];
  tool_calls?: OllamaToolCall[];
  /** Name of the tool a role:"tool" result answers. */
  tool_name?: string;
}

/** One streamed /api/chat event (NDJSON line). */
interface OllamaChatEvent {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
  error?: string;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** What one streaming round of the chat loop collected. */
interface RoundResult {
  content: string;
  toolCalls: OllamaToolCall[];
  tokens: TokenUsage;
}

/** The single tool we expose, described for Ollama's function-calling API. */
const BASH_TOOL = {
  type: "function",
  function: {
    name: "Bash",
    description:
      "Run a shell command on the host machine in the working directory. Returns combined stdout+stderr (truncated). One command per call.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
      },
      required: ["command"],
    },
  },
};

const MAX_ROUNDS = 8;
const STORED_CAP = 200;
const REPLAY_MSGS = 24;
const REPLAY_CHARS = 16_000;
const OUTPUT_CAP = 4000;
const BASH_TIMEOUT_MS = 180_000;

/** Build the tiny hand-built system prompt. Deliberately does NOT import
 *  src/prompt.ts (that produces the heavy CLI preset a small model can't
 *  prefill). `toolless` switches the wording for models with no tool support. */
function buildSystem(opts: RunOptions, toolless: boolean): string {
  const parts: string[] = [];
  if (opts.workerIdentity) parts.push(opts.workerIdentity);
  // Honour a per-agent "persona" prompt-slimming exclusion here too (this backend
  // builds its own tiny prompt and already ignores work.md/knownPaths/memory).
  if (opts.persona && !opts.promptExclude?.includes("persona")) {
    parts.push(`# Personality\n${opts.persona}`);
  }
  if (opts.systemPromptAppend) parts.push(opts.systemPromptAppend);

  const runtime = [
    "# Runtime environment (overrides everything above)",
    `You are running locally on this host through Ollama. ${
      toolless
        ? "You have NO tools available in this mode."
        : "You have exactly ONE tool available: Bash."
    }`,
    "The crew and MCP tools mentioned above (crew_report, crew_suggest, memory_*, task_*, skill_*) DO NOT exist here. Ignore any instructions above about calling them and answer in plain text instead.",
    toolless
      ? "There is no tool-call mechanism in this mode: never emit JSON tool-call syntax and never pretend to run commands. Answer directly in plain text."
      : "Use the Bash tool only when a task genuinely needs to read a file or run a command. If a command fails twice, stop retrying and report what happened. After using a tool, always finish with a plain-text summary for the user.",
  ];
  parts.push(runtime.join("\n"));

  if (opts.language) {
    parts.push(`Always respond in the language with BCP 47 tag "${opts.language}".`);
  }
  return parts.join("\n\n");
}

/** Take at most the last REPLAY_MSGS stored messages and at most ~REPLAY_CHARS
 *  characters (walking backwards, always keeping the newest one) so prefill on
 *  a small local model stays fast. */
function windowHistory(msgs: StoredMsg[]): StoredMsg[] {
  const out: StoredMsg[] = [];
  let chars = 0;
  for (let i = msgs.length - 1; i >= 0 && out.length < REPLAY_MSGS; i--) {
    const m = msgs[i];
    if (out.length > 0 && chars + m.content.length > REPLAY_CHARS) break;
    out.unshift(m);
    chars += m.content.length;
  }
  return out;
}

/** Load stored history tolerantly; a missing or corrupt file is just empty. */
async function loadHistory(file: string): Promise<StoredMsg[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is StoredMsg =>
        m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    );
  } catch {
    return []; // missing / corrupt / unparseable => start fresh
  }
}

/** POST one streaming /api/chat request and fold its NDJSON stream out to
 *  `onText`, collecting tool calls and token counts. Throws on a non-ok
 *  response or an `error` event so the caller can decide about fallbacks. */
async function streamChat(
  baseUrl: string,
  model: string,
  messages: OllamaMessage[],
  withTools: boolean,
  numCtx: number,
  keepAlive: string,
  opts: RunOptions,
): Promise<RoundResult> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...(withTools ? { tools: [BASH_TOOL] } : {}),
      keep_alive: keepAlive,
      options: { num_ctx: numCtx },
    }),
    signal: opts.abortController.signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Ollama /api/chat failed (HTTP ${res.status}): ${body.slice(0, 300)} ` +
        "(is `ollama serve` running and the model pulled?)",
    );
  }

  let buffer = "";
  let content = "";
  const toolCalls: OllamaToolCall[] = [];
  const tokens: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const decoder = new TextDecoder();

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let evt: OllamaChatEvent;
      try {
        evt = JSON.parse(line);
      } catch {
        continue; // skip a malformed / partial line
      }
      if (evt.error) throw new Error(`Ollama error: ${evt.error}`);
      const delta = evt.message?.content;
      if (delta) {
        content += delta;
        opts.onText(delta);
      }
      if (evt.message?.tool_calls?.length) toolCalls.push(...evt.message.tool_calls);
      if (evt.done) {
        tokens.inputTokens += evt.prompt_eval_count ?? 0;
        tokens.outputTokens += evt.eval_count ?? 0;
      }
    }
  }
  return { content, toolCalls, tokens };
}

/** Run one shell command for a Bash tool call. Never rejects: resolves with the
 *  captured output and an error flag instead. Wall-clock capped at 180s (an
 *  image-gen or build script can legitimately take a minute or more) then
 *  SIGKILL, output truncated to OUTPUT_CAP chars. */
function runBash(command: string, opts: RunOptions): Promise<{ out: string; isError: boolean }> {
  return new Promise((resolve) => {
    const child =
      process.platform === "win32"
        ? spawn("powershell.exe", ["-NoProfile", "-Command", command], {
            cwd: opts.cwd,
            signal: opts.abortController.signal,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn("bash", ["-lc", command], {
            cwd: opts.cwd,
            signal: opts.abortController.signal,
            stdio: ["ignore", "pipe", "pipe"],
          });

    const chunks: string[] = [];
    let len = 0;
    const push = (s: string) => {
      if (len < OUTPUT_CAP) {
        chunks.push(s);
        len += s.length;
      }
    };
    child.stdout.on("data", (c: Buffer) => push(c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => push(c.toString("utf8")));

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, BASH_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        out: `(failed to run command: ${err instanceof Error ? err.message : String(err)})`,
        isError: true,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let out = chunks.join("").slice(0, OUTPUT_CAP);
      if (killed) {
        resolve({ out: `${out}\n(killed after ${BASH_TIMEOUT_MS / 1000}s timeout)`, isError: true });
        return;
      }
      out += `\n(exit code ${code ?? 0})`;
      resolve({ out, isError: code !== 0 });
    });
  });
}

export async function runTurn(opts: RunOptions): Promise<RunResult> {
  const baseUrl = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");
  // Config comes from env, NOT from opts.env: a configured cloud chat provider
  // sets ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN in opts.env, and honouring that
  // here would silently redirect this "local Ollama" backend off-host. We
  // deliberately ignore opts.env entirely.
  const model = opts.model?.trim() || process.env.OLLAMA_MODEL?.trim();
  if (!model) {
    throw new Error(
      "No Ollama model configured. Set this agent's model to an installed Ollama " +
        "model name (see `ollama list`, e.g. \"llama3.1:8b\") or set OLLAMA_MODEL in .env.",
    );
  }
  // Custom Modelfiles can bake in 32k+ contexts whose KV cache swap-thrashes a
  // 24GB host sitting next to a large model, so clamp num_ctx to a sane default.
  const numCtx = Number(process.env.OLLAMA_NUM_CTX) || 8192;
  // Keep the model resident between turns so the next prompt doesn't pay a reload.
  const keepAlive = process.env.OLLAMA_KEEP_ALIVE || "30m";

  // Reuse opts.resume as the session id when it's a safe path segment; a UUID
  // inherited from another backend still matches /^[\w-]+$/ and just resolves
  // to a not-yet-existing history file (i.e. an empty history), which is fine.
  const sessionId = opts.resume && /^[\w-]+$/.test(opts.resume) ? opts.resume : randomUUID();
  opts.onSessionId(sessionId);

  const dir = join(dirname(config.STATE_FILE), "ollama-sessions");
  const file = join(dir, `${sessionId}.json`);
  let history = await loadHistory(file);

  const startedAt = Date.now();
  let toolless = false;
  let warnedToolless = false;

  const userMsg: OllamaMessage = { role: "user", content: opts.prompt };
  if (opts.images?.length) userMsg.images = opts.images.map((im) => im.base64);

  const messages: OllamaMessage[] = [
    { role: "system", content: buildSystem(opts, toolless) },
    ...windowHistory(history).map((m): OllamaMessage => ({ role: m.role, content: m.content })),
    userMsg,
  ];

  const collected: string[] = [];
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const tokens: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // On the last permitted round, call WITHOUT tools so the model is forced to
    // answer in plain text rather than looping on another tool call forever.
    const withTools = !toolless && round < MAX_ROUNDS;

    let result: RoundResult;
    try {
      result = await streamChat(baseUrl, model, messages, withTools, numCtx, keepAlive, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Tool-less fallback: a model with no function calling rejects the request
      // with a body mentioning "tools". Drop to plain chat and stay there.
      if (withTools && /tool/i.test(msg)) {
        if (!warnedToolless) {
          log.warn("ollama backend: model rejected tools, falling back to plain chat", { model });
          warnedToolless = true;
        }
        toolless = true;
        messages[0] = { role: "system", content: buildSystem(opts, true) };
        round--; // retry this same round without tools
        continue;
      }
      throw err;
    }

    tokens.inputTokens += result.tokens.inputTokens;
    tokens.outputTokens += result.tokens.outputTokens;
    if (result.content) collected.push(result.content);

    // No tools offered this round, or the model chose not to call one => done.
    if (!withTools || result.toolCalls.length === 0) break;

    // Record the assistant's tool-call turn so the model keeps its own context.
    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });

    for (const call of result.toolCalls) {
      const name = call.function?.name ?? "";
      const input: Record<string, unknown> = call.function?.arguments ?? {};
      // onToolUse feeds the fleet's loop detector; record for RunResult too.
      opts.onToolUse(name, input);
      toolCalls.push({ name, input });

      if (name !== "Bash" || typeof input.command !== "string") {
        messages.push({
          role: "tool",
          tool_name: name || "Bash",
          content: 'Error: the only available tool is "Bash" and it needs a string "command" argument.',
        });
        continue;
      }

      const decision = await opts.canUseTool("Bash", input);
      if (decision.behavior === "deny") {
        messages.push({ role: "tool", tool_name: "Bash", content: `Denied: ${decision.message}` });
        continue;
      }
      const command =
        typeof decision.updatedInput?.command === "string"
          ? (decision.updatedInput.command as string)
          : input.command;

      const { out, isError } = await runBash(command, opts);
      opts.onToolResult?.(isError);
      messages.push({ role: "tool", tool_name: "Bash", content: out });
    }
  }

  const finalText = collected.join("\n");

  // Persist the turn. Cap the stored log; a failed write is only a nicety lost.
  history.push({ role: "user", content: opts.prompt }, { role: "assistant", content: finalText });
  if (history.length > STORED_CAP) history = history.slice(-STORED_CAP);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(history), "utf8");
  } catch (err) {
    log.warn("ollama backend: failed to persist session history", {
      file,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    isError: false,
    text: finalText,
    costUsd: 0,
    durationMs: Date.now() - startedAt,
    tokens,
    toolCalls,
  };
}
