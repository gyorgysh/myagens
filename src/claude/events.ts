/**
 * Narrow, defensive views over the messages emitted by the Agent SDK's query()
 * generator. We model only the fields we consume so the integration stays stable
 * across minor SDK shape changes; everything is accessed through type guards.
 */

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  /** Present on tool_result blocks: true when the tool reported an error. */
  is_error?: boolean;
  /** tool_result links back to the tool_use it answers. */
  tool_use_id?: string;
}

export interface SdkSystemMessage {
  type: "system";
  subtype?: string;
  session_id?: string;
}

export interface SdkAssistantMessage {
  type: "assistant";
  message: { content: ContentBlock[] };
  session_id?: string;
}

export interface SdkUserMessage {
  type: "user";
  message: { content: ContentBlock[] | string };
  session_id?: string;
}

export interface SdkStreamEvent {
  type: "stream_event";
  event: {
    type: string;
    delta?: { type?: string; text?: string };
    content_block?: { type?: string };
  };
}

export interface SdkResultMessage {
  type: "result";
  subtype?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  session_id?: string;
}

export type SdkMessage =
  | SdkSystemMessage
  | SdkAssistantMessage
  | SdkUserMessage
  | SdkStreamEvent
  | SdkResultMessage
  | { type: string };

export function isSystemInit(m: SdkMessage): m is SdkSystemMessage {
  return m.type === "system" && (m as SdkSystemMessage).subtype === "init";
}
export function isAssistant(m: SdkMessage): m is SdkAssistantMessage {
  return m.type === "assistant";
}
export function isUser(m: SdkMessage): m is SdkUserMessage {
  return m.type === "user";
}

/** True if a user message carries at least one tool_result block flagged is_error. */
export function hasToolError(m: SdkUserMessage): boolean {
  const content = m.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b.type === "tool_result" && b.is_error === true);
}
export function isStreamEvent(m: SdkMessage): m is SdkStreamEvent {
  return m.type === "stream_event";
}
export function isResult(m: SdkMessage): m is SdkResultMessage {
  return m.type === "result";
}

/** Extract a text delta from a streaming content_block_delta event, if present. */
export function textDelta(m: SdkStreamEvent): string | undefined {
  const e = m.event;
  if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
    return e.delta.text;
  }
  return undefined;
}
