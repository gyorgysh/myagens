import { randomBytes } from "node:crypto";
import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";
import { isValidColumn, getColumnIds } from "./columnConfig.js";

const FILE = "tasks.json";

/** Column id is now an arbitrary string defined by the column config store. */
export type Column = string;

/** @deprecated Use listColumns() from columnConfig.ts for the full column list. */
export const COLUMNS = getColumnIds();

export const PRIORITIES = ["low", "normal", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Live state of a card delegated to an autonomous agent run. */
export interface TaskDelegation {
  status: "queued" | "running" | "ok" | "error" | "stopped";
  runId: string;
  startedAt: number;
  endedAt?: number;
  error?: string;
  /** Tail of streamed output (capped). */
  output?: string;
  /**
   * Claude resume token captured from the run. Kept across a failure so a retry
   * can resume the same conversation (continuing where it broke) instead of
   * starting the task over from scratch. Cleared once the card lands in done.
   */
  sessionId?: string;
}

/**
 * Recurrence rule for a card that should repeat. The card carrying this rule is
 * the *template*: it stays where it is, and on each due time a fresh copy of its
 * title/notes/priority is dropped into the backlog column. Self-contained on
 * purpose (not the schedule subsystem's ScheduleSpec) — a card only repeats on a
 * simple wall-clock cadence.
 */
export type Recurrence =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; dayOfWeek: number; hour: number; minute: number } // 0=Sun..6=Sat
  | { kind: "monthly"; dayOfMonth: number; hour: number; minute: number }; // 1..31

export interface TaskRecurrence {
  rule: Recurrence;
  /** Epoch ms of the next copy. Advanced after each fire. */
  nextRunAt: number;
  /** Epoch ms of the last copy created (for display / dedupe). */
  lastRunAt?: number;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  column: Column;
  priority: Priority;
  /**
   * If set, this card is a recurring *template*: it stays put and spawns a fresh
   * copy into the backlog on its cadence. Copies do not carry the recurrence.
   */
  recurrence?: TaskRecurrence;
  /** Optional parent for agent-created subtasks (auto-breakdown). */
  parentId?: string;
  /**
   * Ids of cards this one is blocked by: a delegated run waits until every
   * prerequisite is in the done column before it can execute. Self-references
   * and unknown ids are tolerated (treated as not-blocking).
   */
  blockedBy?: string[];
  /** Set while/after the card has been delegated to an agent run. */
  delegate?: TaskDelegation;
  /** How many times this card has been re-delegated after a failure. */
  retryCount?: number;
  /**
   * Claude resume token carried over from a failed run by prepareRetry(), so the
   * next delegated run can resume that conversation instead of starting over.
   * Consumed (cleared) by the task runner when it picks the card up.
   */
  resumeSessionId?: string;
  /** Sort position within its column (ascending). */
  order: number;
  /**
   * Who created the card: an agent id ("atlas", a worker/lead id) when made via
   * the MCP task_create tool, or "panel" for the panel/REST. Undefined on cards
   * created before this field existed.
   */
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
}

/** Global delegation controls for autonomous task runs. */
export interface TaskRunConfig {
  /** Abort a delegated run after this many ms (0 = no timeout). Default 1800000 (30 min). */
  timeoutMs: number;
  /** Max delegated runs allowed to execute at once; the rest queue (0 = unlimited). Default 3. */
  maxConcurrent: number;
}

export const DEFAULT_TASK_CONFIG: TaskRunConfig = { timeoutMs: 1_800_000, maxConcurrent: 3 };

interface TaskFile {
  version: 1;
  tasks: Task[];
  /** Optional WIP limit per column (advisory; surfaced in the panel). */
  wip?: Record<string, number>;
  /** Delegation timeout + concurrency settings. */
  runConfig?: TaskRunConfig;
}

function loadFile(): TaskFile {
  const f = loadJson<TaskFile>(FILE, { version: 1, tasks: [] });
  // Backfill defaults for fields added after the first release.
  for (const t of f.tasks) if (!t.priority) t.priority = "normal";
  return f;
}

function load(): Task[] {
  return loadFile().tasks;
}

