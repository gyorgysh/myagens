import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { systemPrompt } from "../prompt.js";
import { memory, formatMemories } from "../core/memory.js";
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
  "mcp__tasks__task_update",
  // Saving/refining reusable skills is a safe, user-facing action.
  "mcp__skills__skill_save",
  "mcp__skills__skill_patch",
  "mcp__skills__skill_list",
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
  /** Env overrides for the spawned CLI (e.g. ANTHROPIC_BASE_URL for a local
   *  model). Merged over process.env; undefined values drop the variable. */
  env?: Record<string, string | undefined>;
  /** Extra worker/persona instructions appended to the system prompt. */
  systemPromptAppend?: string;
  /** Roster of MyHQ Leads, folded into the system prompt for coordination. */
  crew?: string;
  /**
   * Character and tone override (persona). Injected into the system prompt after
   * the base personality block, before work.md and worker instructions.
   */
  persona?: string;
  /** BCP 47 language tag the agent responds in (e.g. "en", "hu"). */
  language?: string;
  /** "default" = interactive approval; "bypassPermissions" = autonomous. */
  permissionMode: "default" | "bypassPermissions";
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

export interface RunResult {
  isError: boolean;
  text?: string;
  costUsd?: number;
  durationMs?: number;
  /** Tool calls made during this turn (for auto-skill extraction). */
  toolCalls?: Array<{ name: string; input: unknown }>;
}

/** Drive one Claude Code turn, fanning SDK events out to the provided callbacks. */
export async function runTurn(opts: RunOptions): Promise<RunResult> {
  // Capture the underlying CLI's stderr so a non-zero exit isn't an opaque
  // "process exited with code 1" — the real reason ends up in our logs / error.
  const stderr: string[] = [];

  // With images we must use streaming input (a single structured user message
  // carrying image blocks); plain text stays a plain string prompt.
  const prompt =
    opts.images && opts.images.length > 0
      ? imagePrompt(opts.prompt, opts.images, opts.resume)
      : opts.prompt;

  // Recall durable memories relevant to this turn and fold them into the system
  // prompt. Hybrid semantic + keyword match when embeddings are on (Phase 2),
  // keyword-only fallback otherwise; empty store = no-op.
  const recalled = await memory.recallForPromptAsync(opts.prompt);
  const memoryBlock = recalled.length ? formatMemories(recalled) : undefined;

  const response = query({
    prompt,
    options: {
      cwd: opts.cwd,
      resume: opts.resume,
      model: opts.model ?? config.CLAUDE_MODEL,
      // Only override the child env when asked (e.g. a local-model provider);
      // otherwise the SDK defaults to process.env.
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
      systemPrompt: systemPrompt(opts.systemPromptAppend, memoryBlock, opts.crew, opts.persona, opts.language),
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
      // Load project context (CLAUDE.md, settings) for a real Claude Code feel.
      settingSources: ["user", "project", "local"],
    },
  }) as unknown as AsyncIterable<SdkMessage>;

  let result: RunResult = { isError: false };
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
        if (delta) opts.onText(delta);
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
        result = {
          isError: Boolean(msg.is_error),
          text: msg.result,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          toolCalls,
        };
      }
    }
  } catch (err) {
    const tail = stderr.slice(-8).join("\n");
    if (tail) log.error("claude process failed", { stderr: tail });
    throw new Error(tail ? `${err instanceof Error ? err.message : String(err)} — ${tail}` : String(err));
  } finally {
    activityEnd();
  }

  return result;
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
