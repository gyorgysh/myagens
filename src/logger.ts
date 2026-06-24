/**
 * Tiny timestamped logger. Level is controlled by LOG_LEVEL (error|warn|info|debug,
 * default info). Dependency-free so it can be imported anywhere without cycles.
 */
type Level = "error" | "warn" | "info" | "debug";

const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const threshold = RANK[(process.env.LOG_LEVEL as Level) || "info"] ?? RANK.info;

/** A captured log line, for the management panel's live log view. */
export interface LogEntry {
  seq: number;
  ts: number;
  level: Level;
  msg: string;
  meta?: Record<string, unknown>;
}

// In-memory ring buffer + listeners so the panel can tail logs live without
// touching the service's stdout. Capped; oldest entries drop off.
const RING_MAX = 1000;
const ring: LogEntry[] = [];
const listeners = new Set<(e: LogEntry) => void>();
let seq = 0;

/** Recent log entries (oldest first), capped to `limit`. */
export function recentLogs(limit = RING_MAX): LogEntry[] {
  return ring.slice(-limit);
}

/** Subscribe to new log entries; returns an unsubscribe function. */
export function onLog(fn: (e: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (RANK[level] > threshold) return;
  const time = new Date().toISOString();
  const fields =
    meta && Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${msg}${fields}`;
  // eslint-disable-next-line no-console
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);

  const entry: LogEntry = { seq: seq++, ts: Date.now(), level, msg, meta };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      /* a bad listener must not break logging */
    }
  }
}

export const log = {
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
};

/** One-line preview of user text for logs (trimmed + truncated, single line). */
export function preview(text: string, max = 120): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}