function persist(tasks: Task[], wip?: Record<string, number>): void {
  const current = loadFile();
  saveJson<TaskFile>(FILE, { version: 1, tasks, wip: wip ?? current.wip, runConfig: current.runConfig });
}

/** Global delegation timeout + concurrency config (with defaults filled in). */
export function getTaskRunConfig(): TaskRunConfig {
  return { ...DEFAULT_TASK_CONFIG, ...(loadFile().runConfig ?? {}) };
}

/** Update the delegation timeout + concurrency config. Clamps to sane bounds. */
export function setTaskRunConfig(patch: Partial<TaskRunConfig>): TaskRunConfig {
  const cur = getTaskRunConfig();
  const next: TaskRunConfig = {
    timeoutMs: patch.timeoutMs != null ? Math.max(0, Math.floor(patch.timeoutMs)) : cur.timeoutMs,
    maxConcurrent: patch.maxConcurrent != null ? Math.max(0, Math.floor(patch.maxConcurrent)) : cur.maxConcurrent,
  };
  const f = loadFile();
  saveJson<TaskFile>(FILE, { version: 1, tasks: f.tasks, wip: f.wip, runConfig: next });
  audit("task.runConfig", { ...next });
  return next;
}

function isColumn(v: unknown): v is Column {
  return typeof v === "string" && isValidColumn(v);
}

function isPriority(v: unknown): v is Priority {
  return typeof v === "string" && (PRIORITIES as readonly string[]).includes(v);
}

/** Compute the next firing time (epoch ms) at or after `from` for a recurrence. */
export function nextRecurrence(rule: Recurrence, from: number): number {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(rule.hour, rule.minute);
  if (rule.kind === "daily") {
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (rule.kind === "weekly") {
    // Advance to the target weekday (today counts only if the time is still ahead).
    let delta = (rule.dayOfWeek - d.getDay() + 7) % 7;
    if (delta === 0 && d.getTime() <= from) delta = 7;
    d.setDate(d.getDate() + delta);
    return d.getTime();
  }
  // monthly: the Nth of each month. Clamp to the last day of short months.
  const setDom = (base: Date) => {
    const y = base.getFullYear();
    const m = base.getMonth();
    const lastDom = new Date(y, m + 1, 0).getDate();
    base.setDate(Math.min(rule.dayOfMonth, lastDom));
  };
  setDom(d);
  if (d.getTime() <= from) {
    d.setDate(1); // avoid month overflow before re-clamping
    d.setMonth(d.getMonth() + 1);
    setDom(d);
  }
  return d.getTime();
}

/** Validate + normalise a recurrence rule from untrusted input. */
export function normalizeRecurrence(input: unknown): Recurrence | undefined {
  if (!input || typeof input !== "object") return undefined;
  const r = input as Record<string, unknown>;
  const hour = Number(r.hour);
  const minute = Number(r.minute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  if (r.kind === "daily") return { kind: "daily", hour, minute };
  if (r.kind === "weekly") {
    const dow = Number(r.dayOfWeek);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return undefined;
    return { kind: "weekly", dayOfWeek: dow, hour, minute };
  }
  if (r.kind === "monthly") {
    const dom = Number(r.dayOfMonth);
    if (!Number.isInteger(dom) || dom < 1 || dom > 31) return undefined;
    return { kind: "monthly", dayOfMonth: dom, hour, minute };
  }
  return undefined;
}

export function listTasks(): Task[] {
  return load().sort((a, b) => a.order - b.order);
}

export function getWip(): Record<string, number> {
  return loadFile().wip ?? {};
}

export function setWip(column: string, limit: number | null): Record<string, number> {
  const wip = { ...getWip() };
  if (limit == null || limit <= 0) delete wip[column];
  else wip[column] = Math.floor(limit);
  persist(load(), wip);
  audit("task.wip", { column, limit });
  return wip;
}

/** Re-export column list for callers that only import tasks.ts. */
export { listColumns, getColumnIds } from "./columnConfig.js";

/** Update just the delegation state of a card (used by the task runner). */
export function setDelegate(id: string, delegate: TaskDelegation | undefined): Task | undefined {
  const tasks = load();
  const task = tasks.find((t) => t.id === id);
  if (!task) return undefined;
  task.delegate = delegate;
  task.updatedAt = Date.now();
  persist(tasks);
  return task;
}

/**
 * Reset an errored card so it can be re-delegated: move it back to the first
 * (backlog) column, clear its delegation error state, and bump retryCount so
 * runaway retries are visible. The failed run's Claude session token is carried
 * over to `resumeSessionId` so the retry resumes that conversation (continuing
 * from where it broke) rather than starting the task from scratch. Returns the
 * updated card, or undefined if it doesn't exist. The actual re-delegation is
 * kicked off by the caller.
 */
export function prepareRetry(id: string): Task | undefined {
  const tasks = load();
  const task = tasks.find((t) => t.id === id);
  if (!task) return undefined;
  const backlog = getColumnIds()[0] ?? "backlog";
  const maxOrder = Math.max(0, ...tasks.filter((t) => t.column === backlog).map((t) => t.order));
  task.retryCount = (task.retryCount ?? 0) + 1;
  // Preserve the resume token before clearing the delegation so the next run
  // can pick up the same conversation.
  task.resumeSessionId = task.delegate?.sessionId;
  task.delegate = undefined;
  task.column = backlog;
  task.order = maxOrder + 1;
  task.updatedAt = Date.now();
  persist(tasks);
  audit("task.retry", { id, retryCount: task.retryCount, resume: !!task.resumeSessionId });
  return task;
}

/**
 * Read and clear a card's pending `resumeSessionId` (set by prepareRetry). The
 * task runner calls this when it picks the card up so the resume token is used
 * exactly once: the next run resumes that session, a fresh delegation does not.
 */
export function consumeResumeSession(id: string): string | undefined {
  const tasks = load();
  const task = tasks.find((t) => t.id === id);
  if (!task) return undefined;
  const token = task.resumeSessionId;
  if (token === undefined) return undefined;
  task.resumeSessionId = undefined;
  task.updatedAt = Date.now();
  persist(tasks);
  return token;
}

/** Normalise a blockedBy list: dedupe, drop the card's own id, keep only strings. */
function cleanBlockedBy(ids: unknown, selfId?: string): string[] | undefined {
  if (!Array.isArray(ids)) return undefined;
  const out = [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))].filter(
    (id) => id !== selfId,
  );
  return out.length ? out : [];
}

