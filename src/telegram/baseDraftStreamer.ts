import type { Telegram } from "telegraf";
import type { Streamer } from "./streamer.js";

const DRAFT_INTERVAL_MS = 250;
/** Drafts are a 30s ephemeral preview; refresh well within that during quiet spells. */
const KEEPALIVE_MS = 20_000;

/**
 * Minimal typed view of the raw Bot API caller. telegraf 4.16.3 predates Bot
 * API 9.3/10.1, so the draft methods have no typed wrapper — we call by name.
 */
export type RawApi = {
  callApi(method: string, payload: Record<string, unknown>): Promise<unknown>;
};

/**
 * Shared streaming machinery for the draft-based backends (plain 9.3 and rich
 * 10.1): throttled flush of the growing reply into an animated, ephemeral draft
 * under a stable `draft_id`, plus a keepalive so the 30s preview never lapses
 * during long tool runs. Subclasses define how a draft is sent and finalized.
 *
 * Drafts target a private chat only (per the Bot API).
 */
export abstract class BaseDraftStreamer implements Streamer {
  protected content = "";
  protected status = "";
  protected closed = false;
  protected readonly draftId: number;
  protected readonly raw: RawApi;
  /** Persistent messages sent by finalize() (the draft preview is ephemeral). */
  protected persisted: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private keepalive: NodeJS.Timeout | null = null;
  private flushing = false;
  private dirty = false;

  constructor(
    protected tg: Telegram,
    protected chatId: number,
    draftId?: number,
  ) {
    // draft_id must be non-zero; keep it stable for the turn so updates animate.
    this.draftId = draftId ?? ((Date.now() & 0x7fffffff) || 1);
    this.raw = tg as unknown as RawApi;
  }

  /**
   * Start the keepalive. We don't push anything until real text arrives — an
   * empty/placeholder draft renders as a stray "Thinking…" bubble.
   */
  async start(): Promise<void> {
    this.keepalive = setInterval(() => {
      // Re-send the current state to reset the 30s expiry even when idle.
      if (!this.closed && this.content) void this.pushDraft().catch(() => {});
    }, KEEPALIVE_MS);
  }

  appendText(delta: string): void {
    if (!delta) return;
    this.content += delta;
    this.status = "";
    this.schedule();
  }

  setStatus(line: string): void {
    this.status = line;
    this.schedule();
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, DRAFT_INTERVAL_MS);
  }

  private async flush(): Promise<void> {
    if (this.closed) return;
    if (this.flushing) {
      this.schedule();
      return;
    }
    if (!this.dirty) return;
    // Nothing to preview yet — avoid an empty placeholder draft.
    if (!this.content) return;
    this.flushing = true;
    this.dirty = false;
    try {
      await this.pushDraft();
    } catch {
      // Draft preview is best-effort; the final send still delivers the reply.
    } finally {
      this.flushing = false;
    }
  }

  protected stopTimers(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.keepalive) clearInterval(this.keepalive);
    this.timer = null;
    this.keepalive = null;
  }

  persistedMessageIds(): number[] {
    return [...this.persisted];
  }

  /** Send the current streaming state (or a placeholder when empty) as a draft. */
  protected abstract pushDraft(): Promise<void>;
  /** Stop streaming and persist the complete reply; the draft then expires. */
  abstract finalize(footer?: string): Promise<void>;
}
