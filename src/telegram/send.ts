import type { Telegram } from "telegraf";
import type { RawApi } from "./baseDraftStreamer.js";
import { escapeHtml, markdownToHtml, splitForTelegram, tameRichMarkdown } from "./formatting.js";

/**
 * Persist a finished reply using Telegram Rich Messages (Bot API 10.1), the same
 * renderer the rich streamer uses — so headings, lists and paragraph spacing look
 * the way the streamed transcript did. Headings are demoted to bold (oversized in
 * chat) and skip_entity_detection keeps `#`/`$`/`@`/`/` from being auto-linked. On
 * any rejection (length/unsupported) we fall back to the HTML path so a reply is
 * never dropped. Returns the persisted message id(s).
 */
export async function sendRichMarkdown(
  tg: Telegram,
  chatId: number,
  markdown: string,
  footer?: string,
): Promise<number[]> {
  const tamed = tameRichMarkdown(markdown);
  const full = footer ? `${tamed}\n\n_${footer}_` : tamed;
  try {
    const sent = (await (tg as unknown as RawApi).callApi("sendRichMessage", {
      chat_id: chatId,
      rich_message: { markdown: full, skip_entity_detection: true },
    })) as { message_id?: number } | undefined;
    return sent?.message_id ? [sent.message_id] : [];
  } catch {
    return sendFormattedMarkdown(tg, chatId, tamed, footer);
  }
}

/**
 * Persist a finished reply as one or more real messages: markdown -> Telegram
 * HTML, split under the 4096 limit, with a plain-text fallback if Telegram
 * rejects the HTML so a reply is never dropped.
 */
export async function sendFormattedMarkdown(
  tg: Telegram,
  chatId: number,
  markdown: string,
  footer?: string,
): Promise<number[]> {
  const body = markdownToHtml(markdown) || "";
  const footerLine = footer ? (body ? "\n\n" : "") + `<i>${escapeHtml(footer)}</i>` : "";
  const full = (body + footerLine).trim();
  if (!full) return [];
  const ids: number[] = [];
  for (const chunk of splitForTelegram(full)) {
    ids.push(await sendChunk(tg, chatId, chunk));
  }
  return ids;
}

async function sendChunk(tg: Telegram, chatId: number, text: string): Promise<number> {
  try {
    const msg = await tg.sendMessage(chatId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    return msg.message_id;
  } catch (err) {
    const desc = String((err as { description?: string })?.description ?? err);
    if (desc.includes("can't parse entities")) {
      const msg = await tg.sendMessage(chatId, stripTags(text), {
        link_preview_options: { is_disabled: true },
      });
      return msg.message_id;
    }
    throw err;
  }
}

export function stripTags(html: string): string {
  return html
    .replace(/<\/?(b|i|code|pre)>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
