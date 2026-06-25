import type { Telegram } from "telegraf";
import { escapeHtml, markdownToHtml, splitForTelegram } from "./formatting.js";

const EDIT_INTERVAL_MS = 250;

/** Common surface for the streaming backends (edit-in-place or message drafts). */
export interface Streamer {
  appendText(delta: string): void;
  setStatus(line: string): void;
  finalize(footer?: string): Promise<void>;
  /**
   * Persistent message IDs this streamer has sent (non-ephemeral). Empty for the
   * draft backends, whose previews auto-expire and whose final reply is sent
   * separately. Used to delete the streamed transcript when a turn replaces it
   * with a summary report (autonomous runs).
   */
  persistedMessageIds(): number[];
}

/**
 * Streams an assistant reply into Telegram by editing a placeholder message in
 * place (throttled), spilling into continuation messages past the 4096 limit.
 *
 * Usage:
 *   const s = new TelegramStreamer(tg, chatId, placeholderId);
 *   s.appendText(delta);      // many times as tokens arrive
 *   s.setStatus("🔧 Bash …"); // transient status line (cleared by next append/finalize)
 *   await s.finalize(footer); // force a final render
 */
export class TelegramStreamer implements Streamer {
  private content = "";
  private status = "";
  private footer = "";
  private messageIds: number[];
  private lastRendered = new Map<number, string>();
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private dirty = false;

  constructor(
    private tg: Telegram,
    private chatId: number,
    placeholderId: number,
  ) {
    this.messageIds = [placeholderId];
  }

  appendText(delta: string): void {
    if (!delta) return;
    this.content += delta;
    this.status = "";
    this.scheduleFlush();
  }

  setStatus(line: string): void {
    this.status = line;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, EDIT_INTERVAL_MS);
  }

  private render(): string {
    // Body is markdown -> HTML (escapes &<>); status and footer are already
    // trusted HTML, so they must be appended *after* conversion, not before.
    const body = markdownToHtml(this.content) || "";
    const statusLine = this.status ? (body ? "\n\n" : "") + this.status : "";
    const footerLine = this.footer ? (body || statusLine ? "\n\n" : "") + `<i>${this.footer}</i>` : "";
    return (body + statusLine + footerLine).trim() || "…";
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      this.scheduleFlush();
      return;
    }
    if (!this.dirty) return;
    this.flushing = true;
    this.dirty = false;

    const chunks = splitForTelegram(this.render());
    try {
      for (let i = 0; i < chunks.length; i++) {
        const text = chunks[i];
        const id = this.messageIds[i];
        if (id === undefined) {
          const sent = await this.sendChunk(text);
          this.messageIds[i] = sent;
          this.lastRendered.set(sent, text);
        } else if (this.lastRendered.get(id) !== text) {
          await this.editChunk(id, text);
          this.lastRendered.set(id, text);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  persistedMessageIds(): number[] {
    return [...this.messageIds];
  }

  /** Force a final render with an optional footer (e.g. cost/duration). */
  async finalize(footer?: string): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.status = "";
    if (footer) this.footer = escapeHtml(footer);
    this.dirty = true;
    await this.flush();
  }

  private async sendChunk(text: string): Promise<number> {
    const msg = await this.tg.sendMessage(this.chatId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    return msg.message_id;
  }

  private async editChunk(id: number, text: string): Promise<void> {
    try {
      await this.tg.editMessageText(this.chatId, id, undefined, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      const desc = String((err as { description?: string })?.description ?? err);
      // Identical content — harmless race with throttling.
      if (desc.includes("message is not modified")) return;
      // Malformed HTML entity — never drop a reply; resend as plain text.
      if (desc.includes("can't parse entities")) {
        await this.tg.editMessageText(this.chatId, id, undefined, stripTags(text), {
          link_preview_options: { is_disabled: true },
        });
        return;
      }
      throw err;
    }
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<\/?(b|i|code|pre)>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
