import { useEffect, useState } from "react";
import { api, AuthError, type Column, type Priority, type Task, type Wip } from "../api.ts";
import { useTaskEvents, type LiveTask } from "../lib/useTaskEvents.ts";
import { Button, Empty, Input, TextArea } from "./ui.tsx";

const COLUMN_META: Record<Column, { label: string; tone: string }> = {
  backlog: { label: "Backlog", tone: "text-fg-dim" },
  doing: { label: "In progress", tone: "text-accent" },
  done: { label: "Done", tone: "text-emerald-400" },
};

const PRIO_DOT: Record<Priority, string> = {
  high: "bg-red-500",
  normal: "bg-fg-faint",
  low: "bg-sky-500",
};

const DAY = 86_400_000;

export function TasksView({ onAuthError }: { onAuthError: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [columns, setColumns] = useState<Column[]>(["backlog", "doing", "done"]);
  const [wip, setWip] = useState<Wip>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .tasks()
      .then((r) => {
        setTasks(r.tasks);
        setColumns(r.columns);
        setWip(r.wip);
      })
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = useTaskEvents(load);

  const inColumn = (c: Column) =>
    tasks.filter((t) => t.column === c).sort((a, b) => a.order - b.order);

  const drop = async (target: Column, beforeId: string | null) => {
    if (!dragId) return;
    const moved = tasks.find((t) => t.id === dragId);
    setDragId(null);
    if (!moved) return;
    const list = inColumn(target).filter((t) => t.id !== dragId);
    const idx = beforeId ? list.findIndex((t) => t.id === beforeId) : list.length;
    list.splice(idx < 0 ? list.length : idx, 0, moved);
    const moves = list.map((t, i) => ({ id: t.id, column: target, order: i }));
    setTasks((prev) =>
      prev.map((t) => {
        const m = moves.find((x) => x.id === t.id);
        return m ? { ...t, column: target, order: m.order } : t;
      }),
    );
    try {
      const r = await api.reorderTasks(moves);
      setTasks(r.tasks);
    } catch {
      void load();
    }
  };

  const editWip = async (col: Column) => {
    const cur = wip[col];
    const input = prompt(`WIP limit for "${COLUMN_META[col].label}" (blank to clear):`, cur ? String(cur) : "");
    if (input === null) return;
    const limit = input.trim() === "" ? null : Number(input);
    if (limit !== null && Number.isNaN(limit)) return;
    const r = await api.setWip(col, limit);
    setWip(r.wip);
  };

  if (error) return <Empty>Failed to load: {error}</Empty>;

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {columns.map((col) => {
        const cards = inColumn(col);
        const limit = wip[col];
        const over = limit != null && cards.length > limit;
        return (
          <div
            key={col}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => drop(col, null)}
            className="flex flex-col rounded-xl border border-line bg-surface p-3"
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className={`text-xs font-semibold uppercase tracking-wider ${COLUMN_META[col].tone}`}>
                {COLUMN_META[col].label}
              </h3>
              <button
                onClick={() => editWip(col)}
                title="Set WIP limit"
                className={`tabular rounded px-1.5 text-xs ${over ? "bg-red-500/15 text-red-400" : "text-fg-faint hover:text-fg-dim"}`}
              >
                {cards.length}
                {limit != null && ` / ${limit}`}
              </button>
            </div>

            <div className="flex flex-1 flex-col gap-2">
              {cards.map((t) => (
                <Card
                  key={t.id}
                  task={t}
                  live={live[t.id]}
                  onDragStart={() => setDragId(t.id)}
                  onDropBefore={() => drop(col, t.id)}
                  onChange={load}
                  onAuthError={onAuthError}
                />
              ))}
            </div>

            <AddCard column={col} onAdded={load} onAuthError={onAuthError} />
          </div>
        );
      })}
    </div>
  );
}

function ageBorder(task: Task): string {
  if (task.column === "done") return "border-line";
  const age = Date.now() - task.updatedAt;
  if (age > 14 * DAY) return "border-l-2 border-l-red-500/60 border-line";
  if (age > 7 * DAY) return "border-l-2 border-l-amber-500/50 border-line";
  return "border-line";
}

