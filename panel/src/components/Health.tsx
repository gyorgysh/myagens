import { useEffect, useRef, useState } from "react";
import {
  openHealthSocket,
  api,
  type Health,
  type MaintenanceStats,
  type ProbeResult,
  type UsageLimitWindow,
} from "../api.ts";
import { Bar, Card, Button, Empty, Metric } from "./ui.tsx";
import { bytes, bytesPerSec, duration, relTime, friendlyProbeError } from "../lib/format.ts";
import { useI18n } from "../lib/useI18n.ts";
import type { TranslationKey } from "../i18n/en.ts";

type ConnStatus = "connecting" | "live" | "down";

/** Translate the server-supplied usage-limit label when it matches a known default. */
function limitLabel(label: string, t: (k: TranslationKey) => string): string {
  if (label === "5-hour session") return t("limit_5h");
  if (label === "7-day weekly") return t("limit_7d");
  return label;
}

// ---------------------------------------------------------------------------
// Root view
// ---------------------------------------------------------------------------

export function HealthView() {
  const { t } = useI18n();
  const [health, setHealth] = useState<Health | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const retryRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let closed = false;
    let ws: WebSocket;
    const connect = () => {
      if (closed) return;
      setStatus((s) => (s === "live" ? s : "connecting"));
      ws = openHealthSocket();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as { type: string; data: Health };
          if (msg.type === "health") { setHealth(msg.data); setStatus("live"); }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        if (closed) return;
        setStatus("down");
        retryRef.current = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => { closed = true; clearTimeout(retryRef.current); ws?.close(); };
  }, []);

  if (!health) {
    return <Empty>{status === "down" ? t("reconnecting") : t("connecting")}</Empty>;
  }

  const memPct = health.mem.total ? (health.mem.used / health.mem.total) * 100 : 0;
  const swapPct = health.swap.total ? (health.swap.used / health.swap.total) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Host info bar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
        <span className="font-medium text-fg">{health.host}</span>
        <span className="text-fg-faint">·</span>
        <span>{health.platform}</span>
        <span className="text-fg-faint">·</span>
        <span>{t("health_up")} {duration(health.uptimeSec)}</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs">
          <span className={`inline-block h-2 w-2 rounded-full ${status === "live" ? "bg-emerald-500" : "bg-amber-500"}`} />
          {status === "live" ? t("health_live") : t("health_reconnecting")}
        </span>
      </div>

      {/* Claude usage: real OAuth data */}
      <ClaudeUsageCard />

      {/* System metrics */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card><Metric label={t("health_cpu")} value={`${health.cpu.load.toFixed(0)}%`} sub={`${t("health_load")} ${health.cpu.loadAvg.map((n) => n.toFixed(2)).join(" ")}${health.cpu.tempC ? ` · ${health.cpu.tempC}°C` : ""}`} pct={health.cpu.load} /></Card>
        <Card><Metric label={t("health_memory")} value={`${memPct.toFixed(0)}%`} sub={`${bytes(health.mem.used)} / ${bytes(health.mem.total)}`} pct={memPct} /></Card>
        <Card><Metric label={t("health_swap")} value={health.swap.total ? `${swapPct.toFixed(0)}%` : "—"} sub={health.swap.total ? `${bytes(health.swap.used)} / ${bytes(health.swap.total)}` : t("health_none")} pct={swapPct} /></Card>
        <Card><Metric label={t("health_disk_io")} value={bytesPerSec((health.io.readBytesSec ?? 0) + (health.io.writeBytesSec ?? 0) || undefined)} sub={`r ${bytesPerSec(health.io.readBytesSec)} · w ${bytesPerSec(health.io.writeBytesSec)}`} /></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t("health_cores")}>
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {health.cpu.cores.map((load, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="tabular w-10 shrink-0 text-xs text-fg-dim">#{i}</span>
                <Bar pct={load} />
                <span className="tabular w-9 shrink-0 text-right text-xs text-fg-muted">{load.toFixed(0)}%</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title={t("health_filesystems")}>
          <div className="space-y-3">
            {health.disks.map((d) => (
              <div key={d.mount}>
                <div className="mb-1 flex items-baseline justify-between text-sm">
                  <span className="truncate font-mono text-xs text-fg-muted">{d.mount}</span>
                  <span className="tabular text-xs text-fg-dim">{bytes(d.used)} / {bytes(d.size)} · {d.usePct.toFixed(0)}%</span>
                </div>
                <Bar pct={d.usePct} />
              </div>
            ))}
          </div>
        </Card>
      </div>

      <MaintenanceCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Claude usage card
// ---------------------------------------------------------------------------

function barColor(severity: UsageLimitWindow["severity"]): string {
  if (severity === "critical") return "bg-red-500";
  if (severity === "warning") return "bg-amber-400";
  return "bg-accent";
}

function textColor(severity: UsageLimitWindow["severity"]): string {
  if (severity === "critical") return "text-red-400";
  if (severity === "warning") return "text-amber-400";
  return "text-emerald-400";
}

function formatResets(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function subLabel(type?: string): string {
  if (!type) return "";
  const t = type.toLowerCase();
  if (t === "pro") return "Claude Pro";
  if (t.includes("max")) return "Claude Max";
  return type;
}

function LimitBar({ lim }: { lim: UsageLimitWindow }) {
  const { t } = useI18n();
  const pct = Math.min(100, lim.percent);
  const color = barColor(lim.severity);
  const tc = textColor(lim.severity);

  // Recompute the live "resets in" from resetsAt each render
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const resetsInMs = Math.max(0, new Date(lim.resetsAt).getTime() - Date.now());

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-fg-dim">{limitLabel(lim.label, t)}</span>
        <span className={`text-xl font-bold tabular ${tc}`}>{lim.percent}%</span>
      </div>
      <div className="h-3 w-full rounded-full bg-surface-2 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-fg-faint">{t("health_used")}</span>
        <span className={`font-medium ${resetsInMs < 600_000 ? "text-amber-400" : "text-fg-dim"}`}>
          {t("health_resets_in").replace("{time}", formatResets(resetsInMs))}
        </span>
      </div>
    </div>
  );
}

function ClaudeUsageCard() {
  const { t } = useI18n();
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = () =>
    api.usageProbe()
      .then(setProbe)
      .catch(() => {})
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkNow = async () => {
    setRunning(true);
    await api.runProbe().catch(() => {});
    // Poll for the result to appear (probe runs async).
    let attempts = 0;
    const poll = setInterval(async () => {
      await load();
      attempts++;
      if (attempts >= 15) clearInterval(poll);
    }, 2000);
    setTimeout(() => { clearInterval(poll); setRunning(false); }, 30_000);
  };

  const isProbedRecently = probe?.probedAt
    ? Date.now() - new Date(probe.probedAt).getTime() < 120_000
    : false;

  const account = probe?.account;
  const planLabel =
    account?.hasMax ? "Claude Max" :
    account?.hasPro ? "Claude Pro" :
    account?.subscriptionType ? subLabel(account.subscriptionType) : null;

  return (
    <Card
      title="Claude"
      right={
        <div className="flex items-center gap-2">
          {planLabel && (
            <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-medium text-accent">
              {planLabel}
            </span>
          )}
          <Button onClick={checkNow} disabled={running || loading}>
            {running ? t("health_checking") : t("health_check_now")}
          </Button>
        </div>
      }
    >
      {loading && !probe ? (
        <p className="text-sm text-fg-faint">{t("health_loading")}</p>
      ) : probe?.source === "none" || !probe ? (
        <p className="text-sm text-fg-faint">{t("health_no_probe")}</p>
      ) : (
        <div className="space-y-5">
          {/* Error / fallback / stale notice */}
          {(probe.error || probe.stale || probe.source === "fallback") && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
              {friendlyProbeError(probe.error) ?? t("health_oauth_fallback")}
            </div>
          )}

          {/* The 2 limit bars */}
          {probe.limits.length > 0 ? (
            <div className="grid gap-6 sm:grid-cols-2">
              {probe.limits.slice(0, 2).map((lim) => (
                <LimitBar key={lim.label} lim={lim} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-fg-faint">
              {t("health_no_live_limit")}{" "}
              {/* Only blame the keychain when that's actually the cause — not when
                  a refresh just failed (e.g. rate limited). */}
              {probe.error
                ? null
                : probe.source === "fallback"
                  ? t("health_oauth_not_found")
                  : t("health_no_active_limits")}
            </p>
          )}

          {/* Historical activity footer */}
          {probe.activity && (
            <div className="flex flex-wrap gap-x-5 gap-y-0.5 text-xs text-fg-faint border-t border-line pt-3">
              <span>
                <span className="text-fg-dim font-medium">{probe.activity.messageCount.toLocaleString()}</span>{" "}
                {t("health_messages")} ({probe.activity.lastDate})
              </span>
              <span>
                <span className="text-fg-dim font-medium">{probe.activity.weeklyMessageCount.toLocaleString()}</span>{" "}
                {t("health_this_week")}
              </span>
              <span>
                <span className="text-fg-dim font-medium">{probe.activity.toolCallCount.toLocaleString()}</span>{" "}
                {t("health_tool_calls")}
              </span>
              {probe.probedAt && (
                <span className="ml-auto">
                  {isProbedRecently ? t("health_just_now") : t("health_checked").replace("{time}", relTime(new Date(probe.probedAt).getTime()))}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Maintenance card
// ---------------------------------------------------------------------------

function MaintenanceCard() {
  const { t } = useI18n();
  const [stats, setStats] = useState<MaintenanceStats | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => { api.maintenance().then(setStats).catch(() => {}); }, []);

  const run = async () => {
    setRunning(true);
    try { setStats(await api.runMaintenance()); } finally { setRunning(false); }
  };

  return (
    <Card
      title={t("health_maintenance")}
      right={<Button onClick={run} disabled={running}>{running ? t("health_maintenance_running") : t("health_maintenance_run")}</Button>}
    >
      <p className="mb-3 text-sm text-fg-dim">
        {t("health_maint_desc_pre")}<code>MAINTENANCE_CRON=HH:MM</code>{t("health_maint_desc_post")}
      </p>
      {stats ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
          <div><span className="text-fg-faint">{t("health_maintenance_last")}</span><p className="font-medium text-fg">{stats.lastRunAt ? relTime(stats.lastRunAt) : t("health_maintenance_never")}</p></div>
          <div><span className="text-fg-faint">{t("health_maint_demoted")}</span><p className="font-medium text-fg">{stats.memoriesCompacted}</p></div>
          <div><span className="text-fg-faint">{t("health_maint_deleted")}</span><p className="font-medium text-fg">{stats.memoriesDeleted}</p></div>
          <div><span className="text-fg-faint">{t("health_maint_merged")}</span><p className="font-medium text-fg">{stats.memoriesMerged}</p></div>
          <div><span className="text-fg-faint">{t("health_maint_rewritten")}</span><p className="font-medium text-fg">{stats.memoriesRewritten}</p></div>
          <div><span className="text-fg-faint">{t("health_maint_archived")}</span><p className="font-medium text-fg">{stats.skillsArchived}</p></div>
        </div>
      ) : (
        <p className="text-xs text-fg-faint">{t("loading")}</p>
      )}
    </Card>
  );
}
