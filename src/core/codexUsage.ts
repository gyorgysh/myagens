/**
 * Codex rate-limit reader.
 *
 * Unlike the Claude probe (src/core/usageProbe.ts) this needs no token and no
 * network call: the codex CLI already stores the server's own rate-limit block
 * in its session transcripts. Every turn appends a `token_count` event to
 * `$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` carrying:
 *
 *   "rate_limits":{"limit_id":"codex","primary":{"used_percent":33.0,
 *      "window_minutes":43200,"resets_at":1787551706},"secondary":null,
 *      "credits":{…},"plan_type":"free"}
 *
 * So we find the newest rollout file and read its last such event. The limits
 * are account-wide, which means MyAgens' own runs (private CODEX_HOME) and the
 * user's own `codex` runs (~/.codex) report the same numbers — whichever file
 * was written most recently is the freshest view, so both homes are searched.
 *
 * The trade-off versus the Claude probe: this cannot refresh on demand. The
 * numbers are only as current as the last codex turn, hence `observedAt` on the
 * result so callers can show their age instead of implying they are live.
 */

import { existsSync, readdirSync, readSync, openSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODEX_HOME_DIR } from "../codex/codexHome.js";
import { log } from "../logger.js";

/** How much of the tail to read. A rollout line is a few KB at most, so this
 *  covers the last events of even a very chatty turn without loading the file. */
const TAIL_BYTES = 512 * 1024;

/** Depth of the YYYY/MM/DD partitioning under `sessions/`. */
const PARTITION_DEPTH = 3;

// ---------------------------------------------------------------------------
// Shape of the codex rollout event
// ---------------------------------------------------------------------------

interface CodexRateWindow {
  used_percent: number;
  window_minutes: number;
  /** Epoch *seconds*, not ms. Absent on older codex builds. */
  resets_at?: number | null;
  /** Older builds carry a relative countdown instead. */
  resets_in_seconds?: number | null;
}

interface CodexRateLimits {
  primary?: CodexRateWindow | null;
  secondary?: CodexRateWindow | null;
  plan_type?: string | null;
  credits?: {
    has_credits: boolean;
    unlimited: boolean;
    balance: number | null;
  } | null;
  spend_control_reached?: boolean | null;
  rate_limit_reached_type?: string | null;
}

interface CodexTokenCountEvent {
  timestamp?: string;
  payload?: {
    type?: string;
    rate_limits?: CodexRateLimits | null;
    info?: {
      total_token_usage?: { total_tokens?: number };
      model_context_window?: number;
    } | null;
  };
}

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

export interface CodexLimitWindow {
  /** Percentage of the window consumed (0–100). */
  percent: number;
  /** Length of the window in minutes, as codex reports it. */
  windowMinutes: number;
  /** Human label derived from the window length, e.g. "5-hour" or "monthly". */
  label: string;
  /** ISO timestamp when the window resets. Absent if codex did not report one. */
  resetsAt?: string;
  severity: "normal" | "warning" | "critical";
}

export interface CodexUsageResult {
  /** When codex recorded these numbers — i.e. the last codex turn, not now. */
  observedAt: string;
  /** ChatGPT plan codex reports for the account ("free", "plus", "pro", …). */
  planType?: string;
  limits: CodexLimitWindow[];
  credits?: { hasCredits: boolean; unlimited: boolean; balance: number | null };
  /** True when codex reported it had actually hit a limit on that turn. */
  limitReached?: string;
  /** Which rollout file the numbers came from (for debugging). */
  sourceFile: string;
}

// ---------------------------------------------------------------------------
// Finding the newest rollout file
// ---------------------------------------------------------------------------

/** Every codex home worth searching, newest-wins across all of them. */
function sessionDirs(): string[] {
  const homes = [CODEX_HOME_DIR, join(homedir(), ".codex")];
  // A user-set CODEX_HOME takes the place of ~/.codex for their own runs.
  const fromEnv = process.env.CODEX_HOME;
  if (fromEnv && !homes.includes(fromEnv)) homes.push(fromEnv);
  return homes.map((h) => join(h, "sessions")).filter((d) => existsSync(d));
}

