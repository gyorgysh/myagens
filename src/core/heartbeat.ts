import { getHealth } from "./health.js";
import { listTasks } from "./tasks.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";
import { log } from "../logger.js";
import {
  getPlanSettings,
  setPlanSettings,
  billingPeriodStart,
  daysUntilReset,
} from "./planSettings.js";
import { usageSummary } from "./snapshot.js";
import { loadProbeResult, runProbe } from "./usageProbe.js";
import { collectCalendarSignals, anyCalendarConnected } from "./calendarSignals.js";
import { detectAnomalies, ANOMALY_DEFAULTS, type AnomalyConfig } from "./anomaly.js";

const FILE = "heartbeat.json";
const TICK_MS = 60_000; // wake-up granularity; actual cadence is config.intervalMs
const ALERT_COOLDOWN_MS = 3 * 3_600_000; // don't repeat the same alert within 3h
const ALERT_HISTORY = 50;

export type HeartbeatMode = "off" | "alert" | "active";

export type HeartbeatSignalKey = "cpu" | "mem" | "swap" | "disk" | "stale" | "spend" | "calendar" | "anomaly";

export interface HeartbeatConfig {
  mode: HeartbeatMode;
  /** How often to evaluate signals. */
  intervalMs: number;
  /** Percent thresholds that trip an alert. */
  cpuPct: number;
  memPct: number;
  swapPct: number;
  diskPct: number;
  /** A card sitting in "doing" longer than this many hours is "stalled". */
  staleCardHours: number;
  /**
   * Whether to include a billing-spend signal in heartbeat checks.
   * Opt-in; off by default because SDK cost estimates are not meaningful
   * for Pro/Max subscription plans (they measure token cost, not subscription spend).
   */
  spendAlertEnabled: boolean;
  /**
   * Per-signal-type muting. Keys in this list are silently skipped even when
   * the global mode is alert/active. Allows turning off e.g. swap alerts
   * without disabling the whole heartbeat.
   */
  mutedSignals: HeartbeatSignalKey[];
  /**
   * Calendar-aware mode: when on (and a Google/Apple Calendar connector is
   * live), the heartbeat surfaces imminent events and scheduling conflicts.
   * Opt-in; off by default.
   */
  calendarEnabled: boolean;
  /** How far ahead (minutes) to scan the calendar for events. */
  calendarWindowMin: number;
  /** Flag events starting within this many minutes as "upcoming". */
  calendarLeadMin: number;
  /**
   * Quiet hours: HH:MM..HH:MM (server-local) during which no heartbeat
   * messages are sent (signals are still skipped). Empty = always on. A window
   * whose end is <= start wraps past midnight (e.g. 22:00..07:00).
   */
  quietStart?: string;
  quietEnd?: string;
  /**
   * Audit-log anomaly detection: scans the append-only action log for
   * suspicious patterns (delete bursts, off-hours vault access, new grants) and
   * surfaces findings as heartbeat signals. Opt-in; off by default.
   */
  anomaly: AnomalyConfig;
}

interface Signal {
  key: string;
  text: string;
}

