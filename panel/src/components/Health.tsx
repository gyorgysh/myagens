import { useEffect, useRef, useState } from "react";
import {
  openHealthSocket,
  api,
  type Health,
  type MaintenanceStats,
  type MaintenancePreview,
  type MemoryEntry,
  type ProbeResult,
  type UsageLimitWindow,
} from "../api.ts";
import { Bar, Card, Button, Empty, Metric, InfoCard } from "./ui.tsx";
import { bytes, bytesPerSec, duration, uptime, relTime, friendlyProbeError } from "../lib/format.ts";
import { useI18n } from "../lib/useI18n.ts";
import type { TranslationKey } from "../i18n/en.ts";
import { GettingStarted, HowItConnects } from "./onboarding.tsx";
import type { Tab } from "./Sidebar.tsx";

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

export function HealthView({ onGoto }: { onGoto?: (t: Tab) => void }) {
  const { t } = useI18n();
  const [health, setHealth] = useState<Health | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [brand, setBrand] = useState("MyHQ");
  const retryRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    api.me().then((m) => m.brandName && setBrand(m.brandName)).catch(() => {});
  }, []);

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
      {/* First-run getting-started checklist (self-dismisses once configured) */}
      {onGoto && <GettingStarted onGoto={onGoto} />}

      {/* Orientation: how a message flows through Atlas and where Leads/Skills/Memory plug in.
          Persists (collapsed) as a "?" help panel even after onboarding is done. */}
      <HowItConnects />

      {/* Host info bar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
        <span className="font-medium text-fg">{health.host}</span>
        <span className="text-fg-faint">·</span>
        <span>{health.platform}</span>
        <span className="text-fg-faint">·</span>
        <span>{t("health_up")} {duration(health.uptimeSec)}</span>
        <span className="text-fg-faint">·</span>
        <span title={t("health_process_up_desc").replace("{brand}", brand)}>
          {t("health_process_up").replace("{brand}", brand)} {uptime(health.processUptimeSec)}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-xs">
          <span className={`inline-block h-2 w-2 rounded-full ${status === "live" ? "bg-ok" : "bg-warn"}`} />
          {status === "live" ? t("health_live") : t("health_reconnecting")}
        </span>
      </div>

      {/* At-a-glance status strip: compact health pills, scrolls on mobile. */}
      <StatusStrip health={health} memPct={memPct} swapPct={swapPct} status={status} />

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
      <KeyboardShortcutsCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// At-a-glance status strip
// ---------------------------------------------------------------------------

/** Severity tone for a 0..100 utilisation pill. */
function pillTone(pct: number): { dot: string; bar: string; val: string } {
  if (pct >= 90) return { dot: "bg-critical", bar: "bg-critical", val: "text-critical-fg" };
  if (pct >= 75) return { dot: "bg-warn", bar: "bg-warn", val: "text-warn-fg" };
  return { dot: "bg-ok", bar: "bg-accent", val: "text-fg" };
}

