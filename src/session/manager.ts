import { dirname, isAbsolute, resolve } from "node:path";
import { config } from "../config.js";
import {
  emptyUsage,
  loadState,
  saveState,
  zeroStat,
  type PersistedSession,
  type Usage,
} from "./store.js";

/** Per-turn usage folded into the running counters by `recordUsage`. */
export interface TurnUsage {
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type Autonomy = "supervised" | "standard" | "full" | "auto_until_error";

/** @deprecated Use Autonomy. Kept for any external callers. */
export type PermissionMode = Autonomy;

/** Tools auto-approved by `auto_until_error` on top of the read-only safe set. */
export const AUTO_UNTIL_ERROR_TOOLS = ["Bash", "Write", "Edit", "NotebookEdit"] as const;

/** How many subsequent tool calls are forced through supervised approval after
 *  an `auto_until_error` tool errors, before auto-approval resumes. */
export const AUTO_UNTIL_ERROR_COOLDOWN = 3;

/** Transient (not persisted) escalation state for the `auto_until_error` mode.
 *  Lives only for the process; reset on each new turn via `resetEscalation`. */
export interface Escalation {
  /** Calls still forced through supervised approval after a recent error. */
  cooldown: number;
}

export interface Session {
  /** Telegram chat id this session belongs to. */
  chatId: number;
  /** Claude Code session id for resuming context; undefined until first turn / after /new. */
  sessionId?: string;
  /** Working directory Claude operates in. */
  cwd: string;
  /** Whether a query is currently running for this chat. */
  busy: boolean;
  /** Epoch ms the current turn started; set alongside `busy`, cleared when idle.
   *  Transient (runtime only) — powers the elapsed-time hint in busy notices. */
  busySince?: number;
  /** Short preview of the prompt the current turn is working on, so busy notices
   *  and /ping can say WHAT it's doing. Transient (runtime only). */
  busyPrompt?: string;
  /** Epoch ms the last "still working" notice was sent to this chat, used to
   *  dedupe a literal double-send (not to go silent). Transient (runtime only). */
  lastBusyNoticeAt?: number;
  /** Count of busy notices sent for the current turn, so the reassurance phrase
   *  rotates instead of repeating. Transient (runtime only). */
  busyNoticeCount?: number;
  /** Aborts the in-flight query (wired to /stop). */
  abort?: AbortController;
  /** Tools "always allowed" without prompting (persists across restarts). */
  sessionAllowedTools: Set<string>;
  /** Bash leading-commands always allowed without prompting (e.g. "git"). */
  allowedBashCmds: Set<string>;
  /** Saved working directories for quick switching via /projects. */
  projects: string[];
  /**
   * supervised       = all tools prompt the user (strictest).
   * standard         = read-only/safe tools auto-allowed, risky tools prompt (default).
   * full             = bypass all permissions (no prompts, autonomous).
   * auto_until_error = auto-allow a trusted tool set until one errors, then
   *                    drop to supervised for the next few calls (then resume).
   */
  autonomy: Autonomy;
  /** Transient escalation state for `auto_until_error` (not persisted). */
  escalation?: Escalation;
  /** BCP 47 language code the agent responds in (undefined = server default). */
  language?: string;
  /** When true, the final reply is also sent back as a spoken voice message. */
  voiceReply?: boolean;
  /** Accumulated cost/duration/turn counters (lifetime + per day). */
  usage: Usage;
  /** Most recent turn's input context size (input + cache-read + cache-write) —
   *  a live proxy for how full the model's context window is. Transient: the SDK
   *  only reveals it once a turn runs, so it starts undefined after a restart
   *  until the next message. Powers /context and the fill-up warning. */
  lastContextTokens?: number;
  /** True once we've nudged about a full context this fill cycle; reset when the
   *  context drops back under the threshold (after /compact or /new) so the
   *  warning fires at most once per fill-up, not every turn. Transient. */
  contextWarned?: boolean;
  /** Epoch ms the last turn finished — powers the stale-cache guard (how long
   *  the prompt cache has been idle, hence likely expired). Transient. */
  lastTurnAt?: number;
}

export class SessionManager {
  private sessions = new Map<number, Session>();
  private saveTimer?: NodeJS.Timeout;
  private stateFile: string;
  /** Chats that have sent a message (or been explicitly marked) this process
   *  lifetime. Lets us detect the first message after a restart so we can offer
   *  to resume the persisted Claude context instead of silently dropping it. */
  private seenThisProcess = new Set<number>();

