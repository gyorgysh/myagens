/**
 * "Is this backend near its limit?", for the failover paths.
 *
 * Two backends publish their own utilisation: Claude through the OAuth probe
 * (usageProbe.ts) and Codex through its session transcripts (codexUsage.ts).
 * That is enough to answer two questions the fallback logic could not ask
 * before:
 *
 *  - the primary is nearly spent, switch *away* from it early
 *    (core/mainSettings.ts, resolveMainRunFor). Until now this only worked when
 *    the primary was Claude, so a codex-primary install had no proactive
 *    failover at all;
 *  - the fallback target is itself spent, so switching *into* it would only
 *    trade one limit error for another (both fallback paths).
 *
 * **Freshness matters and differs between the two sources.** The Claude probe is
 * refreshed on a schedule, so its reading is always current. Codex's is written
 * only when codex runs: current when codex is the primary and every turn updates
 * it, potentially days old when codex sits unused as a fallback target. So a
 * stale codex reading is never trusted to *block* a failover — a wrong "it is
 * exhausted" would strand the user on a primary that is already failing. It is
 * blocked only on a recent reading, and otherwise we try and let the reactive
 * path deal with a real 429.
 */

import { loadProbeResult } from "./usageProbe.js";
import { readCodexUsage } from "./codexUsage.js";
import { log } from "../logger.js";

/** Backends whose limits we can read at all. */
const CLAUDE_BACKENDS = new Set(["claude-agent-sdk", "claude-tmux", undefined]);
const CODEX_BACKEND = "codex-cli";

/**
 * How recent a codex reading must be to justify blocking a failover into codex.
 * Its shortest window is five hours, so a reading older than this says little
 * about the situation now.
 */
const CODEX_BLOCK_MAX_AGE_MS = 6 * 60 * 60_000;

export interface LimitReading {
  /** A window is at or past the threshold. */
  over: boolean;
  /** Which window, for the log line and the degraded banner. */
  label?: string;
  percent?: number;
  /** Claude only: the account may bill overage instead of stopping. */
  extraUsageEnabled?: boolean;
  /** Age of the underlying data. 0 when there is nothing time-sensitive. */
  ageMs?: number;
  /** False when this backend publishes nothing we can read. */
  known: boolean;
}

const UNKNOWN: LimitReading = { over: false, known: false };

/** Worst window at or past `threshold`, ignoring any whose reset has passed. */
function worstOver(
  limits: Array<{ percent: number; label: string; resetsAt?: string }>,
  threshold: number,
): { label: string; percent: number } | undefined {
  const now = Date.now();
  let worst: { label: string; percent: number } | undefined;
  for (const lim of limits) {
    if (lim.percent < threshold) continue;
    if (worst && lim.percent <= worst.percent) continue;
    if (lim.resetsAt) {
      const resetTime = new Date(lim.resetsAt).getTime();
      if (!isNaN(resetTime) && now >= resetTime) {
        log.info("Limit reset time passed — ignoring stale cached limit", {
          label: lim.label,
          resetsAt: lim.resetsAt,
        });
        continue;
      }
    }
    worst = { label: lim.label, percent: lim.percent };
  }
  return worst;
}

function claudeReading(threshold: number): LimitReading {
  const probe = loadProbeResult();
  if (!probe || !probe.limits.length) return UNKNOWN;
  const worst = worstOver(probe.limits, threshold);
  return {
    over: Boolean(worst),
    label: worst?.label,
    percent: worst?.percent,
    extraUsageEnabled: probe.extraUsageEnabled,
    ageMs: probe.probedAt ? Math.max(0, Date.now() - new Date(probe.probedAt).getTime()) : undefined,
    known: true,
  };
}

function codexReading(threshold: number): LimitReading {
  const codex = readCodexUsage();
  if (!codex || !codex.limits.length) return UNKNOWN;
  const ageMs = Math.max(0, Date.now() - new Date(codex.observedAt).getTime());
  // Codex saying it actually hit a limit outranks any threshold comparison.
  if (codex.limitReached) {
    return { over: true, label: codex.limitReached, percent: 100, ageMs, known: true };
  }
  const worst = worstOver(codex.limits, threshold);
  return {
    over: Boolean(worst),
    label: worst?.label,
    percent: worst?.percent,
    ageMs,
    known: true,
  };
}

/**
 * How close `backendId` is to its own limit. `known: false` means the backend
 * publishes nothing readable (grok, cursor, agy, ollama), which callers must
 * treat as "no reason to act", never as "it is fine".
 */
export function backendLimitReading(backendId: string | undefined, threshold: number): LimitReading {
  if (CLAUDE_BACKENDS.has(backendId)) return claudeReading(threshold);
  if (backendId === CODEX_BACKEND) return codexReading(threshold);
  return UNKNOWN;
}

/**
 * True when failing over *into* `backendId` is pointless because it is already
 * spent. Deliberately conservative: only a known, fresh, over-threshold reading
 * counts, so an unreadable or stale one lets the attempt go ahead.
 */
export function fallbackTargetExhausted(
  backendId: string | undefined,
  threshold: number,
): { exhausted: boolean; label?: string; percent?: number } {
  const r = backendLimitReading(backendId, threshold);
  if (!r.known || !r.over) return { exhausted: false };
  if (r.ageMs !== undefined && r.ageMs > CODEX_BLOCK_MAX_AGE_MS && backendId === CODEX_BACKEND) {
    log.info("Fallback target looks spent but the reading is stale — trying it anyway", {
      backendId,
      ageMin: Math.round(r.ageMs / 60_000),
      percent: r.percent,
    });
    return { exhausted: false };
  }
  return { exhausted: true, label: r.label, percent: r.percent };
}
