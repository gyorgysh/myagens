import { useEffect, useState } from "react";
import { api, AuthError, type Column, type Task } from "../api.ts";
import { Button, Empty, Input, TextArea } from "./ui.tsx";

const COLUMN_META: Record<Column, { label: string; tone: string }> = {
  backlog: { label: "Backlog", tone: "text-fg-dim" },
  doing: { label: "In progress", tone: "text-blue-400" },
  done: { label: "Done", tone: "text-emerald-400" },
};

export function TasksView({ onAuthError }: { onAuthError: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [columns, setColumns] = useState<Column[]>(["backlog", "doing", "done"]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .tasks()
      .then((r) => {
        setTasks(r.tasks);
        setColumns(r.columns);
      })
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inColumn = (c: Column) =>
    tasks.filter((t) => t.column === c).sort((a, b) => a.order - b.order);

  // Recompute ordering when a card is dropped into `target` before `beforeId`.
  const drop = async (target: Column, beforeId: string | null) => {
    if (!dragId) return;
    const moved = tasks.find((t) => t.id === dragId);
    setDragId(null);
    if (!moved) return;

    const list = inColumn(target).filter((t) => t.id !== dragId);
    const idx = beforeId ? list.findIndex((t) => t.id === beforeId) : list.length;
    list.splice(idx < 0 ? list.length : idx, 0, moved);

    const moves = list.map((t, i) => ({ id: t.id, column: target, order: i }));
    // Optimistic local update.
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

  if (error) return <Empty>Failed to load: {error}</Empty>;

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {columns.map((col) => (
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
            <span className="tabular text-xs text-fg-faint">{inColumn(col).length}</span>
          </div>

          <div className="flex flex-1 flex-col gap-2">
            {inColumn(col).map((t) => (
              <Card
                key={t.id}
                task={t}
                onDragStart={() => setDragId(t.id)}
                onDropBefore={() => drop(col, t.id)}
                onChange={load}
                onAuthError={onAuthError}
              />
            ))}
          </div>

          <AddCard column={col} onAdded={load} onAuthError={onAuthError} />
        </div>
      ))}
    </div>
  );
}

function Card({
  task,
  onDragStart,
  onDropBefore,
  onChange,
  onAuthError,
}: {
  task: Task;
  onDragStart: () => void;
  onDropBefore: () => void;
  onChange: () => void;
  onAuthError: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);

  const save = async () => {
    try {
      await api.updateTask(task.id, { title, notes });
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

  if (editing) {
    return (
      <div className="rounded-lg border border-blue-500/40 bg-input p-2">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mb-2" />
        <TextArea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes…"
          className="mb-2 !font-sans"
        />
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
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.stopPropagation();
        onDropBefore();
      }}
      onClick={() => setEditing(true)}
      className="cursor-grab rounded-lg border border-line bg-input p-2.5 active:cursor-grabbing"
    >
      <div className="text-sm text-fg">{task.title}</div>
      {task.notes && <div className="mt-1 line-clamp-3 text-xs text-fg-dim">{task.notes}</div>}
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
