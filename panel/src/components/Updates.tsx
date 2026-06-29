import { useEffect, useRef, useState } from "react";
import { api, AuthError, openHealthSocket, type UpdateStatus } from "../api.ts";
import { Badge, Button, Callout, Card } from "./ui.tsx";
import { useI18n } from "../lib/useI18n.ts";
import { relTime } from "../lib/format.ts";
import { reloadFresh } from "../lib/reload.ts";
import { Markdown } from "../lib/markdown.tsx";

const CHANGELOG_URL =
  "https://raw.githubusercontent.com/gyorgysh/myhq/refs/heads/main/CHANGELOG.md";

interface ChangelogEntry {
  version: string;
  date: string;
  /** Raw markdown body for the section (everything under the header). */
  body: string;
}

// Parse a normalised semver "x.y.z" into a comparable tuple. Anything missing
// or non-numeric becomes 0, so a malformed header just sorts to the bottom.
function parseVer(v: string): [number, number, number] {
  const m = v.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// Returns > 0 if a is newer than b, < 0 if older, 0 if equal.
function cmpVer(a: string, b: string): number {
  const pa = parseVer(a);
  const pb = parseVer(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// Split CHANGELOG.md into entries by "## [x.y.z] - date" headers.
function parseChangelog(md: string): ChangelogEntry[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  for (const line of lines) {
    const h = line.match(/^##\s+\[([^\]]+)\]\s*-\s*(.+)$/);
    if (h) {
      if (current) entries.push(current);
      current = { version: h[1].trim(), date: h[2].trim(), body: "" };
      continue;
    }
    if (current) current.body += (current.body ? "\n" : "") + line;
  }
  if (current) entries.push(current);
  // Trim trailing blank lines from each body.
  return entries.map((e) => ({ ...e, body: e.body.trim() }));
}

// Pull a 4-digit year out of an entry's date string (e.g. "2025-03-14" or
// "March 14, 2025"). Falls back to "—" when no year is present so malformed
// dates still group together rather than vanish.
function entryYear(e: ChangelogEntry): string {
  const m = e.date.match(/\b(20\d{2}|19\d{2})\b/);
  return m ? m[1] : "—";
}

// Group entries into year buckets, preserving the (already version-sorted)
// order within each bucket. Returns buckets newest-year-first.
function groupByYear(entries: ChangelogEntry[]): { year: string; entries: ChangelogEntry[] }[] {
  const order: string[] = [];
  const byYear = new Map<string, ChangelogEntry[]>();
  for (const e of entries) {
    const y = entryYear(e);
    if (!byYear.has(y)) {
      byYear.set(y, []);
      order.push(y);
    }
    byYear.get(y)!.push(e);
  }
  // Sort years descending; the "—" (unknown) bucket sorts last.
  order.sort((a, b) => {
    if (a === "—") return 1;
    if (b === "—") return -1;
    return Number(b) - Number(a);
  });
  return order.map((year) => ({ year, entries: byYear.get(year)! }));
}

export function UpdatesView({
  onAuthError,
  onStatus,
}: {
  onAuthError: () => void;
  onStatus?: (available: boolean, count: number) => void;
}) {
  const { t } = useI18n();
  const [version, setVersion] = useState<string>("…");
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [changelog, setChangelog] = useState<ChangelogEntry[] | null>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const apply = (s: UpdateStatus) => {
    setStatus(s);
    onStatus?.(s.available, s.behindBy);
  };

  useEffect(() => {
    api.me().then((m) => setVersion(m.version)).catch((e) => e instanceof AuthError && onAuthError());
    api.updateStatus().then(apply).catch((e) => e instanceof AuthError && onAuthError());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch the public CHANGELOG to show "what's new" since the installed version.
  // Best-effort: if the public GitHub fetch fails (offline, GitHub down), fall
  // back to the local CHANGELOG.md shipped with the installed checkout. The local
  // file is at most at the installed version (no future-release entries), which
  // is fine. If both fail, the section is silently skipped.
  useEffect(() => {
    let cancelled = false;
    const setFromMarkdown = (md: string) => {
      if (cancelled) return;
      const entries = parseChangelog(md);
      if (entries.length > 0) setChangelog(entries);
    };
    fetch(CHANGELOG_URL)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(setFromMarkdown)
      .catch(() =>
        // GitHub unreachable — fall back to the local file via the panel API.
        api
          .changelog()
          .then((res) => setFromMarkdown(res.content))
          .catch(() => {
            /* both sources failed — silently skip the section */
          }),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  // Live update-output frames over the shared /ws.
  useEffect(() => {
    let closed = false;
    let ws: WebSocket;
    const connect = () => {
      if (closed) return;
      ws = openHealthSocket();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "update" && typeof msg.line === "string") {
            setLines((prev) => [...prev, msg.line].slice(-500));
          }
        } catch {
          /* ignore */
        }
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, []);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines]);

  // After kicking off an update/restore, poll the status until the backend
  // reports it finished. On a serviced host the process is killed mid-update and
  // the ConnectionBanner owns the reload (the WS drops). On a non-serviced host
  // the script completes without restarting us, so the connection never drops —
  // here we detect `updating` going false and reload to pick up the freshly
  // built panel assets and the now up-to-date status.
  useEffect(() => {
    if (!running) return;
    let stop = false;
    // Give the backend a beat to flip `updating` to true before we start
    // polling, so we don't immediately read a stale "not updating" status.
    const startedAt = Date.now();
    let sawUpdating = false;
    const id = setInterval(async () => {
      if (stop) return;
      try {
        const s = await api.updateStatus();
        if (stop) return;
        apply(s);
        if (s.updating) {
          sawUpdating = true;
          return;
        }
        // Only treat "not updating" as completion once we've either observed it
        // running, or waited long enough that it must have finished fast.
        if (sawUpdating || Date.now() - startedAt > 8000) {
          stop = true;
          clearInterval(id);
          // The backend is still alive (this fetch just succeeded), so the
          // banner won't reload us — do it here to load the new assets, dropping
          // the asset cache first so we don't reload a stale bundle.
          setTimeout(() => void reloadFresh(), 1200);
        }
      } catch (e) {
        if (e instanceof AuthError) {
          stop = true;
          clearInterval(id);
          onAuthError();
        }
        // A network error means the backend went down (serviced restart) —
        // leave it to the ConnectionBanner to reload on recovery.
      }
    }, 2000);
    return () => {
      stop = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const check = async () => {
    setChecking(true);
    try {
      apply(await api.checkUpdate());
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    } finally {
      setChecking(false);
    }
  };

  const run = async () => {
    const msg = t("updates_run_confirm") + (status?.active ? `\n\n${t("updates_active_warn")}` : "");
    if (!confirm(msg)) return;
    setRunning(true);
    setLines([]);
    try {
      await api.runUpdate();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    }
    // Keep `running` true: on a serviced host the bot restarts and the socket
    // drops; the reconnect banner takes over from here.
  };

  const restore = async () => {
    const msg = t("updates_restore_confirm") + (status?.active ? `\n\n${t("updates_active_warn")}` : "");
    if (!confirm(msg)) return;
    setRunning(true);
    setLines([]);
    try {
      await api.restoreUpdate();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    }
    // Same as run(): the bot restarts on a serviced host; the reconnect banner
    // takes over once the socket drops.
  };

  const available = status?.available;

  // Decide what to show in the "What's new" section. We need both the parsed
  // changelog and a resolved installed version (not the "…" placeholder).
  const haveVersion = version !== "…" && version.trim().length > 0;
  const sortedLog = changelog
    ? [...changelog].sort((a, b) => cmpVer(b.version, a.version))
    : null;
  const newerEntries =
    sortedLog && haveVersion
      ? sortedLog.filter((e) => cmpVer(e.version, version) > 0)
      : [];
  // When up to date, surface the latest release as a confirmation instead.
  const latestEntry = sortedLog && sortedLog.length > 0 ? sortedLog[0] : null;
  const showWhatsNew = newerEntries.length > 0;
  const showLatestConfirm = !showWhatsNew && haveVersion && latestEntry !== null;

  // Release history: every entry already covered above is excluded, so the
  // history lists only the *older* releases. When we showed "what's new", that's
  // everything not newer than the installed version; when we showed the
  // "you're on the latest" confirmation, that's everything except the latest.
  const historyEntries =
    sortedLog && haveVersion
      ? showLatestConfirm
        ? sortedLog.filter((e) => e.version !== latestEntry?.version)
        : sortedLog.filter((e) => cmpVer(e.version, version) <= 0)
      : [];
  const HISTORY_CAP = 10;
  const showHistory = historyEntries.length > 0;
  // Collapsed: a flat, capped list of the most recent older releases. Expanded:
  // the full history grouped into collapsible year sections (newest year open).
  const cappedHistory = historyEntries.slice(0, HISTORY_CAP);
  const historyByYear = groupByYear(historyEntries);

  const renderEntry = (e: ChangelogEntry) => (
    <details key={e.version} className="rounded-lg border border-line bg-input p-3">
      <summary className="cursor-pointer select-none text-sm font-medium text-fg">
        <span className="mono">{e.version}</span>
        <span className="ml-2 text-xs text-fg-faint">{e.date}</span>
      </summary>
      <div className="mt-2 text-sm text-fg-dim">
        <Markdown text={e.body} compact />
      </div>
    </details>
  );

  return (
    <div className="space-y-4">
      {status?.active && (
        <Callout title={t("updates_tip_active_title")}>
          {t("updates_tip_active_body")}
        </Callout>
      )}
      <Card title={t("updates_title")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-fg">
              {t("updates_current")} <span className="mono">{version}</span>
              {status?.branch && (
                <span className="mono ml-2 text-xs text-fg-faint">
                  {status.branch}
                  {status.current ? ` · ${status.current}` : ""}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-fg-dim">
              {available ? t("updates_behind").replace("{n}", String(status?.behindBy ?? 0)) : t("updates_latest")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {available ? (
              <Badge tone="amber">{t("updates_available")}</Badge>
            ) : (
              <Badge tone="green">{t("updates_up_to_date")}</Badge>
            )}
            <Button onClick={check} disabled={checking || running}>
              {checking ? t("updates_checking") : t("updates_check")}
            </Button>
          </div>
        </div>

        {status?.error && <p className="mt-2 text-sm text-critical-fg">{status.error}</p>}
        {status?.checkedAt && !status.error && (
          <p className="mt-1 text-xs text-fg-faint">
            {t("updates_checked").replace("{time}", relTime(status.checkedAt))}
          </p>
        )}

        {/* Pending commits */}
        {available && status && status.commits.length > 0 && (
          <div className="mt-3 rounded-lg border border-line bg-input p-3">
            <p className="mb-1.5 text-xs font-medium text-fg-dim">{t("updates_changes")}</p>
            <ul className="space-y-0.5">
              {status.commits.map((c, i) => (
                <li key={i} className="mono truncate text-xs text-fg-muted" title={c}>
                  {c}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Apply */}
        {available && (
          <div className="mt-3 flex items-center gap-3">
            <Button variant="primary" onClick={run} disabled={running || status?.updating}>
              {running || status?.updating ? t("updates_running") : t("updates_run")}
            </Button>
            <span className="text-xs text-fg-faint">
              {status?.serviceInstalled ? t("updates_will_restart") : t("updates_manual_restart")}
            </span>
          </div>
        )}
        {available && status?.active && (
          <p className="mt-2 text-xs text-warn-fg">⚠️ {t("updates_active_warn")}</p>
        )}
      </Card>

      {/* What's new: changelog entries newer than the installed version, or a
          "you're on the latest" confirmation when up to date. Best-effort —
          rendered only when the public CHANGELOG fetch + parse succeeded. */}
      {showWhatsNew && (
        <Card title={t("updates_whatsnew_title")}>
          <p className="mb-2 text-xs text-fg-faint">{t("updates_whatsnew_behind")}</p>
          <div className="space-y-3">
            {newerEntries.map((e) => (
              <details
                key={e.version}
                open={e.version === newerEntries[0].version}
                className="rounded-lg border border-line bg-input p-3"
              >
                <summary className="cursor-pointer select-none text-sm font-medium text-fg">
                  <span className="mono">{e.version}</span>
                  <span className="ml-2 text-xs text-fg-faint">{e.date}</span>
                </summary>
                <div className="mt-2 text-sm text-fg-dim">
                  <Markdown text={e.body} compact />
                </div>
              </details>
            ))}
          </div>
        </Card>
      )}
      {showLatestConfirm && latestEntry && (
        <Card title={t("updates_whatsnew_latest_title")}>
          <p className="mb-2 text-xs text-fg-faint">{t("updates_whatsnew_latest_body")}</p>
          <details className="rounded-lg border border-line bg-input p-3">
            <summary className="cursor-pointer select-none text-sm font-medium text-fg">
              <span className="mono">{latestEntry.version}</span>
              <span className="ml-2 text-xs text-fg-faint">{latestEntry.date}</span>
            </summary>
            <div className="mt-2 text-sm text-fg-dim">
              <Markdown text={latestEntry.body} compact />
            </div>
          </details>
        </Card>
      )}

      {/* Release history: all changelog entries older than the installed
          version. Collapsed shows a flat, capped list of the most recent; once
          expanded the full history is grouped into collapsible year sections
          (newest year open) so a long history stays navigable. */}
      {showHistory && (
        <Card title={t("updates_release_history")}>
          {showAllHistory ? (
            <div className="space-y-3">
              {historyByYear.map((g, gi) => (
                <details
                  key={g.year}
                  open={gi === 0}
                  className="rounded-lg border border-line bg-surface-2 p-2"
                >
                  <summary className="cursor-pointer select-none px-1 py-0.5 text-sm font-semibold text-fg">
                    {g.year}
                    <span className="ml-2 text-xs font-normal text-fg-faint">
                      {t("updates_year_count").replace("{n}", String(g.entries.length))}
                    </span>
                  </summary>
                  <div className="mt-2 space-y-2">{g.entries.map(renderEntry)}</div>
                </details>
              ))}
            </div>
          ) : (
            <div className="space-y-3">{cappedHistory.map(renderEntry)}</div>
          )}
          {historyEntries.length > HISTORY_CAP && (
            <div className="mt-3">
              <Button onClick={() => setShowAllHistory((v) => !v)}>
                {showAllHistory
                  ? t("updates_show_less")
                  : t("updates_show_all").replace("{n}", String(historyEntries.length))}
              </Button>
            </div>
          )}
        </Card>
      )}

      {/* Streamed output */}
      {lines.length > 0 && (
        <Card title={t("updates_output")}>
          <div
            ref={boxRef}
            className="max-h-80 overflow-auto rounded-lg bg-input p-3 font-mono text-xs leading-relaxed text-fg-muted"
          >
            {lines.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap break-words">
                {l}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Recovery: restore code to the latest GitHub commit, keep data/config */}
      <Card title={t("updates_recovery_title")}>
        <p className="text-sm text-fg-dim">{t("updates_recovery_desc")}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="danger" onClick={restore} disabled={running || status?.updating}>
            {running || status?.updating ? t("updates_running") : t("updates_restore")}
          </Button>
          <span className="text-xs text-fg-faint">
            {status?.serviceInstalled ? t("updates_will_restart") : t("updates_manual_restart")}
          </span>
        </div>
        {status?.active && (
          <p className="mt-2 text-xs text-warn-fg">⚠️ {t("updates_active_warn")}</p>
        )}
      </Card>

      {/* Manual fallback */}
      <Card title={t("updates_manual_title")}>
        <p className="text-sm text-fg-dim">{t("updates_manual_desc")}</p>
        <pre className="mono mt-2 overflow-x-auto rounded bg-surface-2 p-2 text-xs text-fg">
          {status?.platform === "win32" ? ".\\scripts\\windows\\update.ps1" : "scripts/update.sh"}
        </pre>
      </Card>
    </div>
  );
}
