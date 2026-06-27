import { useEffect, useState } from "react";
import { api, AuthError, type Column, type ColumnDef, type Priority, type Task, type Wip } from "../api.ts";
import { useTaskEvents, type LiveTask } from "../lib/useTaskEvents.ts";
import { useI18n } from "../lib/useI18n.ts";
import { Button, Callout, Empty, InfoCard, Input, TextArea } from "./ui.tsx";
import { RunLog } from "./RunLog.tsx";
import type { TranslationKey } from "../i18n/en.ts";

/** Translate a default column name when it hasn't been renamed by the user. */
function columnName(col: ColumnDef, t: (k: TranslationKey) => string): string {
  if (col.id === "backlog" && col.name === "Planned") return t("col_planned");
  if (col.id === "doing" && col.name === "In Progress") return t("col_in_progress");
  if (col.id === "done" && col.name === "Done") return t("col_done");
  if (col.id === "archive" && col.name === "Archive") return t("col_archive");
  return col.name;
}

function colTone(col: ColumnDef, idx: number): string {
  if (col.id === "archive") return "text-fg-faint";
  if (idx === 0) return "text-fg-dim";
  const last = (c: string) => col.id.toLowerCase().includes(c);
  if (last("done") || last("complete") || last("finish")) return "text-emerald-400";
  if (idx === 1) return "text-accent";
  return "text-fg-muted";
}

const PRIO_DOT: Record<Priority, string> = {
  high: "bg-red-500",
  normal: "bg-fg-faint",
  low: "bg-sky-500",
};

