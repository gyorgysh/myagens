/**
 * Tiny timestamped logger. Level is controlled by LOG_LEVEL (error|warn|info|debug,
 * default info). Dependency-free so it can be imported anywhere without cycles.
 *
 * Persistence: each log line is also appended as NDJSON to logs/YYYY-MM-DD.log
 * (relative to the repo root). Files older than 72 h are pruned on startup and
 * once a day thereafter. The logs/ folder is gitignored.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// ---------------------------------------------------------------------------
// File sink
// ---------------------------------------------------------------------------

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const LOG_DIR = join(repoRoot, "logs");
const ROTATION_MS = 72 * 60 * 60 * 1000; // 72 hours
const ROTATION_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // check once a day

/** YYYY-MM-DD string in local time. */
function today(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

let currentLogDate = "";
let currentLogPath = "";

function ensureLogDir(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    /* best effort */
  }
}

function rotateLogs(): void {
  try {
    const cutoff = Date.now() - ROTATION_MS;
    const files = readdirSync(LOG_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f));
    for (const file of files) {
      // Parse date from filename (YYYY-MM-DD.log) — treat as midnight local time.
      const dateStr = file.slice(0, 10);
      const ts = new Date(dateStr).getTime();
      if (!Number.isNaN(ts) && ts < cutoff) {
        try {
          rmSync(join(LOG_DIR, file));
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* best effort */
  }
}

function appendToFile(entry: LogEntry): void {
  const date = today();
  if (date !== currentLogDate) {
    currentLogDate = date;
    currentLogPath = join(LOG_DIR, `${date}.log`);
  }
  try {
    appendFileSync(currentLogPath, JSON.stringify(entry) + "\n");
  } catch {
    /* best effort — never break the process over a log write */
  }
}

// Initialise: ensure directory exists, prune old files, schedule daily rotation.
ensureLogDir();
rotateLogs();
const _rotationTimer = setInterval(rotateLogs, ROTATION_CHECK_INTERVAL);
// Don't let the interval pin the event loop.
if (_rotationTimer.unref) _rotationTimer.unref();

// ---------------------------------------------------------------------------
// Helpers for reading past log files (used by the /api/logs endpoint).
// ---------------------------------------------------------------------------

/** List available log dates (YYYY-MM-DD strings), newest first. */
export function availableLogDates(): string[] {
  try {
    return readdirSync(LOG_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Read log entries from a specific date file.
 * Optionally filter by level and a case-insensitive substring match on msg or
 * serialised meta.
 */
export function readLogFile(
  date: string,
  opts: { level?: Level; q?: string; limit?: number } = {},
): LogEntry[] {
  const path = join(LOG_DIR, `${date}.log`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const { level, q, limit = 2000 } = opts;
  const needle = q?.toLowerCase();
  const results: LogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as LogEntry;
      if (level && entry.level !== level) continue;
      if (needle) {
        const hay = entry.msg.toLowerCase() + (entry.meta ? JSON.stringify(entry.meta).toLowerCase() : "");
        if (!hay.includes(needle)) continue;
      }
      results.push(entry);
    } catch {
      /* skip malformed lines */
    }
  }
  // Respect limit — return the last N matching entries.
  return results.length > limit ? results.slice(-limit) : results;
}

// ---------------------------------------------------------------------------
// Core emit
// ---------------------------------------------------------------------------

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

  appendToFile(entry);

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
