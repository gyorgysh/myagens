import { Markup, type Telegram } from "telegraf";
import { log } from "../logger.js";
import { t, langForChat } from "./i18n/index.js";
import { runRestore, isUpdating, type RunScriptResult } from "../core/updateControl.js";
import { serviceInstalled } from "../core/agentControl.js";
import { escapeHtml } from "./formatting.js";

/**
 * Report how an update/restore/reload script ended.
 *
 * A success on a serviced host usually never gets here — the restart kills this
 * process mid-run, and the "back online" restart marker (consumed in bot.ts at
 * boot) closes that loop instead. A FAILURE is the opposite: the script bails
 * before the restart step, so we are still alive and the user hears nothing
 * unless we speak. This used to be gated on `!serviceInstalled()`, which meant a
 * failed update on the hosts that matter most was completely silent — you saw
 * "Reloading…" and then nothing, forever.
 */
export async function reportScriptOutcome(
  tg: Telegram,
  chatId: number,
  lang: string,
  result: RunScriptResult,
  what: string,
  doneText: string,
): Promise<void> {
  if (result.ok) {
    // On a serviced host the restart message is the more accurate one, and the
    // marker announces the new version once it is actually back.
    if (!serviceInstalled()) await tg.sendMessage(chatId, doneText).catch(() => {});
    return;
  }
  const tail = result.tail.join("\n").slice(-1500) || "(no output)";
  await tg
    .sendMessage(chatId, t("update_run_failed", lang, { what, tail: escapeHtml(tail) }), {
      parse_mode: "HTML",
    })
    .catch(() => {});
}

/**
 * `/reload`: the rescue/self-heal path, identical on Atlas and every Lead bot.
 * Unlike `/update` and `/restore` (Atlas-only, text-argument confirm), this is
 * a single unambiguous action — discard local tracked-file changes, pull the
 * latest commit, rebuild, restart — reachable from any bot regardless of that
 * bot's autonomy/permission level, since it's a direct command handler that
 * never goes through `runUserPrompt`/`canUseTool` (same bypass as `/commit` and
 * `/diff`). Also reused as the "Accept" action on the update-notify prompt
 * (`src/core/updateNotify.ts`), so accepting a detected version bump runs the
 * exact same path a manual `/reload` would.
 */

function confirmKeyboard(lang: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t("reload_confirm_btn", lang), "reload:yes")],
    [Markup.button.callback(t("reload_cancel_btn", lang), "reload:no")],
  ]);
}

/** Send the /reload explanation with an inline Yes/No confirm. */
export async function sendReloadPrompt(tg: Telegram, chatId: number): Promise<void> {
  const lang = langForChat(chatId);
  if (isUpdating()) {
    await tg.sendMessage(chatId, t("reload_running", lang));
    return;
  }
  await tg.sendMessage(chatId, t("reload_explain", lang), {
    parse_mode: "HTML",
    ...confirmKeyboard(lang),
  });
}

export function isReloadCallback(data: string): boolean {
  return data === "reload:yes" || data === "reload:no";
}

/** Resolve a /reload confirm button press. Returns a short toast for answerCbQuery. */
export async function resolveReloadCallback(
  tg: Telegram,
  chatId: number,
  data: string,
  messageId: number | undefined,
): Promise<string> {
  const lang = langForChat(chatId);
  if (messageId !== undefined) {
    await tg
      .editMessageReplyMarkup(chatId, messageId, undefined, { inline_keyboard: [] })
      .catch(() => {});
  }
  if (data === "reload:no") {
    return t("reload_cancelled", lang);
  }
  if (isUpdating()) {
    await tg.sendMessage(chatId, t("reload_running", lang)).catch(() => {});
    return t("reload_running", lang);
  }
  const note = serviceInstalled()
    ? t("reload_starting_service", lang)
    : t("reload_starting_manual", lang);
  await tg
    .sendMessage(chatId, `${t("reload_starting", lang)}\n${note}`, { parse_mode: "HTML" })
    .catch(() => {});
  log.warn("Reload triggered from Telegram", { chatId });
  // Fire-and-forget: on a serviced host this process is replaced mid-run.
  void runRestore((line) => log.info(`[reload] ${line}`))
    .then(async (r) => {
      await reportScriptOutcome(tg, chatId, lang, r, "Reload", t("reload_done", lang));
    })
    .catch(() => {});
  return t("reload_started_toast", lang);
}
