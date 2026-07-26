import { escapeHtml } from "../telegram/formatting.js";
import { notifyOwner } from "./notify.js";

/**
 * Lets a Lead's crew_report(toPresident: true) actually reach the president
 * as a distinct notification from Atlas, not a duplicate echoed into the
 * Lead's own chat via the Lead's own bot (the bug this fixes).
 *
 * Routed through `notifyOwner()` so it reaches whichever surfaces are running.
 * On Telegram that means Atlas's own token rather than the reporting Lead's:
 * private chats use chat_id === the user's id regardless of which bot is
 * talking, so the same person gets the message, but it shows up from the Atlas
 * bot (distinct avatar/username), attributed to the Lead. With no Telegram
 * surface at all the report still lands in the panel and the log.
 */
export async function notifyAsAtlas(text: string, fromLead?: string): Promise<void> {
  const html = fromLead
    ? `<b>${escapeHtml(fromLead)}</b>\n<i>${escapeHtml(text)}</i>`
    : `<i>${escapeHtml(text)}</i>`;
  await notifyOwner({
    text: fromLead ? `${fromLead}: ${text}` : text,
    telegram: { html },
  });
}
