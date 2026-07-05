import { Markup, type Telegram } from "telegraf";
import { log } from "../logger.js";
import { t, langForChat } from "./i18n/index.js";
import { runRestore, isUpdating } from "../core/updateControl.js";
import { serviceInstalled } from "../core/agentControl.js";

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
      if (!serviceInstalled()) {
        await tg
          .sendMessage(chatId, r.ok ? t("reload_done", lang) : t("reload_failed", lang))
          .catch(() => {});
      }
    })
    .catch(() => {});
  return t("reload_started_toast", lang);
}
