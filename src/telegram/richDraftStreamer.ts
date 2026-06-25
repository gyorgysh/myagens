import { BaseDraftStreamer } from "./baseDraftStreamer.js";
import { tameRichMarkdown } from "./formatting.js";
import { sendRichMarkdown } from "./send.js";

/**
 * Streams a reply using Bot API 10.1 Rich Messages: `sendRichMessageDraft`
 * while generating, finalized with `sendRichMessage`.
 *
 * We use the `markdown` field, not `html`: Telegram's rich markdown parser is
 * built for streaming AI replies and preserves paragraph/line structure, whereas
 * the html field collapses newlines like real HTML (e.g. "foo.\n\nbar" -> "foo.bar").
 * Headings are demoted to bold (tameRichMarkdown) so they aren't oversized, and
 * skip_entity_detection keeps code-ish tokens (`#`, `$`, `@`, `/`) from being
 * auto-linked. If a finished reply is rejected, we fall back to plain messages.
 */
export class RichDraftStreamer extends BaseDraftStreamer {
  protected async pushDraft(): Promise<void> {
    await this.raw.callApi("sendRichMessageDraft", {
      chat_id: this.chatId,
      draft_id: this.draftId,
      rich_message: { markdown: tameRichMarkdown(this.content), skip_entity_detection: true },
    });
  }

  async finalize(footer?: string): Promise<void> {
    this.stopTimers();
    if (!this.content.trim()) return;
    this.persisted.push(...(await sendRichMarkdown(this.tg, this.chatId, this.content, footer)));
  }
}
