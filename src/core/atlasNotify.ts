import { Telegram } from "telegraf";
import { config, allowedUserIds } from "../config.js";
import { escapeHtml } from "../telegram/formatting.js";

/**
 * Lets a Lead's crew_report(toPresident: true) actually reach the president
 * as a distinct notification from Atlas, not a duplicate echoed into the
 * Lead's own chat via the Lead's own bot (the bug this fixes).
 *
 * Private Telegram chats use chat_id === the user's Telegram id regardless of
 * which bot is talking to them, so sending via Atlas's own token to the same
 * numeric id the Lead was chatting in reaches the same person, but shows up
 * as a message from the Atlas bot (distinct avatar/username), attributed to
 * the reporting Lead. `Telegram` (unlike `Telegraf`) is a pure API client —
 * instantiating it here never starts long-polling, so it can't collide with
 * the main bot's own getUpdates loop on the same token.
 */
let atlasTelegram: Telegram | null = null;
function getAtlasTelegram(): Telegram {
  if (!atlasTelegram) atlasTelegram = new Telegram(config.TELEGRAM_BOT_TOKEN);
  return atlasTelegram;
}

export async function notifyAsAtlas(text: string, fromLead?: string): Promise<void> {
  const telegram = getAtlasTelegram();
  const body = fromLead
    ? `<b>${escapeHtml(fromLead)}</b>\n<i>${escapeHtml(text)}</i>`
    : `<i>${escapeHtml(text)}</i>`;
  for (const targetId of allowedUserIds) {
    await telegram.sendMessage(targetId, body, { parse_mode: "HTML" }).catch(() => {});
  }
}
