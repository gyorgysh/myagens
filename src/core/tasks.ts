import { randomBytes } from "node:crypto";
import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";

const FILE = "tasks.json";

export const COLUMNS = ["backlog", "doing", "done"] as const;
export type Column = (typeof COLUMNS)[number];

export interface Task {
  id: string;
  title: string;
  notes: string;
  column: Column;
  /** Sort position within its column (ascending). */
  order: number;
  createdAt: number;
  updatedAt: number;
}

interface TaskFile {
  version: 1;
  tasks: Task[];
}

function load(): Task[] {
  return loadJson<TaskFile>(FILE, { version: 1, tasks: [] }).tasks;
}

function persist(tasks: Task[]): void {
  saveJson<TaskFile>(FILE, { version: 1, tasks });
}

function isColumn(v: unknown): v is Column {
  return typeof v === "string" && (COLUMNS as readonly string[]).includes(v);
}

export function listTasks(): Task[] {
  return load().sort((a, b) => a.order - b.order);
}

export function createTask(input: { title: string; notes?: string; column?: string }): Task {
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
  order?: number;
}

export function updateTask(id: string, patch: TaskPatch): Task | undefined {
  const tasks = load();
  const task = tasks.find((t) => t.id === id);
  if (!task) return undefined;
  if (patch.title !== undefined) task.title = patch.title.trim() || task.title;
  if (patch.notes !== undefined) task.notes = patch.notes.trim();
  if (isColumn(patch.column)) task.column = patch.column;
  if (typeof patch.order === "number") task.order = patch.order;
  task.updatedAt = Date.now();
  persist(tasks);
  audit("task.update", { id, column: task.column });
  return task;
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
