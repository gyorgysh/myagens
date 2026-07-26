/**
 * ChatBridge — the panel Chat view's window onto the President's conversation.
 *
 * The panel Chat does not run its own isolated Claude session; it shares one,
 * and *who drives it* depends on which surfaces are configured:
 *
 * - With Telegram: the bridge is a window onto the main Telegram chat (the
 *   first allowed user). Messages typed in Telegram appear in the panel,
 *   messages sent from the panel run through the same `handleUserPrompt` flow
 *   (same resume token, cwd, autonomy), and tool approvals surface as the usual
 *   Telegram inline buttons — answerable from either side.
 * - Without Telegram: `core/panelChatRunner.ts` attaches instead and runs the
 *   turn natively against the `PANEL_CHAT_ID` session, with approvals and
 *   questions going to the panel's own queues. The panel is then a complete
 *   front end with no chat surface installed at all.
 *
 * Either way exactly one `Runner` is attached at startup; the panel
 * `ChatManager` calls `bridge.send()` to drive a turn, and the running turn
 * calls the `mirror*` hooks so the panel sees the conversation live.
 */

import { config, allowedUserIds } from "../config.js";
import { isPlanningPrompt, stripPlanningPreamble } from "./planningMode.js";
import type { ImageInput } from "../claude/runner.js";

/** Drives a single turn for the main Telegram chat. Registered by the bot. */
type Runner = (chatId: number, prompt: string, images?: ImageInput[]) => void;
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

/**
 * Session key for the President's conversation when there is no Telegram
 * surface to borrow one from. Telegram chat ids are never 0, so this can never
 * collide with a real chat, and using a plain session key means every part of
 * the stack that already speaks `Session` (cwd, autonomy, resume token, the
 * "always allow" presets) works unchanged in panel-only mode.
 */
export const PANEL_CHAT_ID = 0;

/**
 * The main chat id the panel mirrors — the first allowed Telegram user, or the
 * synthetic panel session when Telegram is not configured.
 */
export function mainChatId(): number {
  return [...allowedUserIds][0] ?? PANEL_CHAT_ID;
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

  /** Whether the bridge is live (some surface has attached a turn runner). */
  get ready(): boolean {
    return this.runner !== null;
  }

  history(): BridgeMessage[] {
    return this.messages;
  }

  /** Drive a turn for the main chat. Returns false if not currently possible.
   *  Optional images ride along as inline vision input for this turn. */
  send(text: string, images?: ImageInput[]): { ok: boolean; error?: string } {
    if (!this.isEnabled()) return { ok: false, error: "disabled" };
    const trimmed = text.trim();
    // An image-only message is allowed (the model still gets something to look
    // at); otherwise require some text.
    if (!trimmed && !(images && images.length)) return { ok: false, error: "empty" };
    if (!this.runner) return { ok: false, error: "no-chat" };
    this.runner(mainChatId(), trimmed, images);
    return { ok: true };
  }

  /** Abort the in-flight turn on the main chat. */
  stop(): void {
    this.stopper?.(mainChatId());
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
