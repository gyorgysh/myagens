/**
 * Full per-run output transcripts.
 *
 * The worker/task run history (`workerRuns.json`, `tasks.json`) only keeps a
 * capped tail of streamed output to stay small. This module persists the
 * *complete* transcript of each autonomous run as NDJSON, one file per run, so
 * the panel can offer a "View full log" that isn't truncated.
 *
 * Layout: `data/runs/YYYY-MM-DD/<runId>.ndjson` (under the 0700 data dir, since
 * a transcript can contain host paths and command output). One JSON event per
 * line. Files are pruned after 72h, mirroring the logger's retention.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { log } from "../logger.js";

const RUNS_DIR = join(dirname(config.STATE_FILE), "runs");
const ROTATION_MS = 72 * 60 * 60 * 1000; // 72 hours
const ROTATION_CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 5_000; // hard ceiling per run, guards a runaway loop

/** One line in a run transcript. */
export interface RunLogEvent {
  ts: number;
  /** text delta, a tool call, a tool result flag, or a lifecycle marker. */
  kind: "text" | "tool" | "result" | "start" | "end";
  /** for kind "text": the streamed delta. */
  text?: string;
  /** for kind "tool": the tool name. */
  tool?: string;
  /** for kind "tool": a short preview of the input. */
  arg?: string;
  /** for kind "result"/"end": error flag. */
  isError?: boolean;
  /** for kind "end": status/cost/duration summary. */
  status?: string;
  costUsd?: number;
  durationMs?: number;
}

/** YYYY-MM-DD in local time (matches the logger's day boundary). */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayDir(date: string): string {
  return join(RUNS_DIR, date);
}

/**
 * A live writer for one run. Holds the open file path and an event counter so a
 * pathological loop can't fill the disk. Call `event()` per streamed chunk and
 * `close()` once with the final summary.
 */
export class RunLogWriter {
  private path: string;
  private count = 0;
  private capped = false;

  constructor(
    readonly runId: string,
    meta: { kind: "worker" | "task"; ownerId: string; ownerName?: string },
  ) {
    const date = today();
    this.path = join(dayDir(date), `${runId}.ndjson`);
    try {
      mkdirSync(dayDir(date), { recursive: true, mode: 0o700 });
    } catch (err) {
      log.error("runLog: failed to create dir", { error: errText(err) });
    }
    this.event({ ts: Date.now(), kind: "start", arg: meta.ownerName ?? meta.ownerId, tool: meta.kind });
  }

  event(e: RunLogEvent): void {
    if (this.capped) return;
    if (this.count >= MAX_EVENTS) {
      this.capped = true;
      this.write({ ts: Date.now(), kind: "result", text: "[transcript truncated: event cap reached]" });
      return;
    }
    this.count++;
    this.write(e);
  }

  close(summary: { status: string; isError?: boolean; costUsd?: number; durationMs?: number }): void {
    this.write({ ts: Date.now(), kind: "end", ...summary });
  }

  private write(e: RunLogEvent): void {
    try {
      appendFileSync(this.path, JSON.stringify(e) + "\n");
    } catch {
      /* best effort — never break a run over a transcript write */
    }
  }
}

/** Read a run's full transcript (oldest-first). Returns [] if missing. */
export function readRunLog(runId: string): RunLogEvent[] {
  const file = findRunFile(runId);
  if (!file) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as RunLogEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is RunLogEvent => e !== null);
  } catch {
    return [];
  }
}

/** Whether a transcript exists for this run id. */
export function hasRunLog(runId: string): boolean {
  return findRunFile(runId) !== null;
}

/** Lightweight descriptor of a stored run transcript. */
export interface RunSummary {
  runId: string;
  /** YYYY-MM-DD day-dir the transcript lives in. */
  date: string;
  /** File mtime (epoch ms), used for recency ordering. */
  mtime: number;
}

/**
 * Enumerate every stored run transcript across all day-dirs, newest first.
 * Used by conversation search to know which transcripts to scan.
 */
export function listRuns(): RunSummary[] {
  let dates: string[];
  try {
    dates = readdirSync(RUNS_DIR);
  } catch {
    return [];
  }
  const out: RunSummary[] = [];
  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    let files: string[];
    try {
      files = readdirSync(dayDir(date));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".ndjson")) continue;
      const runId = f.slice(0, -".ndjson".length);
      let mtime = 0;
      try {
        mtime = statSync(join(dayDir(date), f)).mtimeMs;
      } catch {
        /* vanished mid-scan */
      }
      out.push({ runId, date, mtime });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Search every day-dir for `<runId>.ndjson`. */
function findRunFile(runId: string): string | null {
  // Reject anything that isn't a plain id, so a caller can't path-traverse.
  if (!/^[\w-]+$/.test(runId)) return null;
  let dates: string[];
  try {
    dates = readdirSync(RUNS_DIR);
  } catch {
    return null;
  }
  for (const date of dates) {
    const candidate = join(dayDir(date), `${runId}.ndjson`);
    try {
      statSync(candidate);
      return candidate;
    } catch {
      /* not in this day-dir */
    }
  }
  return null;
}

/** Delete transcript day-dirs older than the retention window. */
function rotate(): void {
  try {
    const cutoff = Date.now() - ROTATION_MS;
    for (const date of readdirSync(RUNS_DIR)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const ts = new Date(date).getTime();
      if (!Number.isNaN(ts) && ts < cutoff) {
        try {
          rmSync(dayDir(date), { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* dir may not exist yet */
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Prune on load, then once a day.
rotate();
const _timer = setInterval(rotate, ROTATION_CHECK_INTERVAL);
if (_timer.unref) _timer.unref();
