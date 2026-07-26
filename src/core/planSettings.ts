import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";

const FILE = "planSettings.json";

export type PlanType = "pro" | "max" | "api";

/**
 * Subscription plan and budget configuration. Drives the cost tracker in the
 * Usage and Health panels and optional Telegram cost-report notifications.
 */
export interface PlanSettings {
  /** pro = Claude Pro ($20/mo flat), max = Claude Max ($100/mo), api = pay-per-token (default). */
  plan: PlanType;
  /** Monthly spend cap in USD. Auto-set to 20 when plan === "pro". */
  monthlyCap: number;
  /** Day of month (1-28) the billing cycle resets. */
  billingDay: number;
  /** Alert when period spend reaches this % of monthlyCap (0 = off). */
  alertThresholdPct: number;
  /** Optional hard daily cap in USD (0 = no limit). */
  dailyCapUsd?: number;
  /** Optional hard weekly cap in USD (0 = no limit). */
  weeklyCapUsd?: number;
  /**
   * How often (in ms) to send a Telegram cost-report notification.
   * 0 / undefined = never. E.g. 21600000 = every 6 hours.
   */
  costCheckIntervalMs?: number;
  /** Timestamp of the last automatic cost-report notification. */
  lastCostCheckAt?: number;
  /**
   * How often (in ms) to run the OAuth usage probe (reads live session/weekly
   * limits from the Anthropic API). Default: 1 800 000 (30 min).
   * 0 = probe disabled.
   */
  probeIntervalMs: number;
  /**
   * Per-source visibility for the usage-limit cards (see core/usageSources.ts).
   * A missing entry follows detection — shown when there is data for it — so
   * this only ever holds a deliberate override.
   */
  usageCards?: Partial<Record<"claude" | "codex", boolean>>;
}

interface PlanFile {
  version: 1;
  settings: PlanSettings;
}

const DEFAULTS: PlanSettings = {
  plan: "api",
  monthlyCap: 0,
  billingDay: 1,
  alertThresholdPct: 80,
  probeIntervalMs: 30 * 60 * 1000, // 30 minutes
};

function load(): PlanSettings {
  const f = loadJson<PlanFile>(FILE, { version: 1, settings: DEFAULTS });
  return { ...DEFAULTS, ...f.settings };
}

export function getPlanSettings(): PlanSettings {
  return load();
}

export function setPlanSettings(patch: Partial<PlanSettings>): PlanSettings {
  const s = load();
  const next: PlanSettings = { ...s, ...patch };
  // Auto-set sensible cap defaults when switching plan.
  if (patch.plan === "pro" && !patch.monthlyCap) next.monthlyCap = 20;
  if (patch.plan === "max" && !patch.monthlyCap) next.monthlyCap = 100;
  if (patch.probeIntervalMs !== undefined) next.probeIntervalMs = Math.max(0, patch.probeIntervalMs);
  if (patch.usageCards) {
    // Ids are spelled out rather than imported from usageSources.ts, which reads
    // these settings and would make the import circular.
    const clean: Partial<Record<"claude" | "codex", boolean>> = {};
    for (const id of ["claude", "codex"] as const) {
      const v = patch.usageCards[id];
      if (typeof v === "boolean") clean[id] = v;
    }
    next.usageCards = { ...s.usageCards, ...clean };
  }
  next.billingDay = Math.max(1, Math.min(28, next.billingDay));
  next.alertThresholdPct = Math.max(0, Math.min(100, next.alertThresholdPct));
  saveJson<PlanFile>(FILE, { version: 1, settings: next });
  audit("plan.update", { plan: next.plan });
  return next;
}

/**
 * Return the start of the current billing period as a YYYY-MM-DD string.
 * Example: billingDay=15, today=June 20 → "2025-06-15"
 *          billingDay=15, today=June 10 → "2025-05-15"
 */
export function billingPeriodStart(billingDay: number): string {
  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth(), billingDay);
  if (candidate > now) {
    // Haven't reached the billing day this month yet, step back one month.
    candidate.setMonth(candidate.getMonth() - 1);
  }
  // Format from LOCAL calendar components. toISOString() would convert to UTC and
  // return the previous day for any UTC+ timezone (local midnight of the Nth is
  // the (N-1)th in UTC), which shifted the period start a day early and inflated
  // every period-spend / cap-percentage comparison for half the world.
  const y = candidate.getFullYear();
  const m = String(candidate.getMonth() + 1).padStart(2, "0");
  const d = String(candidate.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Days remaining until the next billing cycle reset. */
export function daysUntilReset(billingDay: number): number {
  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth(), billingDay);
  if (candidate <= now) candidate.setMonth(candidate.getMonth() + 1);
  return Math.ceil((candidate.getTime() - now.getTime()) / 86_400_000);
}
