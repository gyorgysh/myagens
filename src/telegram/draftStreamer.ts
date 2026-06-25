import { BaseDraftStreamer } from "./baseDraftStreamer.js";
import { sendFormattedMarkdown, stripTags } from "./send.js";

const DRAFT_MAX_CHARS = 4096;

/**
 * Streams a reply using Bot API 9.3 `sendMessageDraft`: a native, animated,
 * 30-second ephemeral preview. The draft is plain text (partial markdown can't
 * always parse as HTML mid-stream); the finished reply is persisted as a real,
 * fully-formatted message via `sendMessage`.
 */
export class DraftStreamer extends BaseDraftStreamer {
  /** Plain-text preview body, capped to the latest DRAFT_MAX_CHARS characters. */
  private draftText(): string {
    const status = this.status ? (this.content ? "\n\n" : "") + stripTags(this.status) : "";
    let t = (this.content + status).trim();
    if (t.length > DRAFT_MAX_CHARS) t = "…" + t.slice(t.length - DRAFT_MAX_CHARS + 1);
    return t;
  }

  protected async pushDraft(): Promise<void> {
    await this.raw.callApi("sendMessageDraft", {
      chat_id: this.chatId,
      draft_id: this.draftId,
      text: this.draftText(),
    });
  }

  async finalize(footer?: string): Promise<void> {
    this.stopTimers();
    this.persisted.push(...(await sendFormattedMarkdown(this.tg, this.chatId, this.content, footer)));
  }
}
