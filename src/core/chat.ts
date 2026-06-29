import { config } from "../config.js";
import { sessions } from "../session/manager.js";
import { chatBridge, mainChatId, type BridgeMessage } from "./chatBridge.js";
import { audit } from "./audit.js";

export type ChatMessage = BridgeMessage;

type Broadcaster = (msg: unknown) => void;

/**
 * Prepended to a message when the panel Chat is in *Planning mode*. It keeps the
 * turn conversational and non-destructive: Atlas scopes the work and proposes
 * inbox cards / backlog tasks instead of editing files or running commands. The
 * model still has the tools available, but is instructed not to act on them.
 */
const PLANNING_PREAMBLE = [
  "[Planning mode] Stay conversational and non-destructive for this turn.",
  "Do NOT take real actions: no editing files, running shell commands, or",
  "mutating anything. Your job is to think through and scope the work with me.",
  "When you have something concrete to capture, propose it as an inbox",
  'suggestion (crew_suggest) or a backlog card (task_create with column "backlog")',
  "— title, notes, and priority — rather than doing the work now.",
  "If anything is ambiguous, ask a short clarifying question instead of guessing.",
  "",
  "My message:",
  "",
].join("\n");

/**
 * Panel Chat is a window onto the *main* Telegram conversation (the first
 * allowed user's session). It no longer keeps its own isolated Claude session:
 * messages typed in Telegram show up here, messages sent from the panel are
 * driven through the same turn flow (shared resume token, cwd, autonomy), and
 * tool approvals surface as the usual Telegram inline buttons.
 *
 * This class is a thin facade over `chatBridge` (the live mirror) + the main
 * `Session`, preserving the REST surface the panel server already speaks.
 */
export class ChatManager {
  start(broadcast: Broadcaster): void {
    chatBridge.start(broadcast);
  }

  isEnabled(): boolean {
    return config.PANEL_CHAT_ENABLED;
  }

  /** The main Telegram session, or undefined if no allowed user is configured. */
  private mainSession() {
    const id = mainChatId();
    return id === undefined ? undefined : sessions.get(id);
  }

  /** Panel-facing snapshot. */
  view() {
    const s = this.mainSession();
    return {
      enabled: this.isEnabled(),
      messages: chatBridge.history(),
      cwd: s?.cwd ?? config.WORKDIR,
      busy: s?.busy ?? false,
      // "auto" maps to the shared session's full-autonomy mode.
      auto: s?.autonomy === "full",
      hasContext: Boolean(s?.sessionId),
      // The panel no longer holds approvals; they happen in Telegram.
      approvalsInTelegram: true,
    };
  }

  setCwd(cwd: string): void {
    const s = this.mainSession();
    if (!s) return;
    s.cwd = cwd.trim() || config.WORKDIR;
    sessions.save();
  }

  /** Toggle auto/bypass mode → maps to the shared session's autonomy. */
  setAuto(auto: boolean): void {
    const s = this.mainSession();
    if (!s) return;
    s.autonomy = auto ? "full" : "standard";
    sessions.save();
  }

  /** Start a fresh conversation (drop resume token + mirrored history). */
  clear(): void {
    const id = mainChatId();
    if (id !== undefined) {
      const s = sessions.get(id);
      s.abort?.abort();
      sessions.reset(id);
    }
    chatBridge.clearTranscript();
    audit("chat.clear", {});
  }

  stop(): void {
    chatBridge.stop();
  }

  /** Approvals now happen in Telegram; kept for REST back-compat (no-op). */
  resolveApproval(_id: string, _allow: boolean): boolean {
    return false;
  }

  /**
   * Send a user message — drives a turn on the main Telegram chat. When
   * `planning` is set, a non-destructive preamble is prepended so Atlas scopes
   * the work and proposes inbox/backlog items instead of acting.
   */
  send(text: string, planning = false): { ok: boolean; error?: string } {
    const s = this.mainSession();
    if (s?.busy) return { ok: false, error: "busy" };
    const prompt = planning ? PLANNING_PREAMBLE + text : text;
    const r = chatBridge.send(prompt);
    if (r.ok) audit("chat.send", { chars: text.trim().length, planning });
    return r;
  }
}

export const chat = new ChatManager();