function Card({
  task,
  live,
  onDragStart,
  onDropBefore,
  onChange,
  onAuthError,
}: {
  task: Task;
  live?: LiveTask;
  onDragStart: () => void;
  onDropBefore: () => void;
  onChange: () => void;
  onAuthError: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const [priority, setPriority] = useState<Priority>(task.priority);

  const running = live?.status === "running" || task.delegate?.status === "running";
  const dstatus = live?.status ?? task.delegate?.status;

  const save = async () => {
    try {
      await api.updateTask(task.id, { title, notes, priority });
      setEditing(false);
      onChange();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    }
  };
  const del = async () => {
    if (!confirm("Delete this card?")) return;
    await api.deleteTask(task.id);
    onChange();
  };
  const delegate = async () => {
    await api.delegateTask(task.id).catch(() => {});
  };
  const stop = async () => {
    await api.stopTask(task.id).catch(() => {});
  };

  if (editing) {
    return (
      <div className="rounded-lg border border-accent/40 bg-input p-2">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mb-2" />
        <TextArea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes…"
          className="mb-2 !font-sans"
        />
        <div className="mb-2 flex gap-1">
          {(["low", "normal", "high"] as Priority[]).map((p) => (
            <button
              key={p}
              onClick={() => setPriority(p)}
              className={`rounded px-2 py-0.5 text-xs capitalize ${
                priority === p ? "bg-accent/15 text-accent" : "text-fg-dim hover:bg-surface-2"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          <Button variant="primary" onClick={save}>
            Save
          </Button>
          <Button onClick={() => setEditing(false)}>Cancel</Button>
          <Button variant="danger" className="ml-auto" onClick={del}>
            Delete
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      draggable={!running}
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.stopPropagation();
        onDropBefore();
      }}
      className={`rounded-lg border bg-input p-2.5 ${ageBorder(task)}`}
    >
      <div className="flex items-start gap-2">
        <span
          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${PRIO_DOT[task.priority]}`}
          title={`${task.priority} priority`}
        />
        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setEditing(true)}>
          <div className="text-sm text-fg">{task.title}</div>
          {task.notes && <div className="mt-1 line-clamp-3 text-xs text-fg-dim">{task.notes}</div>}
          {task.parentId && <div className="mt-1 text-xs text-fg-faint">↳ subtask</div>}
        </div>
      </div>

      {(running || dstatus) && (
        <div className="mt-2 rounded border border-line bg-surface p-2">
          <div className="mb-1 flex items-center justify-between">
            <span
              className={`text-xs font-medium ${
                dstatus === "ok"
                  ? "text-emerald-400"
                  : dstatus === "error"
                    ? "text-red-400"
                    : dstatus === "stopped"
                      ? "text-fg-dim"
                      : "text-accent"
              }`}
            >
              {running ? "⚙ running" : `delegated · ${dstatus}`}
            </span>
            {running && (
              <button onClick={stop} className="text-xs text-red-400 hover:underline">
                Stop
              </button>
            )}
          </div>
          {live?.tool && <div className="mono text-xs text-fg-dim">{live.tool}</div>}
          {(live?.output || task.delegate?.output) && (
            <div className="mono mt-1 line-clamp-4 whitespace-pre-wrap text-xs text-fg-faint">
              {live?.output || task.delegate?.output}
            </div>
          )}
          {task.delegate?.error && <div className="mt-1 text-xs text-red-400">{task.delegate.error}</div>}
        </div>
      )}

      {!running && task.column !== "done" && (
        <button
          onClick={delegate}
          className="mt-2 w-full rounded border border-line py-1 text-xs text-fg-dim hover:bg-surface-2 hover:text-fg"
        >
          Delegate to agent
        </button>
      )}
    </div>
  );
}

function AddCard({
  column,
  onAdded,
  onAuthError,
}: {
  column: Column;
  onAdded: () => void;
  onAuthError: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  const add = async () => {
    if (!title.trim()) return setAdding(false);
    try {
      await api.createTask({ title, column });
      setTitle("");
      setAdding(false);
      onAdded();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    }
  };

  if (!adding)
    return (
      <button
        onClick={() => setAdding(true)}
        className="mt-2 rounded-lg px-2 py-1.5 text-left text-xs text-fg-faint hover:bg-surface-2 hover:text-fg-dim"
      >
        + Add card
      </button>
    );

  return (
    <div className="mt-2">
      <Input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && add()}
        onBlur={add}
        placeholder="Card title…"
      />
    </div>
  );
}
