import { useEffect, useRef, useState } from "react";
import { api, AuthError, openHealthSocket, type UpdateStatus } from "../api.ts";
import { Badge, Button, Callout, Card } from "./ui.tsx";
import { useI18n } from "../lib/useI18n.ts";
import { relTime } from "../lib/format.ts";

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
          // banner won't reload us — do it here to load the new assets.
          setTimeout(() => location.reload(), 1200);
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

        {status?.error && <p className="mt-2 text-sm text-red-400">{status.error}</p>}
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
          <p className="mt-2 text-xs text-amber-400">⚠️ {t("updates_active_warn")}</p>
        )}
      </Card>

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
          <p className="mt-2 text-xs text-amber-400">⚠️ {t("updates_active_warn")}</p>
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
