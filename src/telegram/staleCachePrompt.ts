import { Markup, type Telegram } from "telegraf";
import { config } from "../config.js";
import { sessions } from "../session/manager.js";
import { log } from "../logger.js";
import { t, langForChat } from "./i18n/index.js";

/**
 * Stale-cache guard. Anthropic's prompt cache keeps the conversation prefix
 * cheap to re-read, but only for a few minutes of inactivity. Come back to a
 * large conversation after the TTL and the whole prefix is re-cached at the
 * write rate (~1.25x input) — a real one-time cost on a 100k+ context. When
 * that's about to happen we post an inline "Continue vs Start fresh" offer and
 * hold the prompt back until the user decides (auto-continuing after a grace
 * period, since continuing is the non-destructive choice). Mirrors the
 * resume-after-restart offer (resumePrompt.ts).
 */

/** Auto-continue after this long if the user doesn't tap a button. */
const AUTO_CONTINUE_MS = 15_000;

const CB_PREFIX = "stc";

interface Pending {
  chatId: number;
  run: () => void;
  timeout: NodeJS.Timeout;
  messageId?: number;
}

/** One in-flight stale-cache offer per chat. */
const pending = new Map<number, Pending>();

function shortK(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
    : n >= 1_000
      ? `${Math.round(n / 1_000)}k`
      : String(n);
}

function offerKeyboard(lang: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(t("stale_cache_continue_btn", lang), `${CB_PREFIX}:continue`),
      Markup.button.callback(t("stale_cache_fresh_btn", lang), `${CB_PREFIX}:fresh`),
    ],
  ]);
}

/**
 * If this chat is returning to a large conversation after the cache TTL, post a
 * Continue/Start-fresh offer and defer `run` until the user decides. Returns
 * true when the offer was shown (caller should return); false when the cache is
 * still warm / the context is small / the guard is disabled (run normally).
 */
export async function maybeOfferStaleCache(
  tg: Telegram,
  chatId: number,
  run: () => void,
): Promise<boolean> {
  const warnTokens = config.CACHE_RECACHE_WARN_TOKENS;
  if (warnTokens <= 0 || config.CACHE_TTL_MS <= 0) return false;

  const s = sessions.get(chatId);
  // Nothing to reload without a persisted conversation, and no point warning
  // about a context we never measured or one that's small enough to be cheap.
  if (!s.sessionId) return false;
  if ((s.lastContextTokens ?? 0) < warnTokens) return false;
  if (!s.lastTurnAt) return false;

  const idleMs = Date.now() - s.lastTurnAt;
  if (idleMs < config.CACHE_TTL_MS) return false; // cache still warm — no cost hit

  // A second prompt while an offer is open: resolve the open one by continuing,
  // then let this prompt run normally.
  const existing = pending.get(chatId);
  if (existing) {
    finish(tg, chatId, "continue");
    return false;
  }

  const lang = langForChat(chatId);
  const tokens = s.lastContextTokens ?? 0;
  log.info("Offering stale-cache continue/fresh", { chatId, tokens, idleMin: Math.round(idleMs / 60_000) });
  const msg = await tg
    .sendMessage(
      chatId,
      t("stale_cache_offer", lang, {
        minutes: String(Math.max(1, Math.round(idleMs / 60_000))),
        tokens: shortK(tokens),
        seconds: String(AUTO_CONTINUE_MS / 1000),
      }),
      { parse_mode: "HTML", ...offerKeyboard(lang) },
    )
    .catch(() => undefined);

  const timeout = setTimeout(() => {
    log.info("Stale-cache offer timed out — continuing", { chatId });
    finish(tg, chatId, "continue");
  }, AUTO_CONTINUE_MS);
  timeout.unref?.();

  pending.set(chatId, { chatId, run, timeout, messageId: msg?.message_id });
  return true;
}

export function isStaleCacheCallback(data: string): boolean {
  return data.startsWith(`${CB_PREFIX}:`);
}

/** Resolve a stale-cache button press; returns a short toast for answerCbQuery. */
export function resolveStaleCacheCallback(tg: Telegram, chatId: number, data: string): string {
  const lang = langForChat(chatId);
  const action = data.slice(CB_PREFIX.length + 1) === "fresh" ? "fresh" : "continue";
  if (!pending.has(chatId)) return t("stale_cache_expired", lang);
  finish(tg, chatId, action);
  return action === "fresh" ? t("stale_cache_starting_fresh", lang) : t("stale_cache_continuing", lang);
}

/** Apply the decision: on "fresh" clear context first, then run the held prompt. */
function finish(tg: Telegram, chatId: number, action: "continue" | "fresh"): void {
  const entry = pending.get(chatId);
  if (!entry) return;
  pending.delete(chatId);
  clearTimeout(entry.timeout);

  if (action === "fresh") {
    sessions.reset(chatId);
    log.info("Session reset before turn — fresh chosen over re-cache", { chatId });
  }

  if (entry.messageId !== undefined) {
    const lang = langForChat(chatId);
    const note = action === "fresh" ? t("stale_cache_started_fresh", lang) : t("stale_cache_continued", lang);
    void tg.editMessageText(chatId, entry.messageId, undefined, note, { parse_mode: "HTML" }).catch(() => {});
  }

  entry.run();
}