/** Compact "time until reset" for usage-limit reports (e.g. "2h 13m", "5 days"). */
function fmtCountdown(ms: number): string {
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

/** True for a valid "HH:MM" 24h clock string. */
function isHHMM(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** Minutes since midnight for an "HH:MM" string (NaN if malformed). */
function hhmmToMin(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Whether `now` falls inside a [start, end) quiet window (server-local). Both
 * bounds must be set; a window whose end <= start wraps past midnight.
 */
function inQuietHours(start: string | undefined, end: string | undefined, now = new Date()): boolean {
  if (!start || !end || !isHHMM(start) || !isHHMM(end)) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = hhmmToMin(start);
  const e = hhmmToMin(end);
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

interface AlertRecord {
  ts: number;
  text: string;
}

interface HeartbeatFile {
  version: 1;
  config: HeartbeatConfig;
  lastTickAt?: number;
  lastAlertAt: Record<string, number>;
  alerts: AlertRecord[];
}

const DEFAULTS: HeartbeatConfig = {
  mode: "off",
  intervalMs: 30 * 60_000,
  cpuPct: 90,
  memPct: 90,
  swapPct: 50,
  diskPct: 90,
  staleCardHours: 48,
  spendAlertEnabled: false,
  mutedSignals: [],
  calendarEnabled: false,
  calendarWindowMin: 720, // 12h lookahead
  calendarLeadMin: 30,
  anomaly: { ...ANOMALY_DEFAULTS },
};

export interface HeartbeatDeps {
  /** Push a plain alert to the user(s). */
  notify: (text: string) => Promise<void>;
  /** Run an autonomous agent turn with the given prompt; false if skipped (busy). */
  runActive: (prompt: string) => Promise<boolean>;
}

/**
 * Proactive monitoring loop. Off by default. In `alert` mode it evaluates host
 * health + kanban signals deterministically and messages the user when a
 * threshold trips (deduped). In `active` mode it instead hands a snapshot to an
 * autonomous agent turn so the agent can investigate and act, messaging only
 * when noteworthy. Cadence is `config.intervalMs`, polled on a 60s tick.
 */
export class HeartbeatManager {
  private state = loadJson<HeartbeatFile>(FILE, {
    version: 1,
    config: { ...DEFAULTS },
    lastAlertAt: {},
    alerts: [],
  });
  private timer?: ReturnType<typeof setInterval>;
  private deps?: HeartbeatDeps;
  private running = false;

  start(deps: HeartbeatDeps): void {
    this.deps = deps;
    if (this.timer) return;
    this.timer = setInterval(() => void this.maybeTick(), TICK_MS);
    this.timer.unref?.();
    log.info("Heartbeat started", { mode: this.state.config.mode });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  view() {
    return {
      config: this.state.config,
      lastTickAt: this.state.lastTickAt,
      alerts: this.state.alerts.slice(0, ALERT_HISTORY),
    };
  }

  setConfig(patch: Partial<HeartbeatConfig>): HeartbeatConfig {
    const c = this.state.config;
    if (patch.mode && ["off", "alert", "active"].includes(patch.mode)) c.mode = patch.mode;
    if (typeof patch.intervalMs === "number") c.intervalMs = Math.max(60_000, patch.intervalMs);
    for (const k of ["cpuPct", "memPct", "swapPct", "diskPct", "staleCardHours"] as const) {
      if (typeof patch[k] === "number") c[k] = Math.max(0, patch[k]!);
    }
    if (typeof patch.spendAlertEnabled === "boolean") c.spendAlertEnabled = patch.spendAlertEnabled;
    if (Array.isArray(patch.mutedSignals)) {
      const valid: HeartbeatSignalKey[] = ["cpu", "mem", "swap", "disk", "stale", "spend", "calendar", "anomaly"];
      c.mutedSignals = patch.mutedSignals.filter((s): s is HeartbeatSignalKey => valid.includes(s as HeartbeatSignalKey));
    }
    if (typeof patch.calendarEnabled === "boolean") c.calendarEnabled = patch.calendarEnabled;
    if (typeof patch.calendarWindowMin === "number") c.calendarWindowMin = Math.max(15, patch.calendarWindowMin);
    if (typeof patch.calendarLeadMin === "number") c.calendarLeadMin = Math.max(1, patch.calendarLeadMin);
    if (patch.quietStart !== undefined) c.quietStart = isHHMM(patch.quietStart) ? patch.quietStart : undefined;
    if (patch.quietEnd !== undefined) c.quietEnd = isHHMM(patch.quietEnd) ? patch.quietEnd : undefined;
    if (patch.anomaly) {
      const a = c.anomaly ?? { ...ANOMALY_DEFAULTS };
      const p = patch.anomaly;
      if (typeof p.enabled === "boolean") a.enabled = p.enabled;
      if (typeof p.deleteWindowMin === "number") a.deleteWindowMin = Math.max(1, p.deleteWindowMin);
      if (typeof p.deleteThreshold === "number") a.deleteThreshold = Math.max(1, p.deleteThreshold);
      if (typeof p.lookbackMin === "number") a.lookbackMin = Math.max(1, p.lookbackMin);
      if (typeof p.workStart === "string" && isHHMM(p.workStart)) a.workStart = p.workStart;
      if (typeof p.workEnd === "string" && isHHMM(p.workEnd)) a.workEnd = p.workEnd;
      c.anomaly = a;
    }
    // Ensure fields exist on legacy configs loaded from disk.
    if (!Array.isArray(c.mutedSignals)) c.mutedSignals = [];
    if (typeof c.calendarEnabled !== "boolean") c.calendarEnabled = false;
    if (typeof c.calendarWindowMin !== "number") c.calendarWindowMin = 720;
    if (typeof c.calendarLeadMin !== "number") c.calendarLeadMin = 30;
    if (!c.anomaly || typeof c.anomaly !== "object") c.anomaly = { ...ANOMALY_DEFAULTS };
    this.persist();
    audit("heartbeat.config", { mode: c.mode, intervalMs: c.intervalMs });
    return c;
  }

  private async maybeTick(): Promise<void> {
    // Always run the cost report check regardless of heartbeat mode.
    void this.maybeSendCostReport();
    const c = this.state.config;
    if (c.mode === "off" || this.running) return;
    // Quiet hours: skip scheduled evaluation entirely so nothing is messaged.
    if (inQuietHours(c.quietStart, c.quietEnd)) return;
    const now = Date.now();
    if (this.state.lastTickAt && now - this.state.lastTickAt < c.intervalMs) return;
    await this.runOnce("scheduled");
  }

  /** Force an evaluation now (panel "Run check"). */
  async runOnce(_source: string): Promise<{ signals: number }> {
    if (this.running || !this.deps) return { signals: 0 };
    this.running = true;
    try {
      const signals = await this.collectSignals();
      this.state.lastTickAt = Date.now();
      if (signals.length === 0) {
        this.persist();
        return { signals: 0 };
      }
      if (this.state.config.mode === "active") {
        await this.handleActive(signals);
      } else {
        await this.handleAlert(signals);
      }
      this.persist();
      return { signals: signals.length };
    } catch (err) {
      log.error("Heartbeat tick failed", { error: err instanceof Error ? err.message : String(err) });
      return { signals: 0 };
    } finally {
      this.running = false;
    }
  }

  private async collectSignals(): Promise<Signal[]> {
    const c = this.state.config;
    const muted = new Set(c.mutedSignals ?? []);
    const out: Signal[] = [];
    try {
      const h = await getHealth();
      if (!muted.has("cpu") && h.cpu.load >= c.cpuPct) out.push({ key: "cpu", text: `CPU load ${h.cpu.load.toFixed(0)}% (≥ ${c.cpuPct}%)` });
      const memPct = h.mem.total ? (h.mem.used / h.mem.total) * 100 : 0;
      if (!muted.has("mem") && memPct >= c.memPct) out.push({ key: "mem", text: `Memory ${memPct.toFixed(0)}% used (≥ ${c.memPct}%)` });
      const swapPct = h.swap.total ? (h.swap.used / h.swap.total) * 100 : 0;
      if (!muted.has("swap") && swapPct >= c.swapPct) out.push({ key: "swap", text: `Swap ${swapPct.toFixed(0)}% used (≥ ${c.swapPct}%)` });
      if (!muted.has("disk")) {
        for (const d of h.disks) {
          if (d.usePct >= c.diskPct) out.push({ key: `disk:${d.mount}`, text: `Disk ${d.mount} ${d.usePct.toFixed(0)}% full (≥ ${c.diskPct}%)` });
        }
      }
    } catch (err) {
      log.warn("Heartbeat health probe failed", { error: err instanceof Error ? err.message : String(err) });
    }
    if (!muted.has("stale")) {
      const staleMs = c.staleCardHours * 3_600_000;
      const now = Date.now();
      for (const t of listTasks()) {
        if (t.column === "doing" && now - t.updatedAt > staleMs) {
          const days = Math.floor((now - t.updatedAt) / 86_400_000);
          out.push({ key: `stale:${t.id}`, text: `Task "${t.title}" stalled in Doing for ${days}d` });
        }
      }
    }
    // Cost/budget alert — only when explicitly enabled and only for API (pay-per-token) plans.
    // Pro/Max subscription plans report SDK token-cost estimates that don't represent real spend.
    if (c.spendAlertEnabled && !muted.has("spend")) {
      try {
        const plan = getPlanSettings();
        if (plan.plan === "api" && plan.alertThresholdPct > 0 && plan.monthlyCap > 0) {
          const summary = usageSummary();
          const periodStart = billingPeriodStart(plan.billingDay);
          const periodCost = summary.daily
            .filter((d) => d.day >= periodStart)
            .reduce((acc, d) => acc + d.costUsd, 0);
          const pct = (periodCost / plan.monthlyCap) * 100;
          if (pct >= plan.alertThresholdPct) {
            out.push({
              key: "cost:cap",
              text: `Spend this billing period: $${periodCost.toFixed(2)} of $${plan.monthlyCap} (${pct.toFixed(0)}%)`,
            });
          }
        }
      } catch {
        // Non-fatal if plan check fails.
      }
    }
    // Calendar-aware signals: imminent events + scheduling conflicts.
    if (c.calendarEnabled && !muted.has("calendar") && anyCalendarConnected()) {
      try {
        const calSignals = await collectCalendarSignals({
          windowMs: c.calendarWindowMin * 60_000,
          leadMs: c.calendarLeadMin * 60_000,
        });
        for (const s of calSignals) out.push({ key: s.key, text: s.text });
      } catch (err) {
        log.warn("Heartbeat calendar probe failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    // Audit-log anomaly detection: delete bursts, off-hours vault access, new grants.
    if (!muted.has("anomaly") && c.anomaly?.enabled) {
      try {
        for (const a of detectAnomalies(c.anomaly)) {
          const sev = a.severity === "critical" ? "🔴" : "🟠";
          out.push({ key: `anomaly:${a.key}`, text: `${sev} Anomaly: ${a.text}` });
        }
      } catch (err) {
        log.warn("Heartbeat anomaly scan failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  /** Send a periodic cost report if the configured interval has elapsed. */
  async maybeSendCostReport(): Promise<void> {
    const plan = getPlanSettings();
    if (!plan.costCheckIntervalMs) return;
    const now = Date.now();
    if (now - (plan.lastCostCheckAt ?? 0) < plan.costCheckIntervalMs) return;
    // Mark first so a slow send doesn't double-fire.
    setPlanSettings({ lastCostCheckAt: now });
    await this.sendCostReport();
  }

  /**
   * Build and send a usage report now, regardless of the configured interval.
   * Used by the periodic tick and by the panel "Test" button.
   *
   * Pro/Max subscribers get a subscription-limits report (the dollar "spend vs
   * cap" figure is a misleading token-cost estimate for flat-rate plans), while
   * API (pay-per-token) users get the billing-period spend report.
   */
  async sendCostReport(): Promise<{ sent: boolean }> {
    if (!this.deps) return { sent: false };
    try {
      const text = await this.buildCostReport();
      await this.deps.notify(text);
      return { sent: true };
    } catch (err) {
      log.warn("Cost report failed", { error: err instanceof Error ? err.message : String(err) });
      return { sent: false };
    }
  }

  private async buildCostReport(): Promise<string> {
    const plan = getPlanSettings();
    const summary = usageSummary();

    // Prefer live OAuth probe data; refresh it when missing or stale.
    let probe = loadProbeResult();
    const ageMs = probe ? Date.now() - new Date(probe.probedAt).getTime() : Infinity;
    if (!probe || ageMs > 5 * 60_000) {
      probe = await runProbe().catch(() => probe);
    }

    const isSubscriber =
      probe?.account?.hasPro || probe?.account?.hasMax || plan.plan === "pro" || plan.plan === "max";

    const planLabel = probe?.account?.hasMax
      ? "Claude Max"
      : probe?.account?.hasPro
        ? "Claude Pro"
        : plan.plan === "max"
          ? "Claude Max"
          : plan.plan === "pro"
            ? "Claude Pro"
            : "API";

    if (isSubscriber) {
      // Subscription-limits report (mirrors /usage), no dollar cap.
      const lines = [`📊 Usage report (${planLabel})`];
      if (probe?.source === "oauth" && probe.limits.length > 0) {
        for (const lim of probe.limits) {
          const msLeft = Math.max(0, new Date(lim.resetsAt).getTime() - Date.now());
          const sev = lim.severity === "critical" ? "🔴" : lim.severity === "warning" ? "🟡" : "🟢";
          lines.push(`${sev} ${lim.label}: ${lim.percent}% · resets in ${fmtCountdown(msLeft)}`);
        }
      } else {
        lines.push("No live subscription-limit data available.");
      }
      lines.push(`Today: ${summary.today.turns} turn${summary.today.turns === 1 ? "" : "s"}`);
      return lines.join("\n");
    }

    // API (pay-per-token): billing-period spend report.
    const periodStart = billingPeriodStart(plan.billingDay);
    const periodCost = summary.daily
      .filter((d) => d.day >= periodStart)
      .reduce((acc, d) => acc + d.costUsd, 0);
    const days = daysUntilReset(plan.billingDay);
    const pct = plan.monthlyCap > 0 ? (periodCost / plan.monthlyCap) * 100 : 0;
    const lines = [
      `📊 Usage report (${planLabel})`,
      plan.monthlyCap > 0
        ? `Period spend: $${periodCost.toFixed(2)} / $${plan.monthlyCap} (${pct.toFixed(0)}%)`
        : `Period spend: $${periodCost.toFixed(2)}`,
      `Today: $${summary.today.costUsd.toFixed(4)} · ${summary.today.turns} turns`,
      `Billing resets in ${days} day${days === 1 ? "" : "s"}.`,
    ];
    return lines.join("\n");
  }

  /** Deterministic alerts, deduped by signal key within the cooldown window. */
  private async handleAlert(signals: Signal[]): Promise<void> {
    const now = Date.now();
    const fresh = signals.filter((s) => now - (this.state.lastAlertAt[s.key] ?? 0) > ALERT_COOLDOWN_MS);
    if (fresh.length === 0) return;
    for (const s of fresh) this.state.lastAlertAt[s.key] = now;
    const text = `🫀 Heartbeat\n${fresh.map((s) => `• ${s.text}`).join("\n")}`;
    this.recordAlert(text);
    await this.deps!.notify(text);
  }

  /** Hand the snapshot to an autonomous agent turn (it decides what to do). */
  private async handleActive(signals: Signal[]): Promise<void> {
    const prompt =
      "Proactive heartbeat check. The following signals were detected on the host:\n" +
      signals.map((s) => `- ${s.text}`).join("\n") +
      "\n\nBriefly investigate if useful. Message me only if something genuinely needs my attention or action; otherwise stay silent.";
    const started = await this.deps!.runActive(prompt);
    if (started) this.recordAlert(`🫀 Active check dispatched (${signals.length} signal(s))`);
  }

  private recordAlert(text: string): void {
    this.state.alerts.unshift({ ts: Date.now(), text });
    if (this.state.alerts.length > ALERT_HISTORY) this.state.alerts.length = ALERT_HISTORY;
  }

  private persist(): void {
    saveJson<HeartbeatFile>(FILE, this.state);
  }
}

export const heartbeat = new HeartbeatManager();
