import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { config, normalizeModelId } from "../config.js";
import { systemPrompt } from "../prompt.js";
import { memory, formatMemoriesForPrompt } from "../core/memory.js";
import { activityBegin, activityEnd } from "../core/activity.js";
import { log } from "../logger.js";
import {
  isAssistant,
  isResult,
  isStreamEvent,
  isSystemInit,
  isUser,
  hasToolError,
  textDelta,
  type SdkMessage,
} from "./events.js";

/** Tools that are read-only and safe to run without asking the user. */
export const AUTO_ALLOWED_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "NotebookRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  // Our own Telegram file-sender is a deliberate user-facing action; allow it.
  "mcp__telegram__send_file",
  // Durable memory: reading/writing facts is safe and should be frictionless.
  "mcp__memory__memory_write",
  "mcp__memory__memory_search",
  "mcp__memory__memory_list",
  // Kanban board edits are safe, user-facing actions.
  "mcp__tasks__task_create",
  "mcp__tasks__task_list",
  "mcp__tasks__task_search",
  "mcp__tasks__task_update",
  // Saving/refining reusable skills is a safe, user-facing action.
  "mcp__skills__skill_save",
  "mcp__skills__skill_patch",
  "mcp__skills__skill_list",
  "mcp__skills__skill_search",
  // Filing a suggestion just queues it in the president's inbox for triage
  // (no DM, no sub-run), so it's safe and frictionless like a Kanban edit.
  "mcp__crew__crew_suggest",
  // Shipping own source edits: only queues a build-gated, deferred restart and
  // is announced to the user, so it's safe to run without a prompt.
  "mcp__self_update__self_update",
]);

export type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** A decoded image to hand to the model inline (vision), not just as a path. */
export interface ImageInput {
  /** base64-encoded image bytes (no data: prefix). */
  base64: string;
  /** MIME type, e.g. "image/jpeg" or "image/png". */
  mediaType: string;
}

export interface RunOptions {
  prompt: string;
  /** Images to include alongside the prompt so the model sees them directly. */
  images?: ImageInput[];
  cwd: string;
  resume?: string;
  /** Model id override for this turn; falls back to CLAUDE_MODEL. */
  model?: string;
  /** Maximum thinking-token budget for this turn; omit to use the SDK default. */
  maxThinkingTokens?: number;
  /** Env overrides for the spawned CLI (e.g. ANTHROPIC_BASE_URL for a local
   *  model). Merged over process.env; undefined values drop the variable. */
  env?: Record<string, string | undefined>;
  /** Extra worker/persona instructions appended to the system prompt. */
  systemPromptAppend?: string;
  /** Roster of MyAgens Leads, folded into the system prompt for coordination. */
  crew?: string;
  /** Pending suggestion-inbox digest (main agent only) for Atlas to triage. */
  pendingSuggestions?: string;
  /** Named directory shortcuts injected into the system prompt (main agent only). */
  knownPaths?: Array<{ label: string; path: string }>;
  /**
   * When set, replaces the Atlas personality block so a Lead/worker identifies
   * as itself rather than as Atlas. Pass getLeadProtocol() output here.
   */
  workerIdentity?: string;
  /**
   * Character and tone override (persona). Injected into the system prompt after
   * the base personality block, before work.md and worker instructions.
   */
  persona?: string;
  /** BCP 47 language tag the agent responds in (e.g. "en", "hu"). */
  language?: string;
  /** "default" = interactive approval; "bypassPermissions" = autonomous. */
  permissionMode: "default" | "bypassPermissions";
  /**
   * Which Claude config sources to load. Defaults to ["user","project","local"]
   * (full project context). Pass ["user"] for autonomous/wizard runs where the
   * cwd may be the bot's own repo or an unrelated project — avoids injecting a
   * foreign CLAUDE.md into the system prompt.
   */
  settingSources?: ("user" | "project" | "local")[];
  abortController: AbortController;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcpServers: Record<string, any>;
  canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;
  onText: (delta: string) => void;
  onToolUse: (name: string, input: unknown) => void;
  onSessionId: (id: string) => void;
  /** Fired when a tool result comes back; `isError` flags a failed tool call.
   *  Used by `auto_until_error` autonomy to escalate after a failure. */
  onToolResult?: (isError: boolean) => void;
}

