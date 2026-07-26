import { join } from "node:path";
import { readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { config, repoRoot } from "../config.js";
import { emptyUsage, zeroStat } from "../session/store.js";
import type { Usage } from "../session/store.js";
import type { Autonomy, Escalation, TurnUsage } from "../session/manager.js";
import { ensureDataDir } from "../core/jsonStore.js";
import { log } from "../logger.js";

export interface SlackSession {
  userId: string;
  sessionId?: string;
  cwd: string;
  busy: boolean;
  busySince?: number;
  busyPrompt?: string;
  abort?: AbortController;
  /**
   * Incremented for every turn, and by /stop. A turn only clears the busy
   * flags in its `finally` when this still matches the value it captured, so a
   * turn that was stopped (or that handed off to a retry) can't clear the
   * state of the turn that replaced it.
   */
  turnSeq?: number;
  sessionAllowedTools: Set<string>;
  allowedBashCmds: Set<string>;
  autonomy: Autonomy;
  escalation?: Escalation;
  language?: string;
  usage: Usage;
  lastContextTokens?: number;
  contextWarned?: boolean;
  lastTurnAt?: number;
}

export interface PersistedSlackSession {
  userId: string;
  sessionId?: string;
  cwd: string;
  autonomy: Autonomy;
  language?: string;
  allowedTools: string[];
  allowedBashCmds: string[];
  usage: Usage;
}

interface SlackStateFile {
  version: 1;
  sessions: PersistedSlackSession[];
}

const DAILY_KEEP = 30;

function safeReviver(key: string, value: unknown): unknown {
  if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
  return value;
}

export class SlackSessionManager {
  private sessions = new Map<string, SlackSession>();
  private saveTimer?: NodeJS.Timeout;
  private stateFile: string;

  constructor() {
    this.stateFile = join(repoRoot, "data", "slack-state.json");
    this.loadState();
  }

  private loadState() {
    try {
      const raw = readFileSync(this.stateFile, "utf8");
      const parsed = JSON.parse(raw, safeReviver) as SlackStateFile;
      if (parsed && Array.isArray(parsed.sessions)) {
        for (const p of parsed.sessions) {
          this.sessions.set(p.userId, {
            userId: p.userId,
            sessionId: p.sessionId,
            cwd: p.cwd,
            busy: false,
            sessionAllowedTools: new Set(p.allowedTools || []),
            allowedBashCmds: new Set(p.allowedBashCmds || []),
            autonomy: p.autonomy || "standard",
            language: p.language,
            usage: p.usage || emptyUsage(),
          });
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.error("Failed to read slack state file; starting fresh", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  get(userId: string): SlackSession {
    let s = this.sessions.get(userId);
    if (!s) {
      s = {
        userId,
        cwd: config.WORKDIR,
        busy: false,
        sessionAllowedTools: new Set(),
        allowedBashCmds: new Set(),
        autonomy: "standard",
        usage: emptyUsage(),
      };
      this.sessions.set(userId, s);
    }
    return s;
  }

  reset(userId: string): void {
    const s = this.get(userId);
    s.sessionId = undefined;
    s.lastContextTokens = undefined;
    s.contextWarned = false;
    s.lastTurnAt = undefined;
    this.save();
  }

  recordUsage(userId: string, u: TurnUsage): void {
    const s = this.get(userId);
    const day = new Date().toISOString().slice(0, 10);
    const bucket = (s.usage.daily[day] ??= zeroStat());
    for (const t of [s.usage.total, bucket]) {
      t.turns += 1;
      t.costUsd += u.costUsd;
      t.durationMs += u.durationMs;
      t.inputTokens += u.inputTokens;
      t.outputTokens += u.outputTokens;
      t.cacheReadTokens += u.cacheReadTokens;
      t.cacheWriteTokens += u.cacheWriteTokens;
    }
    this.save();
  }

  recordContext(userId: string, tokens: number, warnAt: number): boolean {
    const s = this.get(userId);
    s.lastContextTokens = tokens;
    s.lastTurnAt = Date.now();
    if (warnAt <= 0) return false;
    if (tokens < warnAt) {
      s.contextWarned = false;
      return false;
    }
    if (s.contextWarned) return false;
    s.contextWarned = true;
    return true;
  }

  resetEscalation(userId: string): void {
    const s = this.sessions.get(userId);
    if (s) s.escalation = undefined;
  }

  noteToolError(userId: string): void {
    const s = this.sessions.get(userId);
    if (!s || s.autonomy !== "auto_until_error") return;
    s.escalation = { cooldown: 3 }; // AUTO_UNTIL_ERROR_COOLDOWN is 3
  }

  markSeen(_userId: string): void {
    // Left empty for compatibility with interface.
  }

  save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, 500);
    this.saveTimer.unref?.();
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const sessions = Array.from(this.sessions.values()).map(toPersisted);
    const data: SlackStateFile = { version: 1, sessions };
    try {
      ensureDataDir();
      const tmp = `${this.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.stateFile);
    } catch (err) {
      log.error("Failed to persist slack state", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function toPersisted(s: SlackSession): PersistedSlackSession {
  // Prune usage daily buckets to last DAILY_KEEP days
  const keys = Object.keys(s.usage.daily).sort().slice(-DAILY_KEEP);
  const daily: Record<string, ReturnType<typeof zeroStat>> = {};
  for (const k of keys) daily[k] = s.usage.daily[k];
  const prunedUsage = { total: s.usage.total, daily };

  return {
    userId: s.userId,
    sessionId: s.sessionId,
    cwd: s.cwd,
    autonomy: s.autonomy,
    language: s.language,
    allowedTools: [...s.sessionAllowedTools],
    allowedBashCmds: [...s.allowedBashCmds],
    usage: prunedUsage,
  };
}

export const slackSessions = new SlackSessionManager();