/**
 * Of a card's `blockedBy` prerequisites, return the ones that are NOT yet
 * satisfied (i.e. not in the done column). An empty array means the card is
 * free to run. Unknown ids are ignored (a deleted prerequisite no longer blocks).
 */
export function blockingPrereqs(id: string): Task[] {
  const tasks = load();
  const card = tasks.find((t) => t.id === id);
  if (!card?.blockedBy?.length) return [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return card.blockedBy
    .map((bid) => byId.get(bid))
    .filter((t): t is Task => !!t && t.column !== "done" && t.column !== "archive");
}

/** True when every prerequisite of the card is satisfied (or it has none). */
export function isUnblocked(id: string): boolean {
  return blockingPrereqs(id).length === 0;
}

export function createTask(input: {
  title: string;
  notes?: string;
  column?: string;
  priority?: string;
  parentId?: string;
  blockedBy?: string[];
  createdBy?: string;
  recurrence?: unknown;
}): Task {
  const now = Date.now();
  const validCols = getColumnIds();
  const column = isColumn(input.column) ? input.column : (validCols[0] ?? "backlog");
  const tasks = load();
  // New card goes to the end of its column.
  const maxOrder = Math.max(0, ...tasks.filter((t) => t.column === column).map((t) => t.order));
  const rule = normalizeRecurrence(input.recurrence);
  const task: Task = {
    id: randomBytes(4).toString("hex"),
    title: input.title.trim() || "Untitled",
    notes: input.notes?.trim() ?? "",
    column,
    priority: isPriority(input.priority) ? input.priority : "normal",
    recurrence: rule ? { rule, nextRunAt: nextRecurrence(rule, now) } : undefined,
    parentId: input.parentId,
    blockedBy: cleanBlockedBy(input.blockedBy),
    order: maxOrder + 1,
    createdBy: input.createdBy?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  tasks.push(task);
  persist(tasks);
  audit("task.create", { id: task.id, column });
  return task;
}

export interface TaskPatch {
  title?: string;
  notes?: string;
  column?: string;
  priority?: string;
  order?: number;
  /** Replace the card's prerequisite list (pass [] to clear). */
  blockedBy?: string[];
  /**
   * Set/replace the recurrence rule, or pass `null` to stop the card repeating.
   * Anything else (a malformed object) is ignored.
   */
  recurrence?: Recurrence | null;
}

export function updateTask(id: string, patch: TaskPatch): Task | undefined {
  const tasks = load();
  const task = tasks.find((t) => t.id === id);
  if (!task) return undefined;
  if (patch.title !== undefined) task.title = patch.title.trim() || task.title;
  if (patch.notes !== undefined) task.notes = patch.notes.trim();
  if (isColumn(patch.column)) task.column = patch.column;
  if (isPriority(patch.priority)) task.priority = patch.priority;
  if (typeof patch.order === "number") task.order = patch.order;
  if (patch.blockedBy !== undefined) task.blockedBy = cleanBlockedBy(patch.blockedBy, id);
  if (patch.recurrence === null) {
    task.recurrence = undefined;
  } else if (patch.recurrence !== undefined) {
    const rule = normalizeRecurrence(patch.recurrence);
    if (rule) {
      // Keep lastRunAt if the cadence is unchanged; recompute nextRunAt either way.
      task.recurrence = {
        rule,
        nextRunAt: nextRecurrence(rule, Date.now()),
        lastRunAt: task.recurrence?.lastRunAt,
      };
    }
  }
  task.updatedAt = Date.now();
  persist(tasks);
  audit("task.update", { id, column: task.column });
  return task;
}

export function getTask(id: string): Task | undefined {
  return load().find((t) => t.id === id);
}

/** Apply an ordered list of {id, column, order} moves atomically (drag-drop). */
export function reorderTasks(moves: Array<{ id: string; column: string; order: number }>): Task[] {
  const tasks = load();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const m of moves) {
    const t = byId.get(m.id);
    if (!t) continue;
    if (isColumn(m.column)) t.column = m.column;
    t.order = m.order;
    t.updatedAt = Date.now();
  }
  persist(tasks);
  audit("task.reorder", { count: moves.length });
  return listTasks();
}

export function deleteTask(id: string): boolean {
  const tasks = load();
  const next = tasks.filter((t) => t.id !== id);
  if (next.length === tasks.length) return false;
  persist(next);
  audit("task.delete", { id });
  return true;
}

/**
 * Move a card to the archive column. Notes and delegation history are kept
 * intact so a restored card arrives with its full context.
 */
export function archiveTask(id: string): Task | undefined {
  const tasks = load();
  const task = tasks.find((t) => t.id === id);
  if (!task || task.column === "archive") return task;
  const maxOrder = Math.max(0, ...tasks.filter((t) => t.column === "archive").map((t) => t.order));
  task.column = "archive";
  task.order = maxOrder + 1;
  task.updatedAt = Date.now();
  persist(tasks);
  audit("task.archive", { id });
  return task;
}

/**
 * Remove archived cards that are older than 7 days.
 * Called on each GET /api/tasks so the board self-cleans passively.
 */
export function pruneArchive(): void {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const tasks = load();
  const cutoff = Date.now() - WEEK;
  const next = tasks.filter((t) => !(t.column === "archive" && t.updatedAt < cutoff));
  if (next.length !== tasks.length) persist(next);
}

/**
 * Auto-archive candidates:
 * - Any non-archive column that has >50 cards: archive the oldest (lowest updatedAt) ones to stay at 50.
 * - Done cards older than 1 day move to archive.
 */
export function autoArchive(): void {
  const DAY = 24 * 60 * 60 * 1000;
  let tasks = load();
  const cutoff = Date.now() - DAY;
  let changed = false;

  // Archive done cards older than 1 day.
  for (const t of tasks) {
    if (t.column === "done" && t.updatedAt < cutoff) {
      t.column = "archive";
      t.notes = "";
      t.delegate = undefined;
      t.updatedAt = Date.now();
      changed = true;
    }
  }

  // Re-load column counts after the done sweep.
  const byCols: Record<string, Task[]> = {};
  for (const t of tasks) {
    if (t.column === "archive") continue;
    (byCols[t.column] ??= []).push(t);
  }
  for (const [col, cards] of Object.entries(byCols)) {
    if (cards.length <= 50) continue;
    const sorted = [...cards].sort((a, b) => a.updatedAt - b.updatedAt);
    const toArchive = sorted.slice(0, cards.length - 50);
    const ids = new Set(toArchive.map((t) => t.id));
    for (const t of tasks) {
      if (ids.has(t.id)) {
        t.column = "archive";
        t.notes = "";
        t.delegate = undefined;
        t.updatedAt = Date.now();
        changed = true;
      }
    }
    audit("task.auto_archive", { col, count: toArchive.length });
  }

  if (changed) persist(tasks);
}

/**
 * Spawn fresh backlog copies for any recurring template whose nextRunAt has
 * passed, advancing each template's schedule. The template card itself is left
 * in place; the copy carries the title/notes/priority but NOT the recurrence
 * (so copies never repeat themselves). Returns the ids of the cards created so
 * callers can broadcast / log. Safe to call frequently — it's a no-op when
 * nothing is due. Catches up missed fires by advancing to the next future slot.
 */
export function runDueRecurrences(): string[] {
  const now = Date.now();
  const tasks = load();
  const templates = tasks.filter((t) => t.recurrence && t.recurrence.nextRunAt <= now);
  if (templates.length === 0) return [];
  const backlog = getColumnIds()[0] ?? "backlog";
  const created: string[] = [];
  for (const tpl of templates) {
    const rec = tpl.recurrence!;
    const maxOrder = Math.max(0, ...tasks.filter((t) => t.column === backlog).map((t) => t.order));
    const copy: Task = {
      id: randomBytes(4).toString("hex"),
      title: tpl.title,
      notes: tpl.notes,
      column: backlog,
      priority: tpl.priority,
      order: maxOrder + 1,
      createdBy: "schedule",
      createdAt: now,
      updatedAt: now,
    };
    tasks.push(copy);
    created.push(copy.id);
    // Advance to the next future slot (skip any missed ones in one hop).
    let nextAt = nextRecurrence(rec.rule, now);
    if (nextAt <= now) nextAt = nextRecurrence(rec.rule, nextAt);
    rec.lastRunAt = now;
    rec.nextRunAt = nextAt;
    audit("task.recurrence_fire", { templateId: tpl.id, copyId: copy.id });
  }
  persist(tasks);
  return created;
}

let recurrenceTimer: ReturnType<typeof setInterval> | undefined;
/**
 * Optional sink for "cards were just spawned by recurrence" notifications. The
 * panel server registers one so it can push a board refresh to clients; if the
 * panel is disabled this stays unset and the ticker simply creates the cards.
 */
let recurrenceListener: ((ids: string[]) => void) | undefined;

/** Register a callback invoked with new card ids each time recurrences fire. */
export function onRecurrenceFire(fn: (ids: string[]) => void): void {
  recurrenceListener = fn;
}

/**
 * Start the recurring-card ticker: every 60s it spawns backlog copies for any
 * due template. Idempotent — a second call is a no-op. Runs regardless of the
 * panel; live refreshes flow through {@link onRecurrenceFire} when registered.
 */
export function startRecurrenceTicker(): void {
  if (recurrenceTimer) return;
  const tick = () => {
    try {
      const ids = runDueRecurrences();
      if (ids.length) recurrenceListener?.(ids);
    } catch {
      // Never let a bad rule kill the ticker.
    }
  };
  recurrenceTimer = setInterval(tick, 60_000);
  recurrenceTimer.unref?.();
  tick(); // catch up immediately on boot
}

export function stopRecurrenceTicker(): void {
  if (recurrenceTimer) {
    clearInterval(recurrenceTimer);
    recurrenceTimer = undefined;
  }
}
