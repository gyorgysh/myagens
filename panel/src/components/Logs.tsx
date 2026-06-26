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

export function LogsView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();

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
  const [showInsights, setShowInsights] = useState(false);
  const [loadingInsights, setLoadingInsights] = useState(false);

  const isAllFiles = selectedDate === ALL_FILES;
  const boxRef = useRef<HTMLDivElement>(null);
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

  // Load usage insights on demand (and refresh).
  const loadInsights = useCallback(() => {
    setLoadingInsights(true);
    api
      .logsSummary(72)
      .then(setInsights)
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))))
      .finally(() => setLoadingInsights(false));
  }, [onAuthError]);

  const toggleInsights = () => {
    const next = !showInsights;
    setShowInsights(next);
    if (next && !insights) loadInsights();
  };

  // Autoscroll while following.
  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [liveLogs, histLogs, follow]);

  const toggle = (l: Level) =>
    setHidden((h) => {
      const n = new Set(h);
      n.has(l) ? n.delete(l) : n.add(l);
      return n;
    });

  if (error) return <Empty>{t("logs_failed_load").replace("{error}", error)}</Empty>;

  // Merge + filter
  const source = histLogs ?? liveLogs;
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

  return (
    <div className="flex h-[70vh] flex-col gap-2">
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
        <Button onClick={toggleInsights}>{t("logs_insights")}</Button>
      </div>

      {showInsights && (
        <InsightsPanel
          summary={insights}
          loading={loadingInsights}
          onRefresh={loadInsights}
          t={t}
        />
      )}

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
        <Button onClick={() => { setLiveLogs([]); setHistLogs(null); }}>{t("logs_clear")}</Button>
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
    </div>
  );
}

type TFn = (key: import("../i18n/en.ts").TranslationKey) => string;

/** A ranked horizontal-bar list of {name, count} for the insights panel. */
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
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</div>
      {items.length === 0 ? (
        <div className="text-xs text-fg-faint">{empty}</div>
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((it) => (
            <div key={it.name} className="flex items-center gap-2">
              <div className="relative h-4 flex-1 overflow-hidden rounded bg-surface-2">
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

function InsightsPanel({
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
    <div className="rounded-xl border border-line bg-input p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold text-fg">
          {t("logs_insights_title")}
          {summary ? (
            <span className="ml-1 font-normal text-fg-faint">
              {t("logs_insights_meta")
                .replace("{calls}", String(summary.totalToolCalls))
                .replace("{hours}", String(summary.windowHours))
                .replace("{files}", String(summary.filesScanned))}
            </span>
          ) : null}
        </span>
        <Button onClick={onRefresh}>{loading ? t("logs_insights_loading") : t("logs_refresh")}</Button>
      </div>
      {summary ? (
        <div className="flex flex-wrap gap-6">
          <RankList title={t("logs_top_tools")} items={summary.tools} empty={t("logs_no_lines")} />
          <RankList title={t("logs_top_commands")} items={summary.commands} empty={t("logs_no_lines")} />
        </div>
      ) : (
        <div className="text-xs text-fg-faint">{loading ? t("logs_insights_loading") : t("logs_no_lines")}</div>
      )}
    </div>
  );
}
