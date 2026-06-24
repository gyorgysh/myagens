import { useEffect, useRef, useState } from "react";
import { api, AuthError, openHealthSocket, type LogEntry } from "../api.ts";
import { Button, Empty } from "./ui.tsx";

type Level = LogEntry["level"];
const LEVELS: Level[] = ["error", "warn", "info", "debug"];
const LEVEL_COLOR: Record<Level, string> = {
  error: "text-red-400",
  warn: "text-amber-400",
  info: "text-fg-muted",
  debug: "text-fg-faint",
};

const MAX = 2000;

export function LogsView({ onAuthError }: { onAuthError: () => void }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [hidden, setHidden] = useState<Set<Level>>(new Set());
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout>>();

  // Initial backlog.
  useEffect(() => {
    api
      .logs()
      .then((r) => setLogs(r.logs))
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live stream over the shared /ws (ignore non-log frames).
  useEffect(() => {
    let closed = false;
    let ws: WebSocket;
    const connect = () => {
      if (closed) return;
      ws = openHealthSocket();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type !== "log") return;
          setLogs((prev) => {
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
  }, []);

  // Autoscroll while following.
  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [logs, follow]);

  const toggle = (l: Level) =>
    setHidden((h) => {
      const n = new Set(h);
      n.has(l) ? n.delete(l) : n.add(l);
      return n;
    });

  if (error) return <Empty>Failed to load: {error}</Empty>;

  const visible = logs.filter((l) => !hidden.has(l.level));

  return (
    <div className="flex h-[70vh] flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-2">
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
        <span className="tabular ml-auto text-xs text-fg-faint">{visible.length} lines</span>
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
            className="h-3.5 w-3.5 accent-blue-600"
          />
          Follow
        </label>
        <Button onClick={() => setLogs([])}>Clear</Button>
      </div>

      <div
        ref={boxRef}
        onWheel={() => setFollow(false)}
        className="flex-1 overflow-auto rounded-xl border border-line bg-input p-3 font-mono text-xs leading-relaxed"
      >
        {visible.length === 0 ? (
          <Empty>No log lines.</Empty>
        ) : (
          visible.map((l) => (
            <div key={l.seq} className="whitespace-pre-wrap break-words">
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
