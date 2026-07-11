import { config } from "../config.js";
import { sessions, type Autonomy } from "../session/manager.js";
import { chatBridge, mainChatId, type BridgeMessage } from "./chatBridge.js";
import { approvalQueue, type ApprovalChoice } from "./approvals.js";
import { askQueue } from "./askQueue.js";
import { PLANNING_PREAMBLE } from "./planningMode.js";
import { audit } from "./audit.js";
import { resetInstanceConversation } from "../claude/tmuxInstance.js";
import type { ImageInput } from "../claude/runner.js";

export type ChatMessage = BridgeMessage;

type Broadcaster = (msg: unknown) => void;

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
      // The shared session's actual autonomy level (what bot.ts's canUseTool
      // really gates on), plus the old boolean for any lingering callers.
      autonomy: s?.autonomy ?? "standard",
      auto: s?.autonomy === "full",
      hasContext: Boolean(s?.sessionId),
      // The shared session's persisted "always allow" presets, surfaced read-only
      // in the panel as a Permissions indicator.
      allowedTools: s ? [...s.sessionAllowedTools] : [],
      allowedBashCmds: s ? [...s.allowedBashCmds] : [],
      // Pending tool-call approvals can be resolved from the panel too (the same
      // promises the Telegram buttons settle).
      approvals: approvalQueue.list(),
      // Pending AskUserQuestion prompts, answerable from the panel. Excludes
      // Lead-owned questions (those surface in that Lead's own chat pane).
      asks: askQueue.list().filter((a) => !a.agentId),
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

  /**
   * Set the shared session's autonomy level directly. This is the field
   * bot.ts's canUseTool actually gates on for the live Telegram/panel chat -
   * distinct from (and previously confused with) the global mainSettings
   * default, which only seeds *new* sessions and has no effect on this one.
   */
  setAutonomy(level: Autonomy): void {
    const s = this.mainSession();
    if (!s) return;
    s.autonomy = level;
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
    // Tmux mode: the conversation also lives in the persistent TUI — drop its
    // resume tokens too, or the old thread would just be resumed next turn.
    void resetInstanceConversation("atlas").catch(() => {});
    chatBridge.clearTranscript();
    audit("chat.clear", {});
  }

  stop(): void {
    chatBridge.stop();
  }

  /**
   * Resolve a pending tool-call approval from the panel. The panel token is
   * trusted (same trust level as terminal/chat access), so a simple allow/deny
   * maps to the shared PermissionManager's approve/deny. Delegates to the same
   * `approvalQueue` the Telegram buttons settle, so whichever surface acts first
   * wins and the other updates in place.
   */
  resolveApproval(id: string, allow: boolean): boolean {
    const choice: ApprovalChoice = allow ? "allow" : "deny";
    return approvalQueue.resolve(id, choice);
  }

  /**
   * Send a user message — drives a turn on the main Telegram chat. When
   * `planning` is set, a non-destructive preamble is prepended so Atlas scopes
   * the work and proposes inbox/backlog items instead of acting.
   */
  send(text: string, planning = false, images?: ImageInput[]): { ok: boolean; error?: string } {
    const s = this.mainSession();
    if (s?.busy) return { ok: false, error: "busy" };
    const prompt = planning ? PLANNING_PREAMBLE + text : text;
    const r = chatBridge.send(prompt, images);
    if (r.ok) audit("chat.send", { chars: text.trim().length, planning, images: images?.length ?? 0 });
    return r;
  }
}

export const chat = new ChatManager();