/** Token counts for one turn, pulled from the SDK result's `usage` block. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface RunResult {
  isError: boolean;
  text?: string;
  costUsd?: number;
  durationMs?: number;
  /** Per-turn token counts (input/output/cache); absent if the SDK omitted them. */
  tokens?: TokenUsage;
  /** Tool calls made during this turn (for auto-skill extraction). */
  toolCalls?: Array<{ name: string; input: unknown }>;
}

/** Drive one Claude Code turn, fanning SDK events out to the provided callbacks. */
export async function runTurn(opts: RunOptions): Promise<RunResult> {
  // Recall durable memories relevant to this turn and fold them into the system
  // prompt. Hybrid semantic + keyword match when embeddings are on (Phase 2),
  // keyword-only fallback otherwise; empty store = no-op. Done once, outside the
  // retry loop below.
  const recalled = await memory.recallForPromptAsync(opts.prompt);
  const memoryBlock = recalled.length ? formatMemoriesForPrompt(recalled) : undefined;

  // The headless `claude` CLI intermittently crashes on startup/teardown with a
  // non-zero exit and NO output (a known CLI bug). It happens before any text
  // streams, so we retry the whole turn a few times — but only while nothing has
  // been emitted to the user yet, to avoid duplicating a partially-streamed reply.
  let streamedAny = false;
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Per-attempt: fresh stderr buffer, and a fresh image prompt (an image
    // generator is single-use; the text prompt is a reusable string).
    const stderr: string[] = [];
    const prompt =
      opts.images && opts.images.length > 0
        ? imagePrompt(opts.prompt, opts.images, opts.resume)
        : opts.prompt;

    const response = query({
      prompt,
      options: {
        cwd: opts.cwd,
        resume: opts.resume,
        model: normalizeModelId(opts.model ?? config.CLAUDE_MODEL),
        maxThinkingTokens: opts.maxThinkingTokens,
        // Only override the child env when asked (e.g. a local-model provider);
        // otherwise the SDK defaults to process.env.
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
        systemPrompt: systemPrompt(
          opts.systemPromptAppend,
          memoryBlock,
          opts.crew,
          opts.persona,
          opts.language,
          opts.pendingSuggestions,
          opts.knownPaths,
          opts.workerIdentity,
        ),
        permissionMode: opts.permissionMode,
        includePartialMessages: true,
        abortController: opts.abortController,
        mcpServers: opts.mcpServers,
        canUseTool: opts.canUseTool,
        stderr: (data: string) => {
          const line = data.trim();
          if (line) {
            stderr.push(line);
            log.debug("claude stderr", { line: line.slice(0, 500) });
          }
        },
        settingSources: opts.settingSources ?? ["user", "project", "local"],
      },
    }) as unknown as AsyncIterable<SdkMessage>;

    let result: RunResult = { isError: false };
    let gotResult = false;
    const toolCalls: Array<{ name: string; input: unknown }> = [];

    // Hold the dev restart-guard for the lifetime of the stream, so a source edit
    // the agent makes mid-run doesn't bounce the watcher until the turn is done.
    activityBegin();
    try {
      for await (const msg of response) {
        if (isSystemInit(msg)) {
          if (msg.session_id) opts.onSessionId(msg.session_id);
        } else if (isStreamEvent(msg)) {
          const delta = textDelta(msg);
          if (delta) {
            streamedAny = true;
            opts.onText(delta);
          }
        } else if (isAssistant(msg)) {
          for (const block of msg.message.content ?? []) {
            if (block.type === "tool_use" && block.name) {
              opts.onToolUse(block.name, block.input);
              toolCalls.push({ name: block.name, input: block.input });
            }
          }
        } else if (isUser(msg)) {
          // Tool results come back as user messages; surface error state so the
          // caller (auto_until_error autonomy) can escalate after a failure.
          if (opts.onToolResult) opts.onToolResult(hasToolError(msg));
        } else if (isResult(msg)) {
          const u = msg.usage;
          // The CLI can report a soft failure as a result with subtype
          // "error_during_execution" and a populated `errors` array while
          // `is_error` is false — if we only check `is_error` the real reason
          // (e.g. an internal CLI TypeError) is swallowed and the user sees an
          // empty/opaque reply. Surface it by throwing with the actual text.
          const m = msg as { subtype?: string; errors?: unknown };
          const errs = Array.isArray(m.errors) ? m.errors.map(String).filter(Boolean) : [];
          if (m.subtype === "error_during_execution" || errs.length) {
            const detail = errs.length ? errs.join("; ") : "error during execution";
            throw new Error(`Claude CLI reported an error during execution: ${detail}`);
          }
          result = {
            isError: Boolean(msg.is_error),
            text: msg.result,
            costUsd: msg.total_cost_usd,
            durationMs: msg.duration_ms,
            tokens: u
              ? {
                  inputTokens: u.input_tokens ?? 0,
                  outputTokens: u.output_tokens ?? 0,
                  cacheReadTokens: u.cache_read_input_tokens ?? 0,
                  cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
                }
              : undefined,
            toolCalls,
          };
          gotResult = true;
        }
      }
      return result;
    } catch (err) {
      // The CLI sometimes exits non-zero during teardown *after* emitting a valid
      // result. If we already captured a successful result, trust it rather than
      // discarding a completed turn over an exit-code-1 we can ignore.
      if (gotResult && !result.isError) {
        log.warn("claude exited non-zero after a successful result — using the result", {
          error: err instanceof Error ? err.message : String(err),
        });
        return result;
      }
      const base = err instanceof Error ? err.message : String(err);
      // Retry the silent early crash (no stderr, nothing streamed, no result yet).
      const transient = stderr.length === 0 && !streamedAny && /exited with code|process exited/i.test(base);
      if (transient && attempt < MAX_ATTEMPTS) {
        lastErr = err;
        log.warn(`claude crashed early with no output (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying`, {
          error: base,
        });
        continue;
      }
      const tail = stderr.slice(-8).join("\n");
      if (tail) log.error("claude process failed", { stderr: tail });
      if (tail) throw new Error(`${base} — ${tail}`);
      // No stderr from the CLI almost always means it couldn't authenticate or
      // wasn't found — a silent exit. Point at the doctor so the failure is fixable
      // instead of an opaque "exited with code 1". Keep this wording free of
      // auth/usage keywords so bot.ts's friendlyError() doesn't reclassify it.
      const silent = /exited with code|ENOENT|spawn/i.test(base);
      throw new Error(
        silent
          ? `${base}. The Claude CLI produced no output (retried ${attempt}×) — commonly a transient CLI crash, missing credentials, or not on PATH. Run \`npm run doctor\` on the host to see the real error.`
          : base,
      );
    } finally {
      activityEnd();
    }
  }

  // Exhausted all attempts on the transient early-crash path.
  throw new Error(
    `${lastErr instanceof Error ? lastErr.message : String(lastErr)}. The Claude CLI repeatedly crashed on startup with no output (a known headless-mode bug). Run \`npm run doctor\`.`,
  );
}

/**
 * Returns true when the error is a Claude CLI "No conversation found" rejection,
 * meaning the stored session ID is stale and the caller should drop it and retry.
 */
export function isStaleSession(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no conversation found/i.test(msg);
}

/**
 * Build a one-shot streaming-input prompt that carries images as inline content
 * blocks so the model sees them directly (rather than via a Read round-trip).
 * `session_id` is a placeholder here — actual resume is driven by the `resume`
 * option; the SDK assigns/threads the real id.
 */
async function* imagePrompt(
  text: string,
  images: ImageInput[],
  resume: string | undefined,
): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    session_id: resume ?? "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        ...images.map((img) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: img.mediaType, data: img.base64 },
        })),
        { type: "text" as const, text: text || "Take a look at this image." },
      ],
    },
  } as SDKUserMessage;
}
