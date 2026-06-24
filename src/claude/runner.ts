import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { systemPrompt } from "../prompt.js";
import { log } from "../logger.js";
import {
  isAssistant,
  isResult,
  isStreamEvent,
  isSystemInit,
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
  /** Extra worker/persona instructions appended to the system prompt. */
  systemPromptAppend?: string;
  /** "default" = interactive approval; "bypassPermissions" = autonomous. */
  permissionMode: "default" | "bypassPermissions";
  abortController: AbortController;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcpServers: Record<string, any>;
  canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;
  onText: (delta: string) => void;
  onToolUse: (name: string, input: unknown) => void;
  onSessionId: (id: string) => void;
}

export interface RunResult {
  isError: boolean;
  text?: string;
  costUsd?: number;
  durationMs?: number;
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

  const response = query({
    prompt,
    options: {
      cwd: opts.cwd,
      resume: opts.resume,
      model: opts.model ?? config.CLAUDE_MODEL,
      systemPrompt: systemPrompt(opts.systemPromptAppend),
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
          }
        }
      } else if (isResult(msg)) {
        result = {
          isError: Boolean(msg.is_error),
          text: msg.result,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
        };
      }
    }
  } catch (err) {
    const tail = stderr.slice(-8).join("\n");
    if (tail) log.error("claude process failed", { stderr: tail });
    throw new Error(tail ? `${err instanceof Error ? err.message : String(err)} — ${tail}` : String(err));
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
