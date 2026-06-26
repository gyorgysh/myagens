import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { config } from "../config.js";
import { log } from "../logger.js";
import { ensureDataDir } from "../core/jsonStore.js";
import type { Autonomy } from "./manager.js";

/** Drop prototype-polluting keys when parsing an on-disk state file. */
function safeReviver(key: string, value: unknown): unknown {
  if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
  return value;
}

/** Cumulative usage counters for a window (lifetime or a single day). */
export interface UsageStat {
  turns: number;
  costUsd: number;
  durationMs: number;
}

export interface Usage {
  total: UsageStat;
  /** Per-day buckets keyed by YYYY-MM-DD; pruned to the most recent days. */
  daily: Record<string, UsageStat>;
}

/** The subset of a Session that survives a process restart. */
export interface PersistedSession {
  chatId: number;
  sessionId?: string;
  cwd: string;
  autonomy: Autonomy;
  /** BCP 47 language tag the agent will respond in (e.g. "en", "hu"). */
  language?: string;
  /** Tools always allowed without prompting (persistent middle tier). */
  allowedTools: string[];
  /** Bash leading-commands always allowed without prompting (e.g. "git", "ls"). */
  allowedBashCmds: string[];
  /** Saved working directories for quick switching via /projects. */
  projects: string[];
  usage: Usage;
}

interface StateFile {
  version: 1;
  sessions: PersistedSession[];
}

const DAILY_KEEP = 30;

export function emptyUsage(): Usage {
  return { total: { turns: 0, costUsd: 0, durationMs: 0 }, daily: {} };
}

/** Read persisted sessions from the state file; returns [] if absent or unreadable. */
export function loadState(file: string = config.STATE_FILE): PersistedSession[] {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw, safeReviver) as StateFile;
    if (!parsed || !Array.isArray(parsed.sessions)) return [];
    return parsed.sessions.map(normalize);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.error("Failed to read state file; starting fresh", { error: errText(err) });
    }
    return [];
  }
}

/** Atomically write all sessions to the state file (temp file + rename). */
export function saveState(sessions: PersistedSession[], file: string = config.STATE_FILE): void {
  const data: StateFile = { version: 1, sessions: sessions.map(prune) };
  try {
    ensureDataDir();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file);
  } catch (err) {
    log.error("Failed to persist state", { error: errText(err) });
  }
}

/** Drop everything but the most recent DAILY_KEEP day-buckets before writing. */
function prune(s: PersistedSession): PersistedSession {
  const keys = Object.keys(s.usage.daily).sort().slice(-DAILY_KEEP);
  const daily: Record<string, UsageStat> = {};
  for (const k of keys) daily[k] = s.usage.daily[k];
  return { ...s, usage: { total: s.usage.total, daily } };
}

/** Fill in defaults for fields a hand-edited or older state file might miss. */
function normalize(s: PersistedSession & { mode?: string }): PersistedSession {
  // Migrate old "safe"/"auto" mode values to new autonomy tiers.
  const legacyMode = s.mode;
  let autonomy: Autonomy = s.autonomy ?? "standard";
  if (!s.autonomy && legacyMode) {
    autonomy = legacyMode === "auto" ? "full" : "standard";
  }
  if (
    autonomy !== "supervised" &&
    autonomy !== "standard" &&
    autonomy !== "full" &&
    autonomy !== "auto_until_error"
  ) {
    autonomy = "standard";
  }
  return {
    chatId: s.chatId,
    sessionId: s.sessionId,
    cwd: s.cwd,
    autonomy,
    language: typeof s.language === "string" ? s.language : undefined,
    allowedTools: Array.isArray(s.allowedTools) ? s.allowedTools : [],
    allowedBashCmds: Array.isArray(s.allowedBashCmds) ? s.allowedBashCmds : [],
    projects: Array.isArray(s.projects) ? s.projects : [],
    usage: s.usage?.total ? s.usage : emptyUsage(),
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
