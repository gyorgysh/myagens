/**
 * Shared, user-facing error mapping for the Telegram bots. Extracted from
 * bot.ts so the Lead bots (leadBot.ts) render the same friendly messages —
 * rate-limit / usage-limit / auth failures should read the same whether they
 * come from Atlas or a Lead, not a raw stack for one and a clean line for the
 * other.
 */
import { loadProbeResult } from "../core/usageProbe.js";
import { t } from "./i18n/index.js";

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function fmtCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Build a usage-limit message from the live probe, or null when nothing is
 * actually exhausted. `strict` only reports a genuine 100%+ limit (used to
 * explain an otherwise-opaque process exit); the lenient form also surfaces the
 * soonest non-zero limit (used when the error text already says "limit").
 */
export function usageLimitMessage(strict: boolean, lang?: string): string | null {
  const probe = loadProbeResult();
  const now = Date.now();
  const exhausted = (probe?.limits ?? []).filter((l) => l.percent >= 100);
  const nearest = exhausted.sort((a, b) => a.resetsInMs - b.resetsInMs)[0];
  if (nearest) {
    const msLeft = Math.max(0, new Date(nearest.resetsAt).getTime() - now);
    return t("bot_usage_reached", lang, { label: nearest.label, countdown: fmtCountdown(msLeft) });
  }
  if (strict) return null;
  const soonest = (probe?.limits ?? [])
    .filter((l) => l.percent > 0)
    .sort((a, b) => a.resetsInMs - b.resetsInMs)[0];
  if (soonest) {
    const msLeft = Math.max(0, new Date(soonest.resetsAt).getTime() - now);
    return t("bot_usage_exhausted_label", lang, { label: soonest.label, countdown: fmtCountdown(msLeft) });
  }
  return t("bot_usage_exhausted", lang);
}

export function friendlyError(err: unknown, lang?: string): string {
  const raw = errText(err);
  const low = raw.toLowerCase();
  if (/\b429\b|rate.?limit/.test(low)) {
    return t("bot_err_rate_limited", lang);
  }
  if (
    /credit balance|insufficient|out of credit|quota|usage limit|limit reached|too low|daily.*limit|weekly.*limit|limit.*exceeded|reached.*limit/.test(
      low,
    )
  ) {
    return usageLimitMessage(false, lang)!;
  }
  if (/\b529\b|overloaded/.test(low)) {
    return t("bot_err_overloaded", lang);
  }
  if (/\b401\b|unauthorized|authentication|invalid.{0,12}api.?key|oauth|not logged in|login/.test(low)) {
    return t("bot_err_auth", lang);
  }
  // Must precede the generic /abort/ check: a stall-watchdog abort should say
  // the turn hung and was recovered, not read like a user-requested stop.
  if (/stall watchdog/.test(low)) return t("bot_err_stalled", lang);
  if (/abort/.test(low)) return t("bot_stopped", lang);
  // A non-zero CLI exit ("process exited with code 1") is often an opaque proxy
  // for a usage limit the SDK didn't spell out. If the live probe shows a limit
  // sitting at 100%, that's almost certainly the cause — say so instead of the
  // generic failure, so the user knows to wait for the reset rather than retry.
  if (/exited with code|exit code|process (?:exited|failed)|non-?zero/.test(low)) {
    const usage = usageLimitMessage(true, lang);
    if (usage) return usage;
  }
  const detail = raw.length > 600 ? raw.slice(0, 600) + "…" : raw;
  return t("bot_action_failed", lang, { detail });
}