function StatusPill({
  label, value, pct, sub, dotClass, barClass, valClass,
}: {
  label: string;
  value: string;
  pct?: number;
  sub?: string;
  dotClass?: string;
  barClass?: string;
  valClass?: string;
}) {
  return (
    <div className="flex w-40 shrink-0 snap-start flex-col gap-1.5 rounded-xl border border-line bg-surface px-3 py-2.5 md:w-auto md:flex-1">
      <div className="flex items-center gap-1.5">
        {dotClass && <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass}`} />}
        <span className="truncate text-xs font-semibold uppercase tracking-wider text-fg-faint">{label}</span>
      </div>
      <span className={`text-lg font-bold leading-none tabular ${valClass ?? "text-fg"}`}>{value}</span>
      {pct != null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div className={`h-full rounded-full transition-all duration-500 ${barClass ?? "bg-accent"}`} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
      {sub && <span className="truncate text-xs text-fg-faint">{sub}</span>}
    </div>
  );
}

function StatusStrip({
  health, memPct, swapPct, status,
}: {
  health: Health;
  memPct: number;
  swapPct: number;
  status: ConnStatus;
}) {
  const { t } = useI18n();
  const cpu = pillTone(health.cpu.load);
  const mem = pillTone(memPct);
  const swap = pillTone(swapPct);
  const ioTotal = (health.io.readBytesSec ?? 0) + (health.io.writeBytesSec ?? 0);
  // Worst disk drives the disk pill colour.
  const worstDisk = health.disks.reduce((m, d) => Math.max(m, d.usePct), 0);
  const disk = pillTone(worstDisk);

  return (
    <div className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-1 md:mx-0 md:flex-wrap md:overflow-visible md:px-0 md:pb-0">
      <StatusPill
        label={t("health_status")}
        value={status === "live" ? t("health_live") : t("health_reconnecting")}
        dotClass={status === "live" ? "bg-ok" : "bg-warn"}
        valClass={status === "live" ? "text-ok-fg" : "text-warn-fg"}
      />
      <StatusPill
        label={t("health_cpu")}
        value={`${health.cpu.load.toFixed(0)}%`}
        pct={health.cpu.load}
        dotClass={cpu.dot}
        barClass={cpu.bar}
        valClass={cpu.val}
        sub={health.cpu.tempC ? `${health.cpu.tempC}°C` : undefined}
      />
      <StatusPill
        label={t("health_memory")}
        value={`${memPct.toFixed(0)}%`}
        pct={memPct}
        dotClass={mem.dot}
        barClass={mem.bar}
        valClass={mem.val}
        sub={`${bytes(health.mem.used)} / ${bytes(health.mem.total)}`}
      />
      {health.swap.total > 0 && (
        <StatusPill
          label={t("health_swap")}
          value={`${swapPct.toFixed(0)}%`}
          pct={swapPct}
          dotClass={swap.dot}
          barClass={swap.bar}
          valClass={swap.val}
          sub={`${bytes(health.swap.used)} / ${bytes(health.swap.total)}`}
        />
      )}
      <StatusPill
        label={t("health_disk_io")}
        value={bytesPerSec(ioTotal || undefined)}
        sub={`r ${bytesPerSec(health.io.readBytesSec)} · w ${bytesPerSec(health.io.writeBytesSec)}`}
      />
      {health.disks.length > 0 && (
        <StatusPill
          label={t("health_filesystems")}
          value={`${worstDisk.toFixed(0)}%`}
          pct={worstDisk}
          dotClass={disk.dot}
          barClass={disk.bar}
          valClass={disk.val}
          sub={health.disks[0]?.mount}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Claude usage card
// ---------------------------------------------------------------------------

function barColor(severity: UsageLimitWindow["severity"]): string {
  if (severity === "critical") return "bg-critical";
  if (severity === "warning") return "bg-warn";
  return "bg-accent";
}

function textColor(severity: UsageLimitWindow["severity"]): string {
  if (severity === "critical") return "text-critical-fg";
  if (severity === "warning") return "text-warn-fg";
  return "text-ok-fg";
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
        <span className={`font-medium ${resetsInMs < 600_000 ? "text-warn-fg" : "text-fg-dim"}`}>
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
        <p className="flex items-center gap-2 text-sm text-fg-faint">
          <span
            aria-hidden
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent"
          />
          {t("health_loading")}
        </p>
      ) : probe?.source === "none" || !probe ? (
        <p className="text-sm text-fg-faint">{t("health_no_probe")}</p>
      ) : (
        <div className="space-y-5">
          {/* Error / fallback / stale notice */}
          {(probe.error || probe.stale || probe.source === "fallback") && (
            <div className="rounded-lg border border-warn/30 bg-warn-subtle px-3 py-2 text-xs text-warn-fg">
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
          <div><span className="text-fg-faint">{t("health_maintenance_next")}</span><p className="font-medium text-fg">{stats.nextRunAt ? relTime(stats.nextRunAt) : t("health_maint_unscheduled")}</p></div>
          <div><span className="text-fg-faint">{t("health_maint_demoted")}</span><p className="font-medium text-fg">{stats.memoriesCompacted}</p></div>
          <div><span className="text-fg-faint">{t("health_maint_deleted")}</span><p className="font-medium text-fg">{stats.memoriesDeleted}</p></div>
          <div><span className="text-fg-faint">{t("health_maint_merged")}</span><p className="font-medium text-fg">{stats.memoriesMerged}</p></div>
          <div><span className="text-fg-faint">{t("health_maint_rewritten")}</span><p className="font-medium text-fg">{stats.memoriesRewritten}</p></div>
          <div><span className="text-fg-faint">{t("health_maint_shortened")}</span><p className="font-medium text-fg">{stats.memoriesShortened}</p></div>
          <div><span className="text-fg-faint">{t("health_maint_archived")}</span><p className="font-medium text-fg">{stats.skillsArchived}</p></div>
        </div>
      ) : (
        <p className="text-xs text-fg-faint">{t("loading")}</p>
      )}

      <MaintenancePreviewSection refreshKey={stats?.lastRunAt} />
    </Card>
  );
}

/**
 * Collapsible dry-run of the deterministic compaction steps. Loads lazily on
 * first expand, and re-fetches whenever `refreshKey` (the last-run time) changes
 * so the preview reflects what the next run would do after one has completed.
 */
function MaintenancePreviewSection({ refreshKey }: { refreshKey?: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<MaintenancePreview | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setPreview(await api.previewMaintenance()); } catch { /* ignore */ } finally { setLoading(false); }
  };

  // Lazy-load when first opened; refresh if a run completed while open.
  useEffect(() => {
    if (!open) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refreshKey]);

  const total = preview
    ? preview.toDelete.length + preview.toDemote.length + preview.toMerge.length
    : 0;

  return (
    <div className="mt-3 border-t border-line pt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wider text-fg-faint hover:text-fg-dim transition-colors"
      >
        <span>{t("health_maint_preview_title")}</span>
        <span className="opacity-50">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {loading && !preview ? (
            <p className="text-xs text-fg-faint">{t("loading")}</p>
          ) : !preview || total === 0 ? (
            <p className="text-xs text-fg-faint">{t("health_maint_preview_empty")}</p>
          ) : (
            <>
              <p className="text-xs text-fg-dim">{t("health_maint_preview_note")}</p>
              {preview.toDelete.length > 0 && (
                <PreviewGroup
                  label={t("health_maint_preview_delete").replace("{n}", String(preview.toDelete.length))}
                  tone="delete"
                  entries={preview.toDelete}
                />
              )}
              {preview.toDemote.length > 0 && (
                <PreviewGroup
                  label={t("health_maint_preview_demote").replace("{n}", String(preview.toDemote.length))}
                  tone="demote"
                  entries={preview.toDemote}
                />
              )}
              {preview.toMerge.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-warn-fg">
                    {t("health_maint_preview_merge").replace("{n}", String(preview.toMerge.length))}
                  </p>
                  {preview.toMerge.map((m, i) => (
                    <div key={i} className="rounded border border-line bg-input px-2.5 py-1.5 text-xs">
                      <p className="text-fg"><span className="text-fg-faint">{t("health_maint_preview_keep")} </span>{m.kept.text}</p>
                      {m.dropped.map((d) => (
                        <p key={d.id} className="mt-0.5 text-fg-faint line-through">{d.text}</p>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PreviewGroup({ label, tone, entries }: { label: string; tone: "delete" | "demote"; entries: MemoryEntry[] }) {
  const color = tone === "delete" ? "text-critical-fg" : "text-warn-fg";
  return (
    <div className="space-y-1.5">
      <p className={`text-xs font-semibold ${color}`}>{label}</p>
      <div className="space-y-1">
        {entries.map((e) => (
          <div key={e.id} className="flex items-start gap-2 rounded border border-line bg-input px-2.5 py-1.5 text-xs">
            <span className="mono-xs shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-fg-faint">{e.tier}</span>
            <span className="min-w-0 flex-1 truncate text-fg-dim">{e.text}</span>
            <span className="tabular shrink-0 text-fg-faint">{e.salience.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts card
// ---------------------------------------------------------------------------

type ShortcutRow = { keys: string[]; descKey: TranslationKey };

const NAV_SHORTCUTS: ShortcutRow[] = [
  { keys: ["⌘K", "Ctrl K"], descKey: "shortcuts_cmd_k" },
  { keys: ["Esc"], descKey: "shortcuts_esc" },
  { keys: ["↑ ↓"], descKey: "shortcuts_arrow" },
  { keys: ["Enter"], descKey: "shortcuts_enter" },
];

const CHAT_SHORTCUTS: ShortcutRow[] = [
  { keys: ["Enter"], descKey: "shortcuts_chat_send" },
  { keys: ["Shift Enter"], descKey: "shortcuts_chat_newline" },
];

function ShortcutSection({ heading, rows }: { heading: string; rows: ShortcutRow[] }) {
  const { t } = useI18n();
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fg-faint">{heading}</p>
      <div className="space-y-1">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="flex shrink-0 gap-1">
              {row.keys.map((k) => (
                <kbd
                  key={k}
                  className="mono-xs rounded border border-line bg-surface-2 px-1.5 py-0.5 text-fg-dim"
                >
                  {k}
                </kbd>
              ))}
            </div>
            <span className="text-xs text-fg-dim">{t(row.descKey)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function KeyboardShortcutsCard() {
  const { t } = useI18n();
  return (
    <InfoCard id="keyboard-shortcuts" title={t("shortcuts_show")} openTitle={t("shortcuts_title")}>
      <div className="space-y-4">
        <ShortcutSection heading={t("shortcuts_nav")} rows={NAV_SHORTCUTS} />
        <ShortcutSection heading={t("shortcuts_chat")} rows={CHAT_SHORTCUTS} />
      </div>
    </InfoCard>
  );
}