function isRollout(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

/**
 * Newest rollout file under a date-partitioned `sessions/` tree. Descends into
 * the highest-numbered directory first, so it touches three directories instead
 * of walking every session ever recorded, and falls back to the next one down
 * when a day holds no rollout file.
 */
function newestRollout(dir: string, depth = 0): { file: string; mtimeMs: number } | undefined {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  if (depth >= PARTITION_DEPTH) {
    let best: { file: string; mtimeMs: number } | undefined;
    for (const e of entries) {
      if (!e.isFile() || !isRollout(e.name)) continue;
      const file = join(dir, e.name);
      try {
        const { mtimeMs } = statSync(file);
        if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
      } catch {
        // Vanished between readdir and stat — skip it.
      }
    }
    return best;
  }

  const subdirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => b.localeCompare(a));
  for (const name of subdirs) {
    const found = newestRollout(join(dir, name), depth + 1);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Reading the last rate-limit event
// ---------------------------------------------------------------------------

/** Read up to the last TAIL_BYTES of a file as UTF-8. */
function readTail(file: string): string {
  const { size } = statSync(file);
  const length = Math.min(size, TAIL_BYTES);
  const buf = Buffer.allocUnsafe(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf8");
  // The first line is very likely cut in half by the tail boundary.
  return size > length ? text.slice(text.indexOf("\n") + 1) : text;
}

/** Last `token_count` event in the tail that actually carries rate limits. */
function lastRateLimitEvent(file: string): CodexTokenCountEvent | undefined {
  const lines = readTail(file).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    try {
      const ev = JSON.parse(line) as CodexTokenCountEvent;
      if (ev.payload?.rate_limits) return ev;
    } catch {
      // Not a complete JSON line (or not the shape we expect) — keep looking.
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Mapping to the public shape
// ---------------------------------------------------------------------------

/** Name a window by its length, matching how the vendor talks about them. */
function windowLabel(minutes: number): string {
  if (minutes === 300) return "5-hour";
  if (minutes === 10080) return "weekly";
  if (minutes === 43200) return "monthly";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

function severityFor(percent: number): CodexLimitWindow["severity"] {
  return percent >= 90 ? "critical" : percent >= 70 ? "warning" : "normal";
}

function toWindow(w: CodexRateWindow, observedAtMs: number): CodexLimitWindow {
  // `resets_at` is epoch seconds; older builds send a countdown instead, which
  // is relative to when codex wrote the event rather than to now.
  let resetsAt: string | undefined;
  if (typeof w.resets_at === "number") {
    resetsAt = new Date(w.resets_at * 1000).toISOString();
  } else if (typeof w.resets_in_seconds === "number") {
    resetsAt = new Date(observedAtMs + w.resets_in_seconds * 1000).toISOString();
  }

  return {
    percent: Math.round(w.used_percent),
    windowMinutes: w.window_minutes,
    label: windowLabel(w.window_minutes),
    resetsAt,
    severity: severityFor(w.used_percent),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the most recent codex rate-limit snapshot, or undefined when codex has
 * never run here (no rollout file) or ran a build that reports no limits.
 *
 * Cheap enough to call per request: it stats three directories and reads at
 * most TAIL_BYTES from one file, so nothing is cached or persisted.
 */
export function readCodexUsage(): CodexUsageResult | undefined {
  let newest: { file: string; mtimeMs: number } | undefined;
  for (const dir of sessionDirs()) {
    const found = newestRollout(dir);
    if (found && (!newest || found.mtimeMs > newest.mtimeMs)) newest = found;
  }
  if (!newest) return undefined;

  let ev: CodexTokenCountEvent | undefined;
  try {
    ev = lastRateLimitEvent(newest.file);
  } catch (err) {
    log.debug("Codex usage read failed", {
      file: newest.file,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  const rl = ev?.payload?.rate_limits;
  if (!rl) return undefined;

  const observedAtMs = ev?.timestamp ? Date.parse(ev.timestamp) : newest.mtimeMs;
  const at = Number.isFinite(observedAtMs) ? observedAtMs : newest.mtimeMs;

  const limits: CodexLimitWindow[] = [];
  for (const w of [rl.primary, rl.secondary]) {
    if (w && typeof w.used_percent === "number" && typeof w.window_minutes === "number") {
      limits.push(toWindow(w, at));
    }
  }
  // Shortest window first, so the one that bites soonest reads first.
  limits.sort((a, b) => a.windowMinutes - b.windowMinutes);

  return {
    observedAt: new Date(at).toISOString(),
    planType: rl.plan_type ?? undefined,
    limits,
    credits: rl.credits
      ? {
          hasCredits: rl.credits.has_credits,
          unlimited: rl.credits.unlimited,
          balance: rl.credits.balance,
        }
      : undefined,
    limitReached: rl.rate_limit_reached_type ?? undefined,
    sourceFile: newest.file,
  };
}
