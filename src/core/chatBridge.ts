/**
 * ChatBridge — connects the panel Chat view to the live Telegram conversation.
 *
 * The panel Chat no longer runs its own isolated Claude session. Instead it is a
 * window onto the *main* Telegram chat (the first allowed user): messages typed
 * in Telegram appear in the panel, messages sent from the panel are driven
 * through the same `handleUserPrompt` flow (same resume token, cwd, autonomy),
 * and tool approvals surface as the usual Telegram inline buttons.
 *
 * The bot registers a `Runner` here at startup (capturing its `permissions` +
 * `telegram` handles); the panel `ChatManager` calls `bridge.send()` to drive a
 * turn, and `handleUserPrompt` calls the `mirror*` hooks so the panel sees the
 * conversation live.
 */

import { config, allowedUserIds } from "../config.js";
import { isPlanningPrompt, stripPlanningPreamble } from "./planningMode.js";

/** Drives a single turn for the main Telegram chat. Registered by the bot. */
type Runner = (chatId: number, prompt: string) => void;
/** Aborts the in-flight turn for the main chat. Registered by the bot. */
type Stopper = (chatId: number) => void;
type Broadcaster = (msg: unknown) => void;

export interface BridgeMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  error?: boolean;
  costUsd?: number;
  /** True when this user message was sent in planning mode (preamble stripped). */
  planning?: boolean;
}

const HISTORY_CAP = 200;

/** The main chat id the panel mirrors — the first allowed user. */
export function mainChatId(): number | undefined {
  return [...allowedUserIds][0];
}

class ChatBridge {
  private runner: Runner | null = null;
  private stopper: Stopper | null = null;
  private broadcast: Broadcaster = () => {};
  /** Live transcript of the main chat, rebuilt as turns flow. */
  private messages: BridgeMessage[] = [];

  /** Wire the panel hub broadcaster (called from the panel server). */
  start(broadcast: Broadcaster): void {
    this.broadcast = broadcast;
  }

  /** Wire the bot's turn runner + stopper (called from buildBot). */
  attach(runner: Runner, stopper: Stopper): void {
    this.runner = runner;
    this.stopper = stopper;
  }

  isEnabled(): boolean {
    return config.PANEL_CHAT_ENABLED;
  }

  /** Whether the bridge is live (bot attached and a main chat exists). */
  get ready(): boolean {
    return this.runner !== null && mainChatId() !== undefined;
  }

  history(): BridgeMessage[] {
    return this.messages;
  }

  /** Drive a turn for the main chat. Returns false if not currently possible. */
  send(text: string): { ok: boolean; error?: string } {
    if (!this.isEnabled()) return { ok: false, error: "disabled" };
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "empty" };
    const id = mainChatId();
    if (id === undefined || !this.runner) return { ok: false, error: "no-chat" };
    this.runner(id, trimmed);
    return { ok: true };
  }

  /** Abort the in-flight turn on the main chat. */
  stop(): void {
    const id = mainChatId();
    if (id !== undefined) this.stopper?.(id);
  }

  // --- mirror hooks, called from handleUserPrompt for the main chat ---

  /**
   * Record + broadcast a user message (typed in Telegram or the panel). When the
   * text carries the planning preamble, strip it and flag the message so the panel
   * renders a compact "PLANNING" badge instead of the verbose preamble.
   */
  mirrorUser(text: string): void {
    const planning = isPlanningPrompt(text);
    const display = planning ? stripPlanningPreamble(text) : text;
    const m: BridgeMessage = { id: rid(), role: "user", text: display, ts: Date.now(), planning: planning || undefined };
    this.append(m);
    this.broadcast({ type: "chat", event: "user", message: m });
  }

  /** Signal the assistant turn is starting; returns the message id to stream into. */
  mirrorStart(): string {
    const id = rid();
    this.broadcast({ type: "chat", event: "start", id });
    return id;
  }

  mirrorDelta(id: string, delta: string): void {
    this.broadcast({ type: "chat", event: "delta", id, delta });
  }

  mirrorTool(id: string, tool: string, arg: string): void {
    this.broadcast({ type: "chat", event: "tool", id, tool, arg });
  }

  /** Finalize the assistant message: record + broadcast. */
  mirrorEnd(id: string, text: string, opts: { error?: boolean; costUsd?: number } = {}): void {
    const m: BridgeMessage = {
      id,
      role: "assistant",
      text,
      ts: Date.now(),
      error: opts.error,
      costUsd: opts.costUsd,
    };
    this.append(m);
    this.broadcast({ type: "chat", event: "end", message: m });
  }

  mirrorBusy(busy: boolean): void {
    this.broadcast({ type: "chat", event: "busy", busy });
  }

  /** Clear the mirrored transcript (does not touch the Telegram session). */
  clearTranscript(): void {
    this.messages = [];
    this.broadcast({ type: "chat", event: "cleared" });
  }

  private append(m: BridgeMessage): void {
    this.messages.push(m);
    if (this.messages.length > HISTORY_CAP) {
      this.messages = this.messages.slice(-HISTORY_CAP);
    }
  }
}

function rid(): string {
  return Math.random().toString(16).slice(2, 10);
}

export const chatBridge = new ChatBridge();
