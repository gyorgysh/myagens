import { basename } from "node:path";
import { Markup, type Telegram } from "telegraf";
import { sessions } from "../session/manager.js";
import { log } from "../logger.js";
import { escapeHtml } from "./formatting.js";
import * as git from "../git.js";

const DIFF_INLINE_LIMIT = 3500; // above this we send the diff as a .diff file

/** Inline keyboard shown under a diff: one-tap commit or (confirmed) discard. */
function reviewKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Commit all", "git:commit")],
    [Markup.button.callback("↩️ Discard all", "git:discard")],
  ]);
}

function confirmDiscardKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⚠️ Yes, discard everything", "git:discard_confirm")],
    [Markup.button.callback("Cancel", "git:cancel")],
  ]);
}

/** Reply to /diff: show working-tree status + diff, with review buttons. */
export async function sendDiff(tg: Telegram, chatId: number): Promise<void> {
  const cwd = sessions.get(chatId).cwd;
  if (!(await git.isRepo(cwd))) {
    await tg.sendMessage(chatId, `📂 <code>${escapeHtml(cwd)}</code> is not a git repository.`, {
      parse_mode: "HTML",
    });
    return;
  }

  const files = await git.changedFiles(cwd);
  if (files.length === 0) {
    await tg.sendMessage(chatId, "✨ Working tree clean — nothing to review.");
    return;
  }

  const status = await git.status(cwd);
  const diff = await git.diff(cwd);
  const header = `<b>Changes in</b> <code>${escapeHtml(basename(cwd))}</code> (${files.length} file${files.length === 1 ? "" : "s"})\n<pre>${escapeHtml(status.out)}</pre>`;

  if (diff.out.length > DIFF_INLINE_LIMIT) {
    // Too big for a readable message — deliver as a .diff file with the buttons.
    await tg.sendMessage(chatId, header, { parse_mode: "HTML" });
    await tg.sendDocument(
      chatId,
      { source: Buffer.from(diff.out || "(no textual diff)"), filename: `${basename(cwd)}.diff` },
      { caption: "Review the changes, then choose an action:", ...reviewKeyboard() },
    );
    return;
  }

  await tg.sendMessage(chatId, `${header}\n<pre>${escapeHtml(diff.out)}</pre>`, {
    parse_mode: "HTML",
    ...reviewKeyboard(),
  });
}

export function isGitCallback(data: string): boolean {
  return data.startsWith("git:");
}

/**
 * Resolve a git review button press. Returns a short toast for answerCbQuery.
 * `edit` lets us swap the keyboard (e.g. to a discard confirmation) in place.
 */
export async function resolveGitCallback(
  tg: Telegram,
  chatId: number,
  data: string,
  messageId: number | undefined,
): Promise<string> {
  const action = data.slice("git:".length);
  const cwd = sessions.get(chatId).cwd;

  if (action === "discard") {
    if (messageId !== undefined) {
      await tg.editMessageReplyMarkup(
        chatId,
        messageId,
        undefined,
        confirmDiscardKeyboard().reply_markup,
      ).catch(() => {});
    }
    return "Confirm discard?";
  }

  if (action === "cancel") {
    if (messageId !== undefined) {
      await clearKeyboard(tg, chatId, messageId);
    }
    return "Cancelled";
  }

  if (action === "commit") {
    const message = `Update via Telegram — ${new Date().toISOString()}`;
    const res = await git.commitAll(cwd, message);
    log.info("Git commit via button", { chatId, ok: res.ok });
    await tg.sendMessage(
      chatId,
      res.ok ? `✅ Committed.\n<pre>${escapeHtml(res.out)}</pre>` : `⚠️ Commit failed.\n<pre>${escapeHtml(res.out)}</pre>`,
      { parse_mode: "HTML" },
    );
    if (messageId !== undefined) await clearKeyboard(tg, chatId, messageId);
    return res.ok ? "Committed" : "Commit failed";
  }

  if (action === "discard_confirm") {
    const res = await git.discardTracked(cwd);
    log.info("Git discard via button", { chatId, ok: res.ok });
    await tg.sendMessage(
      chatId,
      res.ok
        ? "↩️ Discarded changes to tracked files. (Untracked files were left in place.)"
        : `⚠️ Discard failed.\n<pre>${escapeHtml(res.out)}</pre>`,
      { parse_mode: "HTML" },
    );
    if (messageId !== undefined) await clearKeyboard(tg, chatId, messageId);
    return res.ok ? "Discarded" : "Discard failed";
  }

  return "";
}

async function clearKeyboard(tg: Telegram, chatId: number, messageId: number): Promise<void> {
  await tg.editMessageReplyMarkup(chatId, messageId, undefined, { inline_keyboard: [] }).catch(() => {});
}
