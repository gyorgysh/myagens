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
 *
 * The whole file is returned by default (no cap) so the panel can show a full
 * day of logs without silently dropping older lines. Pass a positive `limit`
 * to trim to the last N matching entries.
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
  const { level, q, limit } = opts;
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
  // No limit means return the full file; an explicit positive limit trims to
  // the last N matching entries.
  return limit && limit > 0 && results.length > limit ? results.slice(-limit) : results;
}

// ---------------------------------------------------------------------------
// Smart cross-file helpers: search across every retained log file and
// summarise tool/command usage. The retention window is already 72h, so an
// all-files scan is naturally bounded. Both walk the same files; callers can
// scope further with `sinceMs`.
// ---------------------------------------------------------------------------

/** Iterate every retained log file (newest date first), yielding parsed entries. */
function forEachLogEntry(fn: (entry: LogEntry) => void): void {
  for (const date of availableLogDates()) {
    let raw: string;
    try {
      raw = readFileSync(join(LOG_DIR, `${date}.log`), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        fn(JSON.parse(line) as LogEntry);
      } catch {
        /* skip malformed lines */
      }
    }
  }
}

/**
 * Search across ALL retained log files at once (the whole 72h window by
 * default). Filters by level, a case-insensitive substring on msg + meta, and
 * an optional `sinceMs` cutoff. Results are returned oldest-first; an explicit
 * positive `limit` keeps the most recent N matches.
 */
export function searchAllLogs(
  opts: { level?: Level; q?: string; sinceMs?: number; limit?: number } = {},
): LogEntry[] {
  const { level, q, sinceMs, limit } = opts;
  const needle = q?.toLowerCase();
  const results: LogEntry[] = [];
  forEachLogEntry((entry) => {
    if (sinceMs && entry.ts < sinceMs) return;
    if (level && entry.level !== level) return;
    if (needle) {
      const hay = entry.msg.toLowerCase() + (entry.meta ? JSON.stringify(entry.meta).toLowerCase() : "");
      if (!hay.includes(needle)) return;
    }
    results.push(entry);
  });
  // Files are read newest-date-first but lines within a file are chronological;
  // sort the merged set so the timeline is coherent across day boundaries.
  results.sort((a, b) => a.ts - b.ts);
  return limit && limit > 0 && results.length > limit ? results.slice(-limit) : results;
}

/** The leading program token of a shell command, e.g. "git" from "git push …". */
function leadCommand(arg: string): string {
  // Drop env-var prefixes like FOO=bar, then take the first bare word.
  const tokens = arg.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  const head = tokens[i] ?? "";
  // Strip a leading path so /usr/bin/node and node fold together.
  const base = head.split("/").pop() ?? head;
  return base;
}

export interface LogUsageSummary {
  windowHours: number;
  filesScanned: number;
  totalToolCalls: number;
  tools: Array<{ name: string; count: number }>;
  commands: Array<{ name: string; count: number }>;
}

/**
 * Summarise tool and command usage from the persisted "Tool use" log entries
 * across all retained files (optionally scoped to a `sinceMs` window). For Bash
 * tools the leading program token of the command is tallied separately, so you
 * see both "which tools" and "which shell commands" the agent leans on.
 */
export function summarizeUsage(
  opts: { sinceMs?: number; top?: number } = {},
): LogUsageSummary {
  const { sinceMs, top = 20 } = opts;
  const tools = new Map<string, number>();
  const commands = new Map<string, number>();
  let totalToolCalls = 0;

  forEachLogEntry((entry) => {
    if (sinceMs && entry.ts < sinceMs) return;
    if (entry.msg !== "Tool use" || !entry.meta) return;
    const tool = typeof entry.meta.tool === "string" ? entry.meta.tool : undefined;
    if (!tool) return;
    totalToolCalls++;
    tools.set(tool, (tools.get(tool) ?? 0) + 1);
    if (tool === "Bash") {
      const arg = typeof entry.meta.arg === "string" ? entry.meta.arg : "";
      const cmd = leadCommand(arg);
      if (cmd) commands.set(cmd, (commands.get(cmd) ?? 0) + 1);
    }
  });

  const rank = (m: Map<string, number>) =>
    [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, top);

  const windowHours = sinceMs ? Math.round((Date.now() - sinceMs) / 3_600_000) : 72;
  return {
    windowHours,
    filesScanned: availableLogDates().length,
    totalToolCalls,
    tools: rank(tools),
    commands: rank(commands),
  };
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

// Logs persist to disk (NDJSON), the in-memory ring, the console, and the panel
// WS, so any secret that lands in a log line leaks broadly. Tool-use entries in
// particular carry shell command previews that may embed inline credentials
// (curl -H "Authorization: Bearer …", --password=…, --token=…). Scrub the
// common shapes centrally in emit() so every sink is covered. Best-effort,
// pattern-based: it can't catch every secret, but it knocks out the obvious ones.
const REDACTED = "«redacted»";
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Authorization: Bearer <token> / api keys after a Bearer keyword.
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Known key prefixes (Anthropic, OpenAI, generic sk-/pk-).
  [/\b(sk-ant-|sk-|pk-)[A-Za-z0-9._-]{8,}/gi, `$1${REDACTED}`],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, REDACTED], // telegram bot token id:secret
  // key/value pairs: token=…, "api_key":"…", password: "…". Optional quotes around
  // the key and (independently) the value, so it catches both shell and JSON forms.
  [
    /("?)\b(api[_-]?key|secret|token|password|passwd|pwd|auth[_-]?token|authorization|access[_-]?token|client[_-]?secret)\1(\s*[:=]\s*)("?)([^"\s,}]{4,})\4/gi,
    `$1$2$1$3$4${REDACTED}$4`,
  ],
  // CLI flags carrying a secret: --token <secret>, --password=<secret>. Only the
  // long-flag forms — bundled short flags like `-psecret` are too ambiguous to
  // tell apart from ordinary flags (`-prefix`), so we leave them.
  [/(--(?:token|password|passwd|pwd|secret|api[_-]?key|auth)[ =])(\S{4,})/gi, `$1${REDACTED}`],
];

function redactString(s: string): string {
  let out = s;
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  return out;
}

/** Deep-redact a meta object by scrubbing every string value (and key=val shapes). */
function redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === "string") out[k] = redactString(v);
    else if (v && typeof v === "object") {
      // Redact over the serialised form, then re-parse. If anything goes wrong
      // (logging must never throw), fall back to the original value.
      try {
        out[k] = JSON.parse(redactString(JSON.stringify(v)));
      } catch {
        out[k] = v;
      }
    } else out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core emit
// ---------------------------------------------------------------------------

function emit(level: Level, msg: string, rawMeta?: Record<string, unknown>): void {
  if (RANK[level] > threshold) return;
  const safeMsg = redactString(msg);
  const meta =
    rawMeta && Object.keys(rawMeta).length ? redactMeta(rawMeta) : rawMeta;
  const time = new Date().toISOString();
  const fields =
    meta && Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${safeMsg}${fields}`;
  // eslint-disable-next-line no-console
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);

  const entry: LogEntry = { seq: seq++, ts: Date.now(), level, msg: safeMsg, meta };
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
