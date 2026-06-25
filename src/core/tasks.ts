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
  status: "running" | "ok" | "error" | "stopped";
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
  /** Sort position within its column (ascending). */
  order: number;
  createdAt: number;
  updatedAt: number;
}

interface TaskFile {
  version: 1;
  tasks: Task[];
  /** Optional WIP limit per column (advisory; surfaced in the panel). */
  wip?: Record<string, number>;
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
  saveJson<TaskFile>(FILE, { version: 1, tasks, wip: wip ?? current.wip });
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

export function createTask(input: {
  title: string;
  notes?: string;
  column?: string;
  priority?: string;
  parentId?: string;
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
 * Move a card to the archive column, stripping notes/delegation data so the
 * archive stays lightweight (title + metadata only).
 */
export function archiveTask(id: string): Task | undefined {
  const tasks = load();
  const task = tasks.find((t) => t.id === id);
  if (!task || task.column === "archive") return task;
  const maxOrder = Math.max(0, ...tasks.filter((t) => t.column === "archive").map((t) => t.order));
  task.column = "archive";
  task.notes = "";
  task.delegate = undefined;
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
    if (cards.length <= 10) continue;
    const sorted = [...cards].sort((a, b) => a.updatedAt - b.updatedAt);
    const toArchive = sorted.slice(0, cards.length - 10);
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
