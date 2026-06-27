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
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  column: Column;
  priority: Priority;
  /** Optional parent for agent-created subtasks (auto-breakdown). */
  parentId?: string;
  /** Set while/after the card has been delegated to an agent run. */
  delegate?: TaskDelegation;
  /** How many times this card has been re-delegated after a failure. */
  retryCount?: number;
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
  /** Abort a delegated run after this many ms (0 = no timeout). Default 600000 (10 min). */
  timeoutMs: number;
  /** Max delegated runs allowed to execute at once; the rest queue (0 = unlimited). Default 3. */
  maxConcurrent: number;
}

export const DEFAULT_TASK_CONFIG: TaskRunConfig = { timeoutMs: 600_000, maxConcurrent: 3 };

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
 * runaway retries are visible. Returns the updated card, or undefined if it
 * doesn't exist. The actual re-delegation is kicked off by the caller.
 */
export function prepareRetry(id: string): Task | undefined {
  const tasks = load();
  const task = tasks.find((t) => t.id === id);
  if (!task) return undefined;
  const backlog = getColumnIds()[0] ?? "backlog";
  const maxOrder = Math.max(0, ...tasks.filter((t) => t.column === backlog).map((t) => t.order));
  task.retryCount = (task.retryCount ?? 0) + 1;
  task.delegate = undefined;
  task.column = backlog;
  task.order = maxOrder + 1;
  task.updatedAt = Date.now();
  persist(tasks);
  audit("task.retry", { id, retryCount: task.retryCount });
  return task;
}

export function createTask(input: {
  title: string;
  notes?: string;
  column?: string;
  priority?: string;
  parentId?: string;
  createdBy?: string;
}): Task {
  const now = Date.now();
  const validCols = getColumnIds();
  const column = isColumn(input.column) ? input.column : (validCols[0] ?? "backlog");
  const tasks = load();
  // New card goes to the end of its column.
  const maxOrder = Math.max(0, ...tasks.filter((t) => t.column === column).map((t) => t.order));
  const task: Task = {
    id: randomBytes(4).toString("hex"),
    title: input.title.trim() || "Untitled",
    notes: input.notes?.trim() ?? "",
    column,
    priority: isPriority(input.priority) ? input.priority : "normal",
    parentId: input.parentId,
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
 * - Any non-archive column that has >10 cards: archive the oldest (lowest updatedAt) ones to stay at 10.
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
    if (cards.length <= 20) continue;
    const sorted = [...cards].sort((a, b) => a.updatedAt - b.updatedAt);
    const toArchive = sorted.slice(0, cards.length - 20);
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