const DAY = 86_400_000;

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TasksView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [columns, setColumns] = useState<ColumnDef[]>([]);
  const [wip, setWip] = useState<Wip>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [renamingCol, setRenamingCol] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bulk selection state
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Mobile: show one column at a time (tabs), since the grid stacks below md.
  const [mobileCol, setMobileCol] = useState<string | null>(null);

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

  /** Optimistically move a card to a new column on the board. */
  const moveCard = (taskId: string, column: string) => {
    setTasks((prev) => prev.map((tk) => (tk.id === taskId ? { ...tk, column } : tk)));
  };

  const live = useTaskEvents(load, moveCard);

  const inColumn = (c: Column) =>
    tasks.filter((tk) => tk.column === c).sort((a, b) => a.order - b.order);

  const drop = async (target: Column, beforeId: string | null): Promise<void> => {
    if (!dragId) return;
    const moved = tasks.find((tk) => tk.id === dragId);
    setDragId(null);
    if (!moved) return;
    const list = inColumn(target).filter((tk) => tk.id !== dragId);
    const idx = beforeId ? list.findIndex((tk) => tk.id === beforeId) : list.length;
    list.splice(idx < 0 ? list.length : idx, 0, moved);
    const moves = list.map((tk, i) => ({ id: tk.id, column: target, order: i }));
    setTasks((prev) =>
      prev.map((tk) => {
        const m = moves.find((x) => x.id === tk.id);
        return m ? { ...tk, column: target, order: m.order } : tk;
      }),
    );
    try {
      const r = await api.reorderTasks(moves);
      setTasks(r.tasks);
    } catch {
      void load();
    }
  };

  const editWip = async (col: ColumnDef) => {
    const cur = wip[col.id];
    const input = prompt(t("tasks_wip_prompt").replace("{name}", col.name), cur ? String(cur) : "");
    if (input === null) return;
    const limit = input.trim() === "" ? null : Number(input);
    if (limit !== null && Number.isNaN(limit)) return;
    const r = await api.setWip(col.id, limit);
    setWip(r.wip);
  };

  const addColumn = async () => {
    const name = prompt(t("tasks_new_column_prompt"));
    if (!name?.trim()) return;
    await api.addColumn(name.trim());
    await load();
  };

  const startRename = (col: ColumnDef) => {
    setRenamingCol(col.id);
    setRenameVal(col.name);
  };

  const commitRename = async (id: string) => {
    if (renameVal.trim()) await api.renameColumn(id, renameVal.trim());
    setRenamingCol(null);
    await load();
  };

  const removeColumn = async (col: ColumnDef) => {
    const count = inColumn(col.id).length;
    if (count > 0) {
      alert(t("tasks_move_first").replace("{n}", String(count)).replace("{name}", col.name));
      return;
    }
    if (!confirm(t("tasks_remove_confirm").replace("{name}", col.name))) return;
    await api.removeColumn(col.id).catch((e: Error) => alert(e.message));
    await load();
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  /** Select or deselect every card in one column at once. */
  const toggleSelectColumn = (colId: Column) => {
    const ids = inColumn(colId).map((tk) => tk.id);
    if (!ids.length) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };

  const bulkDelete = async () => {
    const n = selected.size;
    if (!n) return;
    if (!confirm(t("tasks_bulk_delete_confirm").replace("{n}", String(n)))) return;
    await Promise.all([...selected].map((id) => api.deleteTask(id).catch(() => {})));
    exitSelectMode();
    void load();
  };

  const bulkDelegate = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    await Promise.all(ids.map((id) => api.delegateTask(id).catch(() => {})));
    exitSelectMode();
    void load();
  };

  const bulkRunTogether = async () => {
    const ids = [...selected];
    const n = ids.length;
    if (!n) return;
    if (!confirm(t("tasks_bulk_run_together_confirm").replace("{n}", String(n)))) return;
    // Build a combined task from the selected cards' titles + notes.
    const selectedTasks = tasks.filter((tk) => selected.has(tk.id));
    const combinedTitle = selectedTasks.map((tk) => tk.title).join("; ");
    const combinedNotes = selectedTasks
      .map((tk) => `### ${tk.title}\n${tk.notes}`.trim())
      .join("\n\n");
    const combined = await api.createTask({
      title: combinedTitle,
      notes: combinedNotes,
      column: "backlog" as Column,
    });
    await api.delegateTask(combined.id).catch(() => {});
    // Archive the original selected cards now that they are merged into the combined run.
    await Promise.all(ids.map((id) => api.updateTask(id, { column: "archive" as Column }).catch(() => {})));
    exitSelectMode();
    void load();
  };

  if (error) return <Empty>{t("tasks_failed_load").replace("{error}", error)}</Empty>;

  // Split columns: normal (non-archive) and the archive column.
  const normalCols = columns.filter((c) => c.id !== "archive");
  const archiveCol = columns.find((c) => c.id === "archive");
  const archivedCards = archiveCol ? inColumn("archive") : [];

  const gridCols =
    normalCols.length <= 3 ? "md:grid-cols-3" :
    normalCols.length === 4 ? "md:grid-cols-4" : "md:grid-cols-3 lg:grid-cols-5";

  // Default the mobile column to the first one once columns are known.
  const activeMobileCol =
    mobileCol && normalCols.some((c) => c.id === mobileCol) ? mobileCol : normalCols[0]?.id ?? null;

  return (
    <div className="space-y-4">
      {/* Did You Know callout */}
      <Callout title={t("tasks_did_you_know_title")} dismissId="tasks-did-you-know">
        {t("tasks_did_you_know_body")}
      </Callout>

      <InfoCard id="tasks" title={t("info_tasks_title")} body={t("info_tasks_body")}>
        <ul className="space-y-1.5">
          <li>{t("info_tasks_delegate")}</li>
          <li>{t("info_tasks_agent")}</li>
          <li>{t("info_tasks_archive")}</li>
        </ul>
      </InfoCard>

      {/* Bulk action toolbar */}
      {selectMode ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2">
          <span className="text-xs text-fg-dim">
            {selected.size} selected
          </span>
          <button
            onClick={bulkDelete}
            disabled={selected.size === 0}
            className="rounded border border-red-500/40 px-2.5 py-1 text-xs text-red-400 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
          >
            {t("tasks_bulk_delete").replace("{n}", String(selected.size))}
          </button>
          <button
            onClick={bulkDelegate}
            disabled={selected.size === 0}
            className="rounded border border-line px-2.5 py-1 text-xs text-accent hover:bg-accent/10 disabled:opacity-40 transition-colors"
          >
            {t("tasks_bulk_delegate").replace("{n}", String(selected.size))}
          </button>
          <button
            onClick={bulkRunTogether}
            disabled={selected.size < 2}
            className="rounded border border-line px-2.5 py-1 text-xs text-fg-dim hover:bg-surface-2 disabled:opacity-40 transition-colors"
          >
            {t("tasks_bulk_run_together")}
          </button>
          <button
            onClick={exitSelectMode}
            className="ml-auto rounded px-2.5 py-1 text-xs text-fg-faint hover:text-fg-dim transition-colors"
          >
            {t("tasks_select_cancel")}
          </button>
        </div>
      ) : (
        <div className="flex justify-end">
          <button
            onClick={() => setSelectMode(true)}
            className="rounded px-2.5 py-1 text-xs text-fg-faint hover:text-fg-dim transition-colors"
          >
            {t("tasks_select_mode")}
          </button>
        </div>
      )}

      {/* Mobile column tabs — only one column shows at a time below md. */}
      {normalCols.length > 1 && (
        <div className="-mx-1 flex gap-1 overflow-x-auto pb-1 md:hidden">
          {normalCols.map((col, idx) => {
            const count = inColumn(col.id).length;
            const isActive = col.id === activeMobileCol;
            return (
              <button
                key={col.id}
                onClick={() => setMobileCol(col.id)}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors ${
                  isActive ? "bg-accent/15 text-accent" : `${colTone(col, idx)} hover:bg-surface-2`
                }`}
              >
                {columnName(col, t)}
                <span className="ml-1.5 opacity-60">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Main board */}
      <div className={`grid gap-4 ${gridCols}`}>
        {normalCols.map((col, idx) => {
          const cards = inColumn(col.id);
          const limit = wip[col.id];
          const over = limit != null && cards.length > limit;
          const tone = colTone(col, idx);
          const hiddenOnMobile = col.id !== activeMobileCol;
          return (
            <div
              key={col.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => drop(col.id, null)}
              className={`flex-col rounded-xl border border-line bg-surface p-3 md:flex ${
                hiddenOnMobile ? "hidden" : "flex"
              }`}
            >
              <div className="mb-3 flex items-center justify-between gap-1">
                {renamingCol === col.id ? (
                  <input
                    autoFocus
                    value={renameVal}
                    onChange={(e) => setRenameVal(e.target.value)}
                    onBlur={() => commitRename(col.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename(col.id);
                      if (e.key === "Escape") setRenamingCol(null);
                    }}
                    className="flex-1 rounded bg-input px-1 py-0.5 text-xs font-semibold uppercase tracking-wider text-fg outline-none"
                  />
                ) : (
                  <h3
                    className={`flex-1 cursor-pointer text-xs font-semibold uppercase tracking-wider ${tone} hover:opacity-80`}
                    onClick={() => startRename(col)}
                    title={t("tasks_click_rename")}
                  >
                    {columnName(col, t)}
                  </h3>
                )}
                {selectMode ? (
                  <button
                    onClick={() => toggleSelectColumn(col.id)}
                    disabled={cards.length === 0}
                    title={t("tasks_select_all_col")}
                    className="shrink-0 rounded border border-line px-1.5 py-0.5 text-xs text-accent hover:bg-accent/10 disabled:opacity-40 transition-colors"
                  >
                    {cards.length > 0 && cards.every((tk) => selected.has(tk.id))
                      ? t("tasks_select_none_col")
                      : t("tasks_select_all_col")}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => editWip(col)}
                      title={t("tasks_set_wip")}
                      className={`tabular shrink-0 rounded px-1.5 text-xs ${over ? "bg-red-500/15 text-red-400" : "text-fg-faint hover:text-fg-dim"}`}
                    >
                      {cards.length}
                      {limit != null && ` / ${limit}`}
                    </button>
                    <button
                      onClick={() => removeColumn(col)}
                      title={t("tasks_remove_column")}
                      className="shrink-0 text-xs text-fg-faint hover:text-red-400 transition-colors"
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>

              {/* Add card at top */}
              <AddCard column={col.id} onAdded={load} onAuthError={onAuthError} atTop />

              <div className="flex flex-1 flex-col gap-2 mt-2">
                {cards.map((tk) => (
                  <Card
                    key={tk.id}
                    task={tk}
                    live={live[tk.id]}
                    onDragStart={() => setDragId(tk.id)}
                    onDropBefore={() => drop(col.id, tk.id)}
                    onChange={load}
                    onAuthError={onAuthError}
                    selectMode={selectMode}
                    selected={selected.has(tk.id)}
                    onToggleSelect={() => toggleSelect(tk.id)}
                  />
                ))}
              </div>

              <AddCard column={col.id} onAdded={load} onAuthError={onAuthError} />
            </div>
          );
        })}

        {/* Add column button (hidden on mobile where columns are tabbed) */}
        <div className="hidden items-start md:flex">
          <button
            onClick={addColumn}
            className="mt-0 flex items-center gap-1.5 rounded-xl border border-dashed border-line px-3 py-2 text-xs text-fg-faint hover:border-fg-dim hover:text-fg-dim transition-colors"
          >
            <span>+</span>
            <span>{t("tasks_add_column")}</span>
          </button>
        </div>
      </div>

      {/* Archive section — collapsed by default, title-only cards */}
      {archiveCol && (
        <div className="rounded-xl border border-line bg-surface p-3">
          <button
            onClick={() => setArchiveOpen((o) => !o)}
            className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wider text-fg-faint hover:text-fg-dim transition-colors"
          >
            <span>
              {archiveOpen
                ? t("tasks_archive_hide")
                : t("tasks_archive_show").replace("{n}", String(archivedCards.length))}
            </span>
            <span className="opacity-50">{archiveOpen ? "▲" : "▼"}</span>
          </button>

          {archiveOpen && (
            <div className="mt-3">
              {archivedCards.length === 0 ? (
                <p className="text-xs text-fg-faint">{t("tasks_archive_empty")}</p>
              ) : (
                <div className="grid gap-1.5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                  {archivedCards.map((tk) => {
                    const restoreCol = normalCols[0];
                    const restoreLabel = restoreCol
                      ? t("tasks_archive_restore_to").replace("{col}", columnName(restoreCol, t))
                      : t("tasks_archive_restore");
                    return (
                    <div
                      key={tk.id}
                      className="flex items-center justify-between gap-2 rounded border border-line bg-input px-2.5 py-1.5"
                    >
                      <span className="min-w-0 truncate text-xs text-fg-dim">{tk.title}</span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="text-xs text-fg-faint">{formatDate(tk.updatedAt)}</span>
                        {restoreCol && (
                          <button
                            title={restoreLabel}
                            onClick={async () => {
                              await api.updateTask(tk.id, { column: restoreCol.id as Column }).catch(() => {});
                              void load();
                            }}
                            className="rounded px-1.5 py-0.5 text-xs text-accent hover:bg-accent/10 transition-colors"
                          >
                            {t("tasks_archive_restore")}
                          </button>
                        )}
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ageBorder(task: Task): string {
  const col = task.column.toLowerCase();
  if (col === "done" || col.includes("done") || col.includes("complete") || col === "archive") return "border-line";
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
  selectMode,
  selected,
  onToggleSelect,
}: {
  task: Task;
  live?: LiveTask;
  onDragStart: () => void;
  onDropBefore: () => void;
  onChange: () => void;
  onAuthError: () => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const isDone = task.column.toLowerCase().includes("done") || task.column === "archive";
  const [delegateOpen, setDelegateOpen] = useState(!isDone);
  const [notesOpen, setNotesOpen] = useState(!isDone);
  const [fullLogOpen, setFullLogOpen] = useState(false);

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
    if (!confirm(t("tasks_delete_confirm"))) return;
    await api.deleteTask(task.id);
    onChange();
  };
  const delegate = async () => {
    await api.delegateTask(task.id).catch(() => {});
    // Optimistic move to "doing" if we're in backlog — the WS event will confirm.
    if (task.column === "backlog") onChange();
  };
  const retry = async () => {
    // Dedicated retry: server resets the card to backlog, clears the error,
    // bumps retryCount, and re-delegates in one step.
    await api.retryTask(task.id).catch(() => {});
    onChange();
  };
  const stop = async () => {
    await api.stopTask(task.id).catch(() => {});
  };
  const moveTo = async (column: Column) => {
    await api.updateTask(task.id, { column }).catch(() => {});
    onChange();
  };

  if (editing && !selectMode) {
    return (
      <div className="rounded-lg border border-accent/40 bg-input p-2">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mb-2" />
        <TextArea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t("tasks_notes_placeholder")}
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
            {t("save")}
          </Button>
          <Button onClick={() => setEditing(false)}>{t("cancel")}</Button>
          <Button variant="danger" className="ml-auto" onClick={del}>
            {t("delete")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      draggable={!running && !selectMode}
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.stopPropagation();
        onDropBefore();
      }}
      className={`rounded-lg border bg-input p-2.5 ${ageBorder(task)} ${selected ? "ring-1 ring-accent/60" : ""}`}
    >
      <div className="flex items-start gap-2">
        {selectMode ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            className="mt-1 h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent"
          />
        ) : (
          <span
            className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${PRIO_DOT[task.priority]}`}
            title={t("tasks_priority_label").replace("{priority}", task.priority)}
          />
        )}
        <div
          className="min-w-0 flex-1 cursor-pointer"
          onClick={() => (selectMode ? onToggleSelect() : setEditing(true))}
        >
          <div className="text-sm text-fg">{task.title}</div>
          {task.notes && isDone && (
            <button
              onClick={(e) => { e.stopPropagation(); setNotesOpen((o) => !o); }}
              className="mt-1 flex items-center gap-1 text-xs text-fg-faint hover:text-fg-dim"
            >
              {t("tasks_notes_toggle")} <span className="opacity-50">{notesOpen ? "▲" : "▼"}</span>
            </button>
          )}
          {task.notes && (!isDone || notesOpen) && (
            <div className="mt-1 line-clamp-3 text-xs text-fg-dim">{task.notes}</div>
          )}
          {task.parentId && <div className="mt-1 text-xs text-fg-faint">{t("tasks_subtask")}</div>}
          <div className="mt-1 flex items-center gap-1.5 text-xs text-fg-faint">
            <span>{t("tasks_created").replace("{date}", formatDate(task.createdAt))}</span>
            {(task.createdByName || task.createdBy) && (
              <span className="rounded bg-accent/10 px-1.5 py-0.5 text-accent">
                {t("tasks_created_by").replace("{name}", task.createdByName || task.createdBy || "")}
              </span>
            )}
          </div>
        </div>
      </div>

      {!selectMode && (running || dstatus) && (
        <div className="mt-2 rounded border border-line bg-surface p-2">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setDelegateOpen((o) => !o)}
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
              {running ? t("tasks_running") : t("tasks_delegated").replace("{status}", String(dstatus))}
              {!running && <span className="ml-1 opacity-50">{delegateOpen ? "▲" : "▼"}</span>}
            </button>
            {running && (
              <button onClick={stop} className="text-xs text-red-400 hover:underline">
                {t("stop")}
              </button>
            )}
          </div>
          {delegateOpen && (
            <>
              {live?.tool && <div className="mono mt-1 text-xs text-fg-dim">{live.tool}</div>}
              {(live?.output || task.delegate?.output) && (
                <div className="mono mt-1 line-clamp-4 whitespace-pre-wrap text-xs text-fg-faint">
                  {live?.output || task.delegate?.output}
                </div>
              )}
              {task.delegate?.error && <div className="mt-1 text-xs text-red-400">{task.delegate.error}</div>}
              {!running && task.delegate?.runId && (
                <>
                  <button
                    onClick={() => setFullLogOpen((o) => !o)}
                    className="mt-1 text-xs text-accent hover:underline"
                  >
                    {fullLogOpen ? t("workers_hide_full_log") : t("workers_view_full_log")}
                  </button>
                  {fullLogOpen && <RunLog runId={task.delegate.runId} />}
                </>
              )}
            </>
          )}
        </div>
      )}

      {!selectMode && !running && !isDone && (dstatus === "stopped" || dstatus === "error") && (
        <div className="mt-2 flex gap-1.5">
          {dstatus === "error" && (
            <button
              onClick={retry}
              className="flex-1 rounded border border-line py-1 text-xs text-accent hover:bg-surface-2"
              title={task.retryCount ? t("tasks_retry_count").replace("{n}", String(task.retryCount)) : undefined}
            >
              {t("tasks_retry")}
              {task.retryCount ? ` (${task.retryCount})` : ""}
            </button>
          )}
          <button
            onClick={() => moveTo("backlog")}
            className="flex-1 rounded border border-line py-1 text-xs text-fg-dim hover:bg-surface-2 hover:text-fg"
          >
            {t("tasks_move_to_planned")}
          </button>
          <button
            onClick={() => moveTo("done")}
            className="flex-1 rounded border border-line py-1 text-xs text-emerald-400 hover:bg-surface-2"
          >
            {t("tasks_mark_done")}
          </button>
        </div>
      )}

      {!selectMode && !running && !isDone && !dstatus && (
        <button
          onClick={delegate}
          className="mt-2 w-full rounded border border-line py-1 text-xs text-fg-dim hover:bg-surface-2 hover:text-fg"
        >
          {t("tasks_delegate")}
        </button>
      )}
    </div>
  );
}

function AddCard({
  column,
  onAdded,
  onAuthError,
  atTop,
}: {
  column: Column;
  onAdded: () => void;
  onAuthError: () => void;
  atTop?: boolean;
}) {
  const { t } = useI18n();
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
        className={`${atTop ? "" : "mt-2"} rounded-lg px-2 py-1.5 text-left text-xs text-fg-faint hover:bg-surface-2 hover:text-fg-dim`}
      >
        {atTop ? t("tasks_add_card_top") : t("tasks_add_card")}
      </button>
    );

  return (
    <div className={atTop ? "mb-1" : "mt-2"}>
      <Input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && add()}
        onBlur={add}
        placeholder={t("tasks_card_title_placeholder")}
      />
    </div>
  );
}
