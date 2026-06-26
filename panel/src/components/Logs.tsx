import { useEffect, useRef, useState, useCallback } from "react";
import { api, AuthError, openHealthSocket, type LogEntry, type LogUsageSummary } from "../api.ts";
import { Button, Empty } from "./ui.tsx";
import { useI18n } from "../lib/useI18n.ts";

type Level = LogEntry["level"];
const LEVELS: Level[] = ["error", "warn", "info", "debug"];
const LEVEL_COLOR: Record<Level, string> = {
  error: "text-red-400",
  warn: "text-amber-400",
  info: "text-fg-muted",
  debug: "text-fg-faint",
};

const MAX = 2000;
// Sentinel date value for the "search every retained file (72h)" mode.
const ALL_FILES = "__all__";

type Tab = "activity" | "logs" | "analytics";
type TFn = (key: import("../i18n/en.ts").TranslationKey) => string;

export function LogsView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("activity");

  // Live ring-buffer logs (today, real-time).
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  // Historical logs loaded from a file (past date) or the cross-file search.
  const [histLogs, setHistLogs] = useState<LogEntry[] | null>(null);

  const [dates, setDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(""); // "" = today/live, ALL_FILES = 72h
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState<Set<Level>>(new Set());
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Usage insights (most-used tools/commands over the 72h window).
  const [insights, setInsights] = useState<LogUsageSummary | null>(null);
  const [loadingInsights, setLoadingInsights] = useState(false);

  const isAllFiles = selectedDate === ALL_FILES;
  const retryRef = useRef<ReturnType<typeof setTimeout>>();
  const searchRef = useRef<ReturnType<typeof setTimeout>>();

  // Fetch available dates for the dropdown.
  useEffect(() => {
    api
      .logDates()
      .then((r) => setDates(r.dates))
      .catch(() => {});
  }, []);

  // Initial backlog (today = live ring).
  useEffect(() => {
    api
      .logs()
      .then((r) => setLiveLogs(r.logs))
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live stream over the shared /ws — only used when viewing today.
  useEffect(() => {
    if (selectedDate) return; // past date: no streaming
    let closed = false;
    let ws: WebSocket;
    const connect = () => {
      if (closed) return;
      ws = openHealthSocket();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type !== "log") return;
          setLiveLogs((prev) => {
            const next = [...prev, msg.entry as LogEntry];
            return next.length > MAX ? next.slice(-MAX) : next;
          });
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (!closed) retryRef.current = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retryRef.current);
      ws?.close();
    };
  }, [selectedDate]);

  // Load historical logs when a past date — or the all-files (72h) mode — is
  // selected. All-files uses the cross-file search endpoint; a single date
  // reads that one file.
  const loadDate = useCallback(
    (date: string) => {
      if (!date) {
        setHistLogs(null);
        return;
      }
      setHistLogs(null);
      const req =
        date === ALL_FILES ? api.logsSearch({ hours: 72 }) : api.logs({ date });
      req
        .then((r) => setHistLogs(r.logs))
        .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));
    },
    [onAuthError],
  );

  const handleDateChange = (date: string) => {
    setSelectedDate(date);
    loadDate(date);
    setFollow(!date); // stop following when viewing past or all-files
  };

  // Debounced search: against the single file for a date, or across every
  // retained file (72h) in all-files mode.
  useEffect(() => {
    if (!selectedDate) return;
    clearTimeout(searchRef.current);
    searchRef.current = setTimeout(() => {
      const req =
        selectedDate === ALL_FILES
          ? api.logsSearch({ q: search || undefined, hours: 72 })
          : api.logs({ date: selectedDate, q: search || undefined });
      req.then((r) => setHistLogs(r.logs)).catch(() => {});
    }, 300);
    return () => clearTimeout(searchRef.current);
  }, [search, selectedDate]);

  // Load usage insights on demand (when the Analytics tab is first opened, and
  // on manual refresh).
  const loadInsights = useCallback(() => {
    setLoadingInsights(true);
    api
      .logsSummary(72)
      .then(setInsights)
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))))
      .finally(() => setLoadingInsights(false));
  }, [onAuthError]);

  useEffect(() => {
    if (tab === "analytics" && !insights && !loadingInsights) loadInsights();
  }, [tab, insights, loadingInsights, loadInsights]);

  const toggle = (l: Level) =>
    setHidden((h) => {
      const n = new Set(h);
      n.has(l) ? n.delete(l) : n.add(l);
      return n;
    });

  if (error) return <Empty>{t("logs_failed_load").replace("{error}", error)}</Empty>;

  const source = histLogs ?? liveLogs;

  return (
    <div className="flex h-[70vh] flex-col gap-3">
      {/* Top-level tabs */}
      <div className="flex items-center gap-1 rounded-lg border border-line bg-surface p-1 self-start">
        <TabButton active={tab === "activity"} onClick={() => setTab("activity")}>
          {t("logs_tab_activity")}
        </TabButton>
        <TabButton active={tab === "logs"} onClick={() => setTab("logs")}>
          {t("logs_tab_logs")}
        </TabButton>
        <TabButton active={tab === "analytics"} onClick={() => setTab("analytics")}>
          {t("logs_tab_analytics")}
        </TabButton>
      </div>

      {tab === "activity" && (
        <ActivityFeed source={source} follow={follow} setFollow={setFollow} t={t} />
      )}

      {tab === "logs" && (
        <RawLogs
          source={source}
          selectedDate={selectedDate}
          isAllFiles={isAllFiles}
          dates={dates}
          search={search}
          setSearch={setSearch}
          handleDateChange={handleDateChange}
          hidden={hidden}
          toggle={toggle}
          follow={follow}
          setFollow={setFollow}
          clear={() => {
            setLiveLogs([]);
            setHistLogs(null);
          }}
          t={t}
        />
      )}

      {tab === "analytics" && (
        <AnalyticsTab
          summary={insights}
          loading={loadingInsights}
          onRefresh={loadInsights}
          t={t}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? "bg-accent text-accent-fg" : "text-fg-muted hover:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Activity feed — human-readable view of what the agent is doing
// ---------------------------------------------------------------------------

interface Activity {
  key: string;
  ts: number;
  icon: string;
  verb: string;
  target: string;
  tone: "normal" | "error";
}

/** Map a tool name to a friendly icon and verb. */
function describeTool(tool: string, t: TFn): { icon: string; verb: string } {
  // Strip the mcp__ns__name wrapper down to the leaf tool name.
  const leaf = tool.replace(/^mcp__[^_]+__/, "");
  switch (leaf) {
    case "Read":
      return { icon: "📖", verb: t("logs_act_reading") };
    case "Write":
      return { icon: "✏️", verb: t("logs_act_writing") };
    case "Edit":
    case "NotebookEdit":
      return { icon: "📝", verb: t("logs_act_editing") };
    case "Bash":
      return { icon: "⚡", verb: t("logs_act_running") };
    case "Grep":
      return { icon: "🔍", verb: t("logs_act_searching") };
    case "Glob":
      return { icon: "📂", verb: t("logs_act_finding") };
    case "WebFetch":
      return { icon: "🌐", verb: t("logs_act_fetching") };
    case "WebSearch":
      return { icon: "🌐", verb: t("logs_act_browsing") };
    case "Task":
    case "crew_delegate":
      return { icon: "🤝", verb: t("logs_act_task") };
    case "TodoWrite":
      return { icon: "✅", verb: t("logs_act_todo") };
    case "send_file":
      return { icon: "📎", verb: t("logs_act_sending") };
    default:
      if (leaf.startsWith("memory_")) return { icon: "🧠", verb: t("logs_act_memory") };
      if (leaf.startsWith("skill_")) return { icon: "🛠️", verb: t("logs_act_using") };
      if (leaf.startsWith("task_")) return { icon: "📋", verb: t("logs_act_using") };
      return { icon: "🔧", verb: `${t("logs_act_using")} ${leaf}` };
  }
}

/** Map a known lifecycle log message to a friendly activity row. Returns null
 *  for messages that aren't part of the high-level activity feed. */
function describeLifecycle(
  l: LogEntry,
  t: TFn,
): { icon: string; verb: string; target: string } | null {
  const m = l.meta ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (l.msg) {
    case "Prompt received":
      return { icon: "💬", verb: t("logs_act_prompt"), target: str(m.text) };
    case "Voice transcribed":
      return { icon: "🎙️", verb: t("logs_act_voice"), target: str(m.text) };
    case "File received":
      return { icon: "📥", verb: t("logs_act_file_in"), target: str(m.name) || str(m.path) };
    case "Photo received":
      return { icon: "🖼️", verb: t("logs_act_photo_in"), target: str(m.path) };
    case "Turn complete":
      return { icon: "✅", verb: t("logs_act_replied"), target: "" };
    case "Scheduler started":
      return { icon: "⏰", verb: t("logs_act_scheduler"), target: "" };
    case "Scheduled task firing":
      return { icon: "⏱️", verb: t("logs_act_sched_fire"), target: "" };
    case "Heartbeat started":
      return { icon: "💓", verb: t("logs_act_heartbeat"), target: str(m.mode) };
    case "Update check":
      return {
        icon: "🔄",
        verb: t("logs_act_update_check"),
        target:
          typeof m.behindBy === "number" && m.behindBy > 0
            ? t("logs_act_update_behind").replace("{n}", String(m.behindBy))
            : t("logs_act_update_uptodate"),
      };
    case "Usage probe starting":
      return { icon: "📊", verb: t("logs_act_usage_probe"), target: "" };
    case "Maintenance run starting":
      return { icon: "🧹", verb: t("logs_act_maintenance"), target: "" };
    case "Bot is listening for updates":
      return { icon: "🚀", verb: t("logs_act_bot_ready"), target: "" };
    case "Management panel listening":
      return { icon: "🖥️", verb: t("logs_act_panel_ready"), target: "" };
    case "Council command failed":
    case "Worker run failed":
    case "Task delegation failed":
      return { icon: "⚠️", verb: l.msg, target: str(m.error) };
    default:
      return null;
  }
}

/** Derive the activity feed from log entries: "Tool use" rows (which carry
 *  meta.tool + meta.arg) plus high-level lifecycle events (scheduler/heartbeat/
 *  update checks, incoming messages, etc.) so it reads like a live, friendly
 *  counterpart to the raw text logs. Newest at the bottom. */
function toActivities(source: LogEntry[], t: TFn): Activity[] {
  const out: Activity[] = [];
  for (const l of source) {
    if (l.msg === "Tool use" && l.meta) {
      const tool = typeof l.meta.tool === "string" ? l.meta.tool : "";
      if (!tool) continue;
      const arg = typeof l.meta.arg === "string" ? l.meta.arg : "";
      const { icon, verb } = describeTool(tool, t);
      out.push({
        key: `${l.seq}-${l.ts}`,
        ts: l.ts,
        icon,
        verb,
        target: arg,
        tone: l.level === "error" ? "error" : "normal",
      });
      continue;
    }
    const life = describeLifecycle(l, t);
    if (life) {
      out.push({
        key: `${l.seq}-${l.ts}`,
        ts: l.ts,
        icon: life.icon,
        verb: life.verb,
        target: life.target,
        tone: l.level === "error" ? "error" : "normal",
      });
    }
  }
  return out;
}

function ActivityFeed({
  source,
  follow,
  setFollow,
  t,
}: {
  source: LogEntry[];
  follow: boolean;
  setFollow: (v: boolean) => void;
  t: TFn;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const activities = toActivities(source, t);

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [activities.length, follow]);

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-xs text-fg-faint">{t("logs_activity_hint")}</span>
        <span className="tabular ml-auto text-xs text-fg-faint">
          {t("logs_lines").replace("{n}", String(activities.length))}
        </span>
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--accent)]"
          />
          {t("logs_follow")}
        </label>
      </div>
      <div
        ref={boxRef}
        onWheel={() => setFollow(false)}
        className="flex-1 overflow-auto rounded-xl border border-line bg-input p-2"
      >
        {activities.length === 0 ? (
          <Empty>{t("logs_activity_empty")}</Empty>
        ) : (
          <div className="flex flex-col">
            {activities.map((a) => (
              <div
                key={a.key}
                className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-2"
              >
                <span className="shrink-0 text-base leading-none">{a.icon}</span>
                <div className="min-w-0 flex-1">
                  <span
                    className={`text-sm font-medium ${
                      a.tone === "error" ? "text-red-400" : "text-fg"
                    }`}
                  >
                    {a.verb}
                  </span>
                  {a.target && (
                    <span className="ml-2 truncate font-mono text-xs text-fg-dim">{a.target}</span>
                  )}
                </div>
                <span className="tabular shrink-0 text-xs text-fg-faint">
                  {new Date(a.ts).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Raw logs — the original text log view
// ---------------------------------------------------------------------------

function RawLogs({
  source,
  selectedDate,
  isAllFiles,
  dates,
  search,
  setSearch,
  handleDateChange,
  hidden,
  toggle,
  follow,
  setFollow,
  clear,
  t,
}: {
  source: LogEntry[];
  selectedDate: string;
  isAllFiles: boolean;
  dates: string[];
  search: string;
  setSearch: (v: string) => void;
  handleDateChange: (d: string) => void;
  hidden: Set<Level>;
  toggle: (l: Level) => void;
  follow: boolean;
  setFollow: (v: boolean) => void;
  clear: () => void;
  t: TFn;
}) {
  const boxRef = useRef<HTMLDivElement>(null);

  let visible = source.filter((l) => !hidden.has(l.level));
  // Client-side search on live logs (hist logs are server-filtered).
  if (!selectedDate && search) {
    const needle = search.toLowerCase();
    visible = visible.filter(
      (l) =>
        l.msg.toLowerCase().includes(needle) ||
        (l.meta ? JSON.stringify(l.meta).toLowerCase().includes(needle) : false),
    );
  }

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [visible.length, follow]);

  return (
    <>
      {/* Toolbar row 1: date + search */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selectedDate}
          onChange={(e) => handleDateChange(e.target.value)}
          className="rounded border border-line bg-input px-2 py-1 text-xs text-fg"
        >
          <option value="">{t("logs_date_today")}</option>
          <option value={ALL_FILES}>{t("logs_all_files")}</option>
          {dates.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={isAllFiles ? t("logs_search_all_placeholder") : t("logs_search_placeholder")}
          className="min-w-0 flex-1 rounded border border-line bg-input px-2 py-1 text-xs text-fg placeholder:text-fg-faint"
        />
      </div>

      {/* Toolbar row 2: level toggles + follow + clear */}
      <div className="flex flex-wrap items-center gap-2">
        {LEVELS.map((l) => (
          <button
            key={l}
            onClick={() => toggle(l)}
            className={`rounded px-2 py-1 text-xs font-medium uppercase tracking-wide transition-opacity ${
              LEVEL_COLOR[l]
            } ${hidden.has(l) ? "opacity-30" : "bg-surface-2"}`}
          >
            {l}
          </button>
        ))}
        <span className="tabular ml-auto text-xs text-fg-faint">
          {t("logs_lines").replace("{n}", String(visible.length))}
        </span>
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--accent)]"
          />
          {t("logs_follow")}
        </label>
        <Button onClick={clear}>{t("logs_clear")}</Button>
      </div>

      {/* Log output */}
      <div
        ref={boxRef}
        onWheel={() => setFollow(false)}
        className="flex-1 overflow-auto rounded-xl border border-line bg-input p-3 font-mono text-xs leading-relaxed"
      >
        {visible.length === 0 ? (
          <Empty>{t("logs_no_lines")}</Empty>
        ) : (
          visible.map((l) => (
            <div key={`${l.seq}-${l.ts}`} className="whitespace-pre-wrap break-words">
              <span className="text-fg-faint">{new Date(l.ts).toLocaleTimeString()} </span>
              <span className={`${LEVEL_COLOR[l.level]} font-semibold`}>
                {l.level.toUpperCase().padEnd(5)}{" "}
              </span>
              <span className="text-fg">{l.msg}</span>
              {l.meta && Object.keys(l.meta).length > 0 && (
                <span className="text-fg-dim"> {JSON.stringify(l.meta)}</span>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Analytics — usage insights, now a full-height tab (no longer squeezes logs)
// ---------------------------------------------------------------------------

/** A ranked horizontal-bar list of {name, count}. */
function RankList({
  title,
  items,
  empty,
}: {
  title: string;
  items: Array<{ name: string; count: number }>;
  empty: string;
}) {
  const max = items.length ? items[0].count : 0;
  return (
    <div className="flex-1 min-w-0">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</div>
      {items.length === 0 ? (
        <div className="text-xs text-fg-faint">{empty}</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {items.map((it) => (
            <div key={it.name} className="flex items-center gap-2">
              <div className="relative h-5 flex-1 overflow-hidden rounded bg-surface-2">
                <div
                  className="absolute inset-y-0 left-0 rounded bg-accent/30"
                  style={{ width: `${max ? Math.max(4, (it.count / max) * 100) : 0}%` }}
                />
                <span className="absolute inset-y-0 left-2 flex items-center font-mono text-xs text-fg">
                  {it.name}
                </span>
              </div>
              <span className="tabular w-10 shrink-0 text-right font-mono text-xs text-fg-muted">
                {it.count}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AnalyticsTab({
  summary,
  loading,
  onRefresh,
  t,
}: {
  summary: LogUsageSummary | null;
  loading: boolean;
  onRefresh: () => void;
  t: TFn;
}) {
  return (
    <div className="flex-1 overflow-auto rounded-xl border border-line bg-input p-4">
      <div className="mb-4 flex items-center gap-2">
        <span className="text-sm font-semibold text-fg">
          {t("logs_insights_title")}
          {summary ? (
            <span className="ml-2 font-normal text-fg-faint">
              {t("logs_insights_meta")
                .replace("{calls}", String(summary.totalToolCalls))
                .replace("{hours}", String(summary.windowHours))
                .replace("{files}", String(summary.filesScanned))}
            </span>
          ) : null}
        </span>
        <Button onClick={onRefresh} className="ml-auto">
          {loading ? t("logs_insights_loading") : t("logs_refresh")}
        </Button>
      </div>
      {summary ? (
        <div className="flex flex-wrap gap-8">
          <RankList title={t("logs_top_tools")} items={summary.tools} empty={t("logs_no_lines")} />
          <RankList
            title={t("logs_top_commands")}
            items={summary.commands}
            empty={t("logs_no_lines")}
          />
        </div>
      ) : (
        <div className="text-xs text-fg-faint">
          {loading ? t("logs_insights_loading") : t("logs_no_lines")}
        </div>
      )}
    </div>
  );
}
