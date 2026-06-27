import { Markup, type Telegram } from "telegraf";
import { suggestions, type Suggestion } from "../core/suggestions.js";
import { log } from "../logger.js";
import { escapeHtml } from "./formatting.js";

const HEADER = "<b>📥 Suggestion inbox</b>";

type Row = ReturnType<typeof Markup.button.callback>[];

/** One block of HTML per pending suggestion + its action rows. */
function renderItem(s: Suggestion): { text: string; rows: Row[] } {
  const cat = s.category ? ` <i>[${escapeHtml(s.category)}]</i>` : "";
  const text =
    `• <b>${escapeHtml(s.title)}</b>${cat}\n` +
    `  <i>${escapeHtml(s.fromAgentName)}</i> · <code>${s.id}</code>`;
  return {
    text,
    rows: [
      [
        Markup.button.callback("📋 Park", `inbox:${s.id}:acc`),
        Markup.button.callback("🚀 Delegate", `inbox:${s.id}:del`),
        Markup.button.callback("✕ Dismiss", `inbox:${s.id}:dis`),
      ],
      [Markup.button.callback("🔎 Details", `inbox:${s.id}:det`)],
    ],
  };
}

/** Build the full digest body + keyboard from the pending queue. */
function buildDigest(): { body: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const pending = suggestions.pending();
  if (pending.length === 0) {
    return {
      body: `${HEADER}\n\nInbox clear. Nothing waiting for review.`,
      keyboard: Markup.inlineKeyboard([]),
    };
  }
  const blocks = pending.map(renderItem);
  const body =
    `${HEADER}\n${pending.length} pending. ` +
    `Park files a backlog card; delegate gets it done now; dismiss archives it.\n\n` +
    blocks.map((b) => b.text).join("\n\n");
  return { body, keyboard: Markup.inlineKeyboard(blocks.flatMap((b) => b.rows)) };
}

/** Reply to /inbox with the pending suggestion digest. */
export async function sendInbox(tg: Telegram, chatId: number): Promise<void> {
  const { body, keyboard } = buildDigest();
  await tg.sendMessage(chatId, body, { parse_mode: "HTML", ...keyboard });
}

export function isInboxCallback(data: string): boolean {
  return data.startsWith("inbox:");
}

/** Resolve an /inbox button press; returns a short toast for answerCbQuery. */
export async function resolveInboxCallback(
  tg: Telegram,
  chatId: number,
  data: string,
  messageId: number | undefined,
): Promise<string> {
  const [, id, action] = data.split(":");
  const s = suggestions.get(id);
  if (!s) return "That suggestion is gone.";

  let toast = "";
  if (action === "det") {
    // Reply with the full detail text; don't touch the digest.
    const cat = s.category ? `\n<i>Category: ${escapeHtml(s.category)}</i>` : "";
    await tg
      .sendMessage(
        chatId,
        `🔎 <b>${escapeHtml(s.title)}</b>\n<i>from ${escapeHtml(s.fromAgentName)}</i>${cat}\n\n${escapeHtml(s.detail)}`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return "Details posted";
  } else if (action === "acc") {
    const updated = suggestions.accept(id);
    if (updated?.status === "accepted") {
      log.info("Suggestion parked", { id, taskId: updated.taskId });
      toast = "Parked → backlog card";
    } else {
      toast = "Already decided";
    }
  } else if (action === "del") {
    const { suggestion, leadName, started } = suggestions.delegate(id);
    if (started && suggestion) {
      const who = leadName ?? "a generic run";
      log.info("Suggestion delegated", { id, taskId: suggestion.taskId, leadName });
      await tg
        .sendMessage(
          chatId,
          `🚀 Delegated <b>${escapeHtml(suggestion.title)}</b> to <b>${escapeHtml(who)}</b>. ` +
            `The card is in progress; I'll report back when it's done.`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});
      toast = leadName ? `Delegated to ${leadName}` : "Delegated";
    } else {
      toast = suggestion ? "Couldn't start (already running?)" : "That suggestion is gone.";
    }
  } else if (action === "dis") {
    const updated = suggestions.dismiss(id);
    toast = updated?.status === "dismissed" ? "Dismissed" : "Already decided";
  } else {
    return "";
  }

  // Re-render the digest in place so the decided item drops off.
  if (messageId !== undefined) {
    const { body, keyboard } = buildDigest();
    await tg
      .editMessageText(chatId, messageId, undefined, body, {
        parse_mode: "HTML",
        ...keyboard,
      })
      .catch(() => {});
  }
  return toast;
}