  /** `stateFile` defaults to STATE_FILE; a bare filename resolves next to it
   *  (so e.g. lead bots can keep their own state alongside the main one). */
  constructor(stateFile?: string) {
    this.stateFile = stateFile
      ? isAbsolute(stateFile)
        ? stateFile
        : resolve(dirname(config.STATE_FILE), stateFile)
      : config.STATE_FILE;
    for (const p of loadState(this.stateFile)) {
      this.sessions.set(p.chatId, {
        chatId: p.chatId,
        sessionId: p.sessionId,
        cwd: p.cwd,
        busy: false, // runtime-only flag; always starts clear so a hard restart can't leave a stale-busy session
        sessionAllowedTools: new Set(p.allowedTools),
        allowedBashCmds: new Set(p.allowedBashCmds),
        projects: p.projects,
        autonomy: p.autonomy,
        language: p.language,
        voiceReply: p.voiceReply,
        usage: p.usage,
      });
    }
  }

  get(chatId: number): Session {
    let s = this.sessions.get(chatId);
    if (!s) {
      s = {
        chatId,
        cwd: config.WORKDIR,
        busy: false,
        sessionAllowedTools: new Set(),
        allowedBashCmds: new Set(),
        projects: [],
        autonomy: "standard",
        usage: emptyUsage(),
      };
      this.sessions.set(chatId, s);
    }
    return s;
  }

  /**
   * Whether this is the first interaction with `chatId` since the process
   * started AND the session was rehydrated from disk with a resumable Claude
   * context. True only once per chat per process: the call marks the chat as
   * seen, so subsequent calls return false. Used to offer a "resume vs fresh"
   * prompt after a restart instead of silently dropping the persisted context.
   */
  isFirstSinceRestart(chatId: number): boolean {
    if (this.seenThisProcess.has(chatId)) return false;
    this.seenThisProcess.add(chatId);
    return Boolean(this.sessions.get(chatId)?.sessionId);
  }

  /** Mark a chat as seen this process without checking (e.g. autonomous runs
   *  that shouldn't trigger a resume prompt on the next user message). */
  markSeen(chatId: number): void {
    this.seenThisProcess.add(chatId);
  }

  /** All live sessions (for shutdown / broadcast). */
  all(): Session[] {
    return [...this.sessions.values()];
  }

  /** Clear the transient `auto_until_error` escalation (e.g. at turn start). */
  resetEscalation(chatId: number): void {
    const s = this.sessions.get(chatId);
    if (s) s.escalation = undefined;
  }

  /** Record that a tool returned an error this turn: in `auto_until_error` mode
   *  this opens a supervised cooldown so the next few calls prompt the user. */
  noteToolError(chatId: number): void {
    const s = this.sessions.get(chatId);
    if (!s || s.autonomy !== "auto_until_error") return;
    s.escalation = { cooldown: AUTO_UNTIL_ERROR_COOLDOWN };
  }

  /** Reset conversation context but keep cwd, autonomy and allow-list. */
  reset(chatId: number): void {
    const s = this.get(chatId);
    s.sessionId = undefined;
    s.lastContextTokens = undefined;
    s.contextWarned = false;
    s.lastTurnAt = undefined;
    this.save();
  }

  /** Record the most recent turn's input context size (the live window-fill
   *  proxy). Clears the one-shot warning latch once the context drops back under
   *  `warnAt` (e.g. after a /compact or /new), so the next fill-up warns again.
   *  Returns true exactly once per fill cycle: when this turn first crosses
   *  `warnAt` and we haven't warned yet — the caller sends the nudge. */
  recordContext(chatId: number, tokens: number, warnAt: number): boolean {
    const s = this.get(chatId);
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

  /** Abort every in-flight turn and clear all conversation context (a clean
   *  slate so the next message starts fresh, e.g. after switching models).
   *  Returns how many turns were aborted. */
  resetAll(): { sessions: number; aborted: number } {
    let aborted = 0;
    const all = this.all();
    for (const s of all) {
      if (s.busy && s.abort) {
        s.abort.abort();
        aborted++;
      }
      s.sessionId = undefined;
    }
    this.save();
    return { sessions: all.length, aborted };
  }

  /** Fold one turn's cost/duration/tokens into the session's lifetime + today buckets. */
  recordUsage(chatId: number, u: TurnUsage): void {
    const s = this.get(chatId);
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

  /** Persist all sessions, debounced so bursts of mutations write once. */
  save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      saveState(this.all().map(toPersisted), this.stateFile);
    }, 500);
    this.saveTimer.unref?.();
  }

  /** Flush any pending debounced write immediately (used on shutdown). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    saveState(this.all().map(toPersisted), this.stateFile);
  }
}

function toPersisted(s: Session): PersistedSession {
  return {
    chatId: s.chatId,
    sessionId: s.sessionId,
    cwd: s.cwd,
    autonomy: s.autonomy,
    language: s.language,
    voiceReply: s.voiceReply,
    allowedTools: [...s.sessionAllowedTools],
    allowedBashCmds: [...s.allowedBashCmds],
    projects: s.projects,
    usage: s.usage,
  };
}

export const sessions = new SessionManager();
