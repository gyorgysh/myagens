import { randomBytes } from "node:crypto";
import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";

const FILE = "tasks.json";

export const COLUMNS = ["backlog", "doing", "done"] as const;
export type Column = (typeof COLUMNS)[number];

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
  wip?: Partial<Record<Column, number>>;
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

function persist(tasks: Task[], wip?: Partial<Record<Column, number>>): void {
  const current = loadFile();
  saveJson<TaskFile>(FILE, { version: 1, tasks, wip: wip ?? current.wip });
}

function isColumn(v: unknown): v is Column {
  return typeof v === "string" && (COLUMNS as readonly string[]).includes(v);
}

function isPriority(v: unknown): v is Priority {
  return typeof v === "string" && (PRIORITIES as readonly string[]).includes(v);
}

export function listTasks(): Task[] {
  return load().sort((a, b) => a.order - b.order);
}

export function getWip(): Partial<Record<Column, number>> {
  return loadFile().wip ?? {};
}

export function setWip(column: string, limit: number | null): Partial<Record<Column, number>> {
  if (!isColumn(column)) return getWip();
  const wip = { ...getWip() };
  if (limit == null || limit <= 0) delete wip[column];
  else wip[column] = Math.floor(limit);
  persist(load(), wip);
  audit("task.wip", { column, limit });
  return wip;
}

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
  const column = isColumn(input.column) ? input.column : "backlog";
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
