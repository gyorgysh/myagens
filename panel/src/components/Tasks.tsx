import { useEffect, useRef, useState } from "react";
import { api, AuthError, type Column, type ColumnDef, type Priority, type QueueState, type Recurrence, type Task, type TaskRunConfig, type Wip, type Worker } from "../api.ts";
import { useTaskEvents, type LiveTask } from "../lib/useTaskEvents.ts";
import { useI18n } from "../lib/useI18n.ts";
import { errorMessage } from "../lib/errorMessage.ts";
import { toast } from "../lib/useToast.ts";
import { useListAnimate } from "../lib/useListAnimate.ts";
import { Button, Callout, Empty, InfoCard, Input, Skeleton, TextArea } from "./ui.tsx";
import { TasksArt } from "./onboarding.tsx";
import { RunLog } from "./RunLog.tsx";
import { Markdown } from "../lib/markdown.tsx";
import { ChevronDown, ChevronUp, Pencil, X, Check, Repeat } from "lucide-react";
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
  if (last("done") || last("complete") || last("finish")) return "text-ok-fg";
  if (idx === 1) return "text-accent";
  return "text-fg-muted";
}

const PRIO_DOT: Record<Priority, string> = {
  high: "bg-critical",
  normal: "bg-fg-faint",
  low: "bg-sky-500",
};

const DAY = 86_400_000;

/**
 * Invisible 44x44px touch target (WCAG 2.5.5) centred on a visually compact
 * control, via a `::before` overlay so the element's own size and the
 * surrounding layout stay unchanged.
 */
const HIT44 =
  "relative before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Compact elapsed-time label for the live run timer: "8s", "2m 05s", "1h 03m". */
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${String(rs).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${String(rm).padStart(2, "0")}m`;
}

/** Persisted preference: show newest-added cards at the top of each column. */
const NEWEST_FIRST_KEY = "myhq.tasks.newestFirst";

/**
 * Live elapsed label that re-renders once a second while `running` is true.
 * Returns null when not running or the start time is unknown.
 */
function useElapsed(startedAt: number | undefined, running: boolean): string | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running || !startedAt) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [running, startedAt]);
  if (!running || !startedAt) return null;
  return formatElapsed(Date.now() - startedAt);
}

export function TasksView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [columns, setColumns] = useState<ColumnDef[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [wip, setWip] = useState<Wip>({});
  const [runConfig, setRunConfig] = useState<TaskRunConfig | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [queue, setQueue] = useState<QueueState>({ paused: false, queued: 0 });
  // Newest-added cards at the top of each column (display only; drag order is
  // still authoritative when off). Persisted across sessions.
  const [newestFirst, setNewestFirst] = useState<boolean>(
    () => localStorage.getItem(NEWEST_FIRST_KEY) === "1",
  );
  const [dragId, setDragId] = useState<string | null>(null);
  // Column currently under the dragged card, for drop-target highlighting.
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  // Insertion indicator: the card id the dragged card would land *before*, or
  // the sentinel "__end__" when it would land at the bottom of the column. null
  // hides the indicator (not hovering a valid slot).
  const [dropBeforeId, setDropBeforeId] = useState<string | null>(null);
  const [renamingCol, setRenamingCol] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  // Inline WIP-limit editor: which column's count is being edited + the draft value.
  const [editingWip, setEditingWip] = useState<string | null>(null);
  const [wipVal, setWipVal] = useState("");
  // Two-step column delete: id of the column awaiting a confirming second click.
  const [confirmDelCol, setConfirmDelCol] = useState<string | null>(null);
  // Inline add-column input at the end of the board.
  const [addingCol, setAddingCol] = useState(false);
  const [newColVal, setNewColVal] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archiveRef] = useListAnimate();

  // Bulk selection state
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Enabled Leads for the bulk delegate-as picker, and the chosen Lead (empty
  // = auto-route each card to the best-fit Lead, the existing behaviour).
  const [leads, setLeads] = useState<Worker[]>([]);
  const [delegateLead, setDelegateLead] = useState("");

  // Mobile: columns scroll horizontally with snap; the chips jump to a column.
  // Refs let a chip tap smooth-scroll its column into view.
  const colRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const scrollToCol = (id: string) => {
    colRefs.current[id]?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
  };

  const load = () =>
    api
      .tasks()
      .then((r) => {
        setTasks(r.tasks);
        setColumns(r.columns);
        setWip(r.wip);
        setRunConfig(r.config);
        if (r.queue) setQueue(r.queue);
      })
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(errorMessage(e, t))))
      .finally(() => setLoaded(true));

  useEffect(() => {
    void load();
    // Enabled Leads power the bulk "delegate as …" picker; failures are non-fatal.
    api
      .workers()
      .then((r) => setLeads(r.workers.filter((w) => w.role === "lead" && w.enabled)))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Optimistically move a card to a new column on the board. */
  const moveCard = (taskId: string, column: string) => {
    setTasks((prev) => prev.map((tk) => (tk.id === taskId ? { ...tk, column } : tk)));
  };

  const live = useTaskEvents(load, moveCard, (paused) =>
    setQueue((q) => ({ ...q, paused })),
  );

  // Persist the newest-first preference whenever it flips.
  useEffect(() => {
    localStorage.setItem(NEWEST_FIRST_KEY, newestFirst ? "1" : "0");
  }, [newestFirst]);

  const inColumn = (c: Column) =>
    tasks
      .filter((tk) => tk.column === c)
      // Default: explicit drag order (ascending). Newest-first overrides for
      // display, showing the most recently created cards at the top.
      .sort((a, b) => (newestFirst ? b.createdAt - a.createdAt : a.order - b.order));

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

  const startEditWip = (col: ColumnDef) => {
    const cur = wip[col.id];
    setWipVal(cur != null ? String(cur) : "");
    setEditingWip(col.id);
  };

  const commitWip = async (colId: string) => {
    // Editor already closed (Escape, or a second commit after blur): do nothing.
    if (editingWip !== colId) return;
    setEditingWip(null);
    const trimmed = wipVal.trim();
    const limit = trimmed === "" ? null : Number(trimmed);
    // Ignore invalid or negative input — leave the existing limit untouched.
    if (limit !== null && (Number.isNaN(limit) || limit < 0)) return;
    const r = await api.setWip(colId, limit);
    setWip(r.wip);
  };

  const saveConfig = async (patch: Partial<TaskRunConfig>) => {
    const r = await api.saveTasksConfig(patch).catch(() => null);
    if (r) setRunConfig(r.config);
  };

  const commitAddColumn = async () => {
    if (!addingCol) return;
    const name = newColVal.trim();
    setAddingCol(false);
    setNewColVal("");
    if (!name) return;
    await api.addColumn(name);
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

  // Two-step delete: first click arms the confirm (auto-disarms after 3s),
  // second click within the window actually removes the (empty) column.
  const onDeleteColClick = (col: ColumnDef) => {
    const count = inColumn(col.id).length;
    if (count > 0) {
      toast.info(t("tasks_move_first").replace("{n}", String(count)).replace("{name}", col.name));
      return;
    }
    if (confirmDelCol !== col.id) {
      setConfirmDelCol(col.id);
      window.setTimeout(() => setConfirmDelCol((c) => (c === col.id ? null : c)), 3000);
      return;
    }
    setConfirmDelCol(null);
    void removeColumn(col);
  };

  const removeColumn = async (col: ColumnDef) => {
    try {
      await api.removeColumn(col.id);
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
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
    setDelegateLead("");
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

  const bulkDelete = () => {
    const ids = [...selected];
    const n = ids.length;
    if (!n) return;
    // Optimistically hide the selected cards and open a 5s undo window. Only
    // commit the deletes to the server once the window closes; undo just
    // restores the hidden cards (nothing was deleted server-side yet).
    const hidden = tasks.filter((tk) => ids.includes(tk.id));
    setTasks((prev) => prev.filter((tk) => !ids.includes(tk.id)));
    exitSelectMode();
    toast.undo(t("tasks_bulk_deleted").replace("{n}", String(n)), {
      undoLabel: t("toast_undo"),
      onUndo: () => setTasks((prev) => [...prev, ...hidden]),
      onCommit: async () => {
        await Promise.all(ids.map((id) => api.deleteTask(id).catch(() => {})));
      },
    });
  };

  const bulkDelegate = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    const lead = delegateLead || undefined;
    await Promise.all(ids.map((id) => api.delegateTask(id, lead).catch(() => {})));
    const leadName = leads.find((l) => l.id === delegateLead)?.name;
    exitSelectMode();
    void load();
    toast.success(
      leadName
        ? t("tasks_bulk_delegated_lead").replace("{n}", String(ids.length)).replace("{lead}", leadName)
        : t("tasks_bulk_delegated").replace("{n}", String(ids.length)),
    );
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
    toast.success(t("tasks_bulk_combined").replace("{n}", String(n)));
  };

  if (error) return <Empty>{error}</Empty>;

  // Split columns: normal (non-archive) and the archive column.
  const normalCols = columns.filter((c) => c.id !== "archive");
  const archiveCol = columns.find((c) => c.id === "archive");
  const archivedCards = archiveCol ? inColumn("archive") : [];

  const gridCols =
    normalCols.length <= 3 ? "md:grid-cols-3" :
    normalCols.length === 4 ? "md:grid-cols-4" : "md:grid-cols-3 lg:grid-cols-5";

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

      {/* Delegated-run settings: timeout + concurrency */}
      {runConfig && (
        <RunSettings
          config={runConfig}
          open={configOpen}
          onToggle={() => setConfigOpen((o) => !o)}
          onSave={saveConfig}
        />
      )}

      {/* Queue control + sort toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setNewestFirst((v) => !v)}
          className={`flex min-h-[44px] items-center gap-1.5 rounded border px-2.5 text-xs transition-colors ${
            newestFirst
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-line text-fg-dim hover:bg-surface-2"
          }`}
          title={t("tasks_sort_label")}
        >
          <span className="opacity-60">↕</span>
          {newestFirst ? t("tasks_sort_newest") : t("tasks_sort_order")}
        </button>
        {queue.queued > 0 && (
          <span className="rounded bg-warn-subtle px-2 py-1 text-xs text-warn-fg">
            {t("tasks_queue_waiting").replace("{n}", String(queue.queued))}
          </span>
        )}
        {queue.paused ? (
          <button
            onClick={async () => {
              const r = await api.resumeQueue().catch(() => null);
              if (r) setQueue(r);
            }}
            className="flex min-h-[44px] items-center rounded border border-accent/40 bg-accent/10 px-2.5 text-xs text-accent hover:bg-accent/20 transition-colors"
          >
            {t("tasks_queue_resume")}
          </button>
        ) : (
          <button
            onClick={async () => {
              const r = await api.pauseQueue().catch(() => null);
              if (r) setQueue(r);
            }}
            className="flex min-h-[44px] items-center rounded border border-line px-2.5 text-xs text-fg-dim hover:bg-surface-2 transition-colors"
          >
            {t("tasks_queue_pause")}
          </button>
        )}
        {queue.queued > 0 && (
          <button
            onClick={async () => {
              if (!confirm(t("tasks_queue_clear_confirm").replace("{n}", String(queue.queued)))) return;
              const r = await api.clearQueue().catch(() => null);
              if (r) {
                setQueue((q) => ({ ...q, queued: 0, paused: r.paused }));
                toast.success(t("tasks_queue_cleared").replace("{n}", String(r.cleared)));
                void load();
              }
            }}
            className="flex min-h-[44px] items-center rounded border border-critical/30 px-2.5 text-xs text-critical-fg hover:bg-critical-subtle transition-colors"
          >
            {t("tasks_queue_clear")}
          </button>
        )}
      </div>
      {queue.paused && (
        <div className="rounded-xl border border-warn/30 bg-warn-subtle px-3 py-2 text-xs text-warn-fg">
          {t("tasks_queue_paused")}
        </div>
      )}

      {/* Bulk action toolbar */}
      {selectMode ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2">
          <span className="text-xs text-fg-dim">
            {t("tasks_bulk_selected").replace("{n}", String(selected.size))}
          </span>
          <button
            onClick={bulkDelete}
            disabled={selected.size === 0}
            className="flex min-h-[44px] items-center rounded border border-critical/30 px-2.5 text-xs text-critical-fg hover:bg-critical-subtle disabled:opacity-40 transition-colors"
          >
            {t("tasks_bulk_delete").replace("{n}", String(selected.size))}
          </button>
          <button
            onClick={bulkDelegate}
            disabled={selected.size === 0}
            className="flex min-h-[44px] items-center rounded border border-line px-2.5 text-xs text-accent hover:bg-accent/10 disabled:opacity-40 transition-colors"
          >
            {t("tasks_bulk_delegate").replace("{n}", String(selected.size))}
          </button>
          {leads.length > 0 && (
            <select
              value={delegateLead}
              onChange={(e) => setDelegateLead(e.target.value)}
              title={t("tasks_bulk_delegate_as")}
              className="min-h-[44px] rounded border border-line bg-surface px-2 text-xs text-fg"
            >
              <option value="">{t("tasks_bulk_delegate_auto")}</option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={bulkRunTogether}
            disabled={selected.size < 2}
            className="flex min-h-[44px] items-center rounded border border-line px-2.5 text-xs text-fg-dim hover:bg-surface-2 disabled:opacity-40 transition-colors"
          >
            {t("tasks_bulk_run_together")}
          </button>
          <button
            onClick={exitSelectMode}
            className="ml-auto flex min-h-[44px] items-center rounded px-2.5 text-xs text-fg-faint hover:text-fg-dim transition-colors"
          >
            {t("tasks_select_cancel")}
          </button>
        </div>
      ) : (
        <div className="flex justify-end">
          <button
            onClick={() => setSelectMode(true)}
            className="flex min-h-[44px] items-center rounded px-2.5 text-xs text-fg-faint hover:text-fg-dim transition-colors"
          >
            {t("tasks_select_mode")}
          </button>
        </div>
      )}

      {/* Mobile column jump-chips — tap to scroll-snap a column into view. */}
      {normalCols.length > 1 && (
        <div className="-mx-1 flex gap-1 overflow-x-auto pb-1 md:hidden">
          {normalCols.map((col, idx) => {
            const count = inColumn(col.id).length;
            return (
              <button
                key={col.id}
                onClick={() => scrollToCol(col.id)}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors ${colTone(col, idx)} hover:bg-surface-2`}
              >
                {columnName(col, t)}
                <span className="ml-1.5 opacity-60">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Skeleton board while the initial fetch is in flight */}
      {!loaded && (
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, c) => (
            <div key={c} className="flex flex-col rounded-xl border border-line bg-surface p-3">
              <div className="mb-3 flex items-center justify-between gap-1">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-6" />
              </div>
              <div className="flex flex-col gap-2">
                {Array.from({ length: 3 - c }).map((_, i) => (
                  <div key={i} className="rounded-lg border border-line bg-input p-3">
                    <Skeleton className="mb-2 h-3.5 w-5/6" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Main board — mobile: horizontal snap-scroll, desktop: grid. */}
      {loaded && (
      <div className={`-mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-2 md:mx-0 md:grid md:overflow-visible md:px-0 md:pb-0 ${gridCols}`}>
        {normalCols.map((col, idx) => {
          const cards = inColumn(col.id);
          const limit = wip[col.id];
          const over = limit != null && cards.length > limit;
          const tone = colTone(col, idx);
          return (
            <div
              key={col.id}
              ref={(el) => { colRefs.current[col.id] = el; }}
              onDragOver={(e) => {
                e.preventDefault();
                if (dragId && dragOverCol !== col.id) setDragOverCol(col.id);
                // Hovering the column chrome (not a card) targets the end slot.
                if (dragId && dropBeforeId !== "__end__") setDropBeforeId("__end__");
              }}
              onDragLeave={(e) => {
                // Only clear when the pointer actually leaves the column box, not
                // when it crosses onto a child card inside the same column.
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDragOverCol((c) => (c === col.id ? null : c));
                  setDropBeforeId(null);
                }
              }}
              onDrop={() => {
                setDragOverCol(null);
                setDropBeforeId(null);
                void drop(col.id, null);
              }}
              className={`flex w-[85vw] max-w-[calc(100vw-2rem)] shrink-0 snap-start flex-col rounded-xl border bg-surface p-3 transition-colors sm:w-[70vw] md:w-auto md:max-w-none md:shrink ${
                dragId && dragOverCol === col.id ? "border-dashed border-accent ring-2 ring-accent/40" : "border-line"
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
                    role="button"
                    tabIndex={0}
                    className={`group flex flex-1 items-center gap-1 cursor-text text-xs font-semibold uppercase tracking-wider ${tone} hover:opacity-80`}
                    onClick={() => startRename(col)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        startRename(col);
                      }
                    }}
                    title={t("tasks_click_rename")}
                  >
                    {columnName(col, t)}
                    <span
                      aria-hidden
                      className="inline-flex opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Pencil size={12} />
                    </span>
                  </h3>
                )}
                {selectMode ? (
                  <button
                    onClick={() => toggleSelectColumn(col.id)}
                    disabled={cards.length === 0}
                    title={t("tasks_select_all_col")}
                    className={`shrink-0 rounded border border-line px-1.5 py-0.5 text-xs text-accent hover:bg-accent/10 disabled:opacity-40 transition-colors ${HIT44}`}
                  >
                    {cards.length > 0 && cards.every((tk) => selected.has(tk.id))
                      ? t("tasks_select_none_col")
                      : t("tasks_select_all_col")}
                  </button>
                ) : (
                  <>
                    {editingWip === col.id ? (
                      <input
                        autoFocus
                        type="number"
                        min={0}
                        value={wipVal}
                        onChange={(e) => setWipVal(e.target.value)}
                        onBlur={() => commitWip(col.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitWip(col.id);
                          if (e.key === "Escape") setEditingWip(null);
                        }}
                        placeholder={t("tasks_wip_placeholder")}
                        aria-label={t("tasks_set_wip")}
                        className="tabular h-11 w-auto min-w-[3rem] shrink-0 rounded bg-input px-1 text-xs text-fg outline-none focus:ring-1 focus:ring-accent/50"
                      />
                    ) : (
                      <button
                        onClick={() => startEditWip(col)}
                        title={t("tasks_set_wip")}
                        aria-label={t("tasks_set_wip")}
                        className={`tabular shrink-0 rounded px-1.5 text-xs ${HIT44} ${over ? "bg-critical-subtle text-critical-fg" : "text-fg-faint hover:text-fg-dim"}`}
                      >
                        {cards.length}
                        {limit != null && ` / ${limit}`}
                      </button>
                    )}
                    <button
                      onClick={() => onDeleteColClick(col)}
                      onBlur={() => setConfirmDelCol((c) => (c === col.id ? null : c))}
                      title={t("tasks_remove_column")}
                      aria-label={t("tasks_remove_column")}
                      className={`shrink-0 rounded px-1 text-xs transition-colors ${HIT44} ${
                        confirmDelCol === col.id
                          ? "bg-critical-subtle text-critical-fg"
                          : "text-fg-faint hover:text-critical-fg"
                      }`}
                    >
                      {confirmDelCol === col.id ? t("tasks_remove_confirm") : <X size={13} className="inline" />}
                    </button>
                  </>
                )}
              </div>

              {/* Add card at top */}
              <AddCard column={col.id} onAdded={load} onAuthError={onAuthError} atTop />

              <div className="flex flex-1 flex-col gap-2 mt-2">
                {cards.length === 0 ? (
                  <div className="scale-90">
                    <Empty icon={<TasksArt />} title={t("tasks_col_empty")}>
                      {t("tasks_col_empty_desc")}
                    </Empty>
                  </div>
                ) : (
                  cards.map((tk) => (
                    <Card
                      key={tk.id}
                      task={tk}
                      allTasks={tasks}
                      live={live[tk.id]}
                      isDragging={dragId === tk.id}
                      dragActive={dragId != null && dragId !== tk.id}
                      showDropLine={dragId != null && dragId !== tk.id && dropBeforeId === tk.id}
                      onDragStart={() => setDragId(tk.id)}
                      onDragEnd={() => {
                        setDragId(null);
                        setDragOverCol(null);
                        setDropBeforeId(null);
                      }}
                      onDragOverCard={() => {
                        if (dragId && dragId !== tk.id && dropBeforeId !== tk.id) {
                          setDropBeforeId(tk.id);
                        }
                      }}
                      onDropBefore={() => {
                        setDropBeforeId(null);
                        void drop(col.id, tk.id);
                      }}
                      onChange={load}
                      onAuthError={onAuthError}
                      selectMode={selectMode}
                      selected={selected.has(tk.id)}
                      onToggleSelect={() => toggleSelect(tk.id)}
                      leads={leads}
                    />
                  ))
                )}
                {/* End-of-column insertion indicator: shown when the dragged
                    card would land below the last card. */}
                {dragId && dragOverCol === col.id && dropBeforeId === "__end__" && cards.length > 0 && (
                  <div className="h-0.5 rounded-full bg-accent" aria-hidden />
                )}
              </div>

              <AddCard column={col.id} onAdded={load} onAuthError={onAuthError} />
            </div>
          );
        })}

        {/* Add column (inline input; hidden on mobile where columns are tabbed) */}
        <div className="hidden items-start md:flex">
          {addingCol ? (
            <input
              autoFocus
              value={newColVal}
              onChange={(e) => setNewColVal(e.target.value)}
              onBlur={commitAddColumn}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitAddColumn();
                if (e.key === "Escape") {
                  setAddingCol(false);
                  setNewColVal("");
                }
              }}
              placeholder={t("tasks_new_column_placeholder")}
              aria-label={t("tasks_add_column")}
              className="w-40 rounded-xl border border-dashed border-accent/40 bg-input px-3 py-2 text-xs text-fg outline-none focus:ring-1 focus:ring-accent/50"
            />
          ) : (
            <button
              onClick={() => setAddingCol(true)}
              className="mt-0 flex items-center gap-1.5 rounded-xl border border-dashed border-line px-3 py-2 text-xs text-fg-faint hover:border-fg-dim hover:text-fg-dim transition-colors"
            >
              <span>+</span>
              <span>{t("tasks_add_column")}</span>
            </button>
          )}
        </div>
      </div>
      )}

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
                <div className="flex flex-col items-center gap-2 py-6 text-center text-fg-faint">
                  <div className="[&_svg]:h-10 [&_svg]:w-10 opacity-60">
                    <TasksArt />
                  </div>
                  <p className="text-xs">{t("tasks_archive_empty")}</p>
                </div>
              ) : (
                <div ref={archiveRef} className="grid gap-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
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
                            className={`rounded px-1.5 py-0.5 text-xs text-accent hover:bg-accent/10 transition-colors ${HIT44}`}
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

function staleTier(task: Task): "stale14" | "stale7" | null {
  const col = task.column.toLowerCase();
  if (col === "done" || col.includes("done") || col.includes("complete") || col === "archive") return null;
  const age = Date.now() - task.updatedAt;
  if (age > 14 * DAY) return "stale14";
  if (age > 7 * DAY) return "stale7";
  return null;
}

function ageBorder(task: Task): string {
  switch (staleTier(task)) {
    case "stale14":
      return "border-l-2 border-l-critical/60 border-line";
    case "stale7":
      return "border-l-2 border-l-warn/50 border-line";
    default:
      return "border-line";
  }
}

function Card({
  task,
  allTasks,
  live,
  isDragging,
  dragActive,
  showDropLine,
  onDragStart,
  onDragEnd,
  onDragOverCard,
  onDropBefore,
  onChange,
  onAuthError,
  selectMode,
  selected,
  onToggleSelect,
  leads,
}: {
  task: Task;
  allTasks: Task[];
  live?: LiveTask;
  isDragging: boolean;
  /** A drag is in progress for some *other* card. */
  dragActive: boolean;
  /** Show the insertion line above this card (the dragged card lands here). */
  showDropLine: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverCard: () => void;
  onDropBefore: () => void;
  onChange: () => void;
  onAuthError: () => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  /** Enabled Leads, for a per-card "delegate as …" picker (empty = auto-route). */
  leads: Worker[];
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [blockedBy, setBlockedBy] = useState<string[]>(task.blockedBy ?? []);
  const [recurrence, setRecurrence] = useState<Recurrence | null>(task.recurrence?.rule ?? null);
  const isDone = task.column.toLowerCase().includes("done") || task.column === "archive";
  const [delegateOpen, setDelegateOpen] = useState(!isDone);
  const [notesOpen, setNotesOpen] = useState(false);
  // Notes worth offering an expand toggle for: long enough or multi-line that
  // the clamped `max-h-16` preview would hide part of the formatted content.
  const needsClamp = task.notes.length > 140 || task.notes.includes("\n");
  const [fullLogOpen, setFullLogOpen] = useState(false);
  const [liveLogOpen, setLiveLogOpen] = useState(false);
  const liveLogRef = useRef<HTMLDivElement>(null);
  // Which Lead to delegate this card to; empty = auto-route (existing behaviour).
  const [delegateLeadId, setDelegateLeadId] = useState("");

  const running = live?.status === "running" || task.delegate?.status === "running";
  const dstatus = live?.status ?? task.delegate?.status;
  // Wall-clock since the run started: the WS "start" event carries startedAt;
  // fall back to the persisted delegate timestamp so a reload mid-run keeps it.
  const startedAt = live?.startedAt ?? task.delegate?.startedAt;
  const elapsed = useElapsed(startedAt, running);

  // Keep the live log pinned to the latest output as it streams in.
  useEffect(() => {
    if (liveLogOpen && liveLogRef.current) {
      liveLogRef.current.scrollTop = liveLogRef.current.scrollHeight;
    }
  }, [live?.output, live?.tool, liveLogOpen]);

  const save = async () => {
    try {
      // recurrence rides in the same PATCH: a rule sets/updates it, null clears it.
      await api.updateTask(task.id, { title, notes, priority, blockedBy, recurrence });
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
    await api.delegateTask(task.id, delegateLeadId || undefined).catch(() => {});
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
  const unstick = async () => {
    // Clear a card jammed in queued/running/error (e.g. orphaned by a crash):
    // aborts any run, drops it from the queue, and clears the delegation.
    await api.unstickTask(task.id).catch(() => {});
    onChange();
  };
  const moveTo = async (column: Column) => {
    await api.updateTask(task.id, { column }).catch(() => {});
    onChange();
  };

  if (editing && !selectMode) {
    return (
      <div className="rounded-lg border border-accent/40 bg-input p-2">
        <button
          onClick={() => setEditing(false)}
          className="mb-2 flex items-center gap-1 text-xs text-fg-dim transition-colors hover:text-fg"
        >
          <span aria-hidden>←</span>
          <span>{t("tasks_editor_back")}</span>
        </button>
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
              className={`flex min-h-[44px] items-center rounded px-2 text-xs capitalize ${
                priority === p ? "bg-accent/15 text-accent" : "text-fg-dim hover:bg-surface-2"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
        <DependencyPicker
          task={task}
          allTasks={allTasks}
          value={blockedBy}
          onChange={setBlockedBy}
        />
        <RepeatPicker value={recurrence} onChange={setRecurrence} />
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
    <div className="relative">
      {/* Insertion indicator: a thin accent line above the card the dragged
          card will land before, so the drop position is unambiguous. */}
      {showDropLine && (
        <div className="absolute -top-1 left-0 right-0 z-10 h-0.5 rounded-full bg-accent" aria-hidden />
      )}
      <div
        draggable={!running && !selectMode}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={(e) => {
          e.preventDefault();
          if (dragActive) onDragOverCard();
        }}
        onDrop={(e) => {
          e.stopPropagation();
          onDropBefore();
        }}
        className={`rounded-lg border bg-input p-2.5 transition-opacity ${ageBorder(task)} ${selected ? "ring-1 ring-accent/60" : ""} ${
          isDragging ? "opacity-40" : ""
        } ${!running && !selectMode ? "cursor-grab active:cursor-grabbing" : ""}`}
      >
      <div className="flex items-start gap-2">
        {selectMode ? (
          // Invisible 44px hit area around the compact checkbox (WCAG 2.5.5).
          <label className="relative -m-2.5 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              className="h-3.5 w-3.5 cursor-pointer accent-accent"
            />
          </label>
        ) : (
          <span
            className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${PRIO_DOT[task.priority]}`}
            title={t("tasks_priority_label").replace("{priority}", task.priority)}
          />
        )}
        <div
          role="button"
          tabIndex={0}
          aria-label={selectMode ? t("tasks_select_card") : t("tasks_edit_card")}
          className="min-w-0 flex-1 cursor-pointer"
          onClick={() => (selectMode ? onToggleSelect() : setEditing(true))}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              selectMode ? onToggleSelect() : setEditing(true);
            }
          }}
        >
          <div className="flex items-start gap-1.5">
            <span className="min-w-0 flex-1 text-sm text-fg">{task.title}</span>
            {task.recurrence && (
              <span
                className="mt-0.5 flex shrink-0 items-center gap-0.5 rounded bg-accent/10 px-1 py-0.5 text-xs text-accent"
                title={t(`tasks_repeat_${task.recurrence.rule.kind}` as TranslationKey)}
              >
                <Repeat size={10} />
                {t(`tasks_repeat_${task.recurrence.rule.kind}` as TranslationKey)}
              </span>
            )}
          </div>
          {task.notes && (
            <>
              {/* Inline markdown preview on every card. Notes can be long and now
                  render markdown (0.5.3), so clamp by default and offer an
                  expand/collapse toggle to read the formatted notes without
                  opening the edit form. Done cards start collapsed; others open. */}
              {(isDone || needsClamp) && (
                <button
                  onClick={(e) => { e.stopPropagation(); setNotesOpen((o) => !o); }}
                  className="mt-1 flex items-center gap-1 text-xs text-fg-faint hover:text-fg-dim"
                  aria-expanded={notesOpen}
                >
                  {notesOpen ? t("tasks_notes_collapse") : t("tasks_notes_expand")}{" "}
                  {notesOpen ? (
                    <ChevronUp size={12} className="opacity-50" />
                  ) : (
                    <ChevronDown size={12} className="opacity-50" />
                  )}
                </button>
              )}
              {(notesOpen || !isDone) && (
                <div
                  className={`mt-1 text-xs text-fg-dim ${notesOpen ? "" : "max-h-16 overflow-hidden"}`}
                >
                  <Markdown text={task.notes} />
                </div>
              )}
            </>
          )}
          {task.parentId && <div className="mt-1 text-xs text-fg-faint">{t("tasks_subtask")}</div>}
          {task.blockingIds && task.blockingIds.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
              <span className="rounded bg-warn-subtle px-1.5 py-0.5 text-warn-fg" title={t("tasks_blocked_title")}>
                {task.waitingOnPrereq ? t("tasks_blocked_waiting") : t("tasks_blocked_by")}
              </span>
              {task.blockingIds.map((bid) => {
                const dep = allTasks.find((x) => x.id === bid);
                return (
                  <span key={bid} className="mono-xs text-fg-faint" title={dep?.title}>
                    ↳ #{bid}
                    {dep && <span className="ml-1 font-sans text-fg-dim">{dep.title.slice(0, 24)}</span>}
                  </span>
                );
              })}
            </div>
          )}
          <div className="mt-1 flex items-center gap-1.5 text-xs text-fg-faint">
            <span className="mono-xs text-fg-faint opacity-60">#{task.id}</span>
            <span>{t("tasks_created").replace("{date}", formatDate(task.createdAt))}</span>
            {(task.createdByName || task.createdBy) && (
              <span className="rounded bg-accent/10 px-1.5 py-0.5 text-accent">
                {t("tasks_created_by").replace("{name}", task.createdByName || task.createdBy || "")}
              </span>
            )}
            {staleTier(task) && (
              <span
                className="text-fg-faint"
                title={t("tasks_stale")}
              >
                {staleTier(task) === "stale14" ? t("tasks_stale_14d") : t("tasks_stale_7d")}
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
                  ? "text-ok-fg"
                  : dstatus === "error"
                    ? "text-critical-fg"
                    : dstatus === "stopped"
                      ? "text-fg-dim"
                      : dstatus === "queued"
                        ? "text-warn-fg"
                        : "text-accent"
              }`}
            >
              {running
                ? t("tasks_running")
                : dstatus === "queued"
                  ? task.waitingOnPrereq
                    ? t("tasks_waiting_prereq")
                    : t("tasks_queued")
                  : t("tasks_delegated").replace("{status}", String(dstatus))}
              {!running && <span className="ml-1 opacity-50">{delegateOpen ? "▲" : "▼"}</span>}
            </button>
            <div className="flex items-center gap-2">
              {running && elapsed && (
                <span className="tabular text-xs text-fg-faint" title={t("tasks_running")}>
                  {t("tasks_running_for").replace("{t}", elapsed)}
                </span>
              )}
              {running && (
                <button onClick={stop} className="text-xs text-critical-fg hover:underline">
                  {t("stop")}
                </button>
              )}
              {!running && dstatus === "queued" && (
                <button
                  onClick={unstick}
                  className="text-xs text-fg-dim hover:text-fg hover:underline"
                  title={t("tasks_unstick_title")}
                >
                  {t("tasks_unqueue")}
                </button>
              )}
            </div>
          </div>
          {delegateOpen && (
            <>
              {!running && live?.tool && <div className="mono mt-1 text-xs text-fg-dim">{live.tool}</div>}
              {running ? (
                // While the task runs, the full streamed output is available
                // live over the WS. Show a compact preview plus an expandable,
                // auto-scrolling live log so progress can be watched mid-run.
                (live?.output || live?.tool) && (
                  <>
                    {!liveLogOpen && (
                      <>
                        {live?.tool && <div className="mono mt-1 text-xs text-fg-dim">{live.tool}</div>}
                        {live?.output && (
                          <div className="mono mt-1 line-clamp-4 whitespace-pre-wrap text-xs text-fg-faint">
                            {live.output}
                          </div>
                        )}
                      </>
                    )}
                    <button
                      onClick={() => setLiveLogOpen((o) => !o)}
                      className="mt-1 text-xs text-accent hover:underline"
                    >
                      {liveLogOpen ? t("tasks_hide_live_log") : t("tasks_view_live_log")}
                    </button>
                    {liveLogOpen && (
                      <div
                        ref={liveLogRef}
                        className="mono mt-1 max-h-96 overflow-y-auto whitespace-pre-wrap rounded border border-line bg-base p-2 text-xs text-fg-dim"
                      >
                        {live?.output}
                        {live?.tool && (
                          <div className="mt-1 text-accent">▸ {live.tool}</div>
                        )}
                      </div>
                    )}
                  </>
                )
              ) : (
                (live?.output || task.delegate?.output) && (
                  <div className="mono mt-1 line-clamp-4 whitespace-pre-wrap text-xs text-fg-faint">
                    {live?.output || task.delegate?.output}
                  </div>
                )
              )}
              {task.delegate?.error && <div className="mt-1 text-xs text-critical-fg">{task.delegate.error}</div>}
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
              className="flex min-h-[44px] flex-1 items-center justify-center rounded border border-line text-xs text-accent hover:bg-surface-2"
              title={
                task.canResume
                  ? t("tasks_retry_resume_title")
                  : task.retryCount
                    ? t("tasks_retry_count").replace("{n}", String(task.retryCount))
                    : undefined
              }
            >
              {task.canResume ? t("tasks_retry_resume") : t("tasks_retry")}
              {task.retryCount ? ` (${task.retryCount})` : ""}
            </button>
          )}
          <button
            onClick={() => moveTo("backlog")}
            className="flex min-h-[44px] flex-1 items-center justify-center rounded border border-line text-xs text-fg-dim hover:bg-surface-2 hover:text-fg"
          >
            {t("tasks_move_to_planned")}
          </button>
          <button
            onClick={() => moveTo("done")}
            className="flex min-h-[44px] flex-1 items-center justify-center rounded border border-line text-xs text-ok-fg hover:bg-surface-2"
          >
            {t("tasks_mark_done")}
          </button>
        </div>
      )}

      {!selectMode && !running && !isDone && !dstatus && (
        <div className="mt-2 flex gap-1.5">
          <button
            onClick={delegate}
            className="flex min-h-[44px] flex-1 items-center justify-center rounded border border-line text-xs text-fg-dim hover:bg-surface-2 hover:text-fg"
          >
            {t("tasks_delegate")}
          </button>
          {leads.length > 0 && (
            <select
              value={delegateLeadId}
              onChange={(e) => setDelegateLeadId(e.target.value)}
              title={t("tasks_delegate_as")}
              aria-label={t("tasks_delegate_as")}
              className="min-h-[44px] shrink-0 rounded border border-line bg-surface px-1.5 text-xs text-fg-dim"
            >
              <option value="">{t("tasks_bulk_delegate_auto")}</option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      </div>
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

/**
 * Prerequisite ("blocked by") picker shown in the card editor: a collapsible
 * list of other cards the user can mark this one as depending on. Self and
 * already-done/archived cards are excluded as sensible choices.
 */
function DependencyPicker({
  task,
  allTasks,
  value,
  onChange,
}: {
  task: Task;
  allTasks: Task[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(value.length > 0);
  const candidates = allTasks.filter((tk) => tk.id !== task.id && tk.column !== "archive");
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div className="mb-2 rounded border border-line bg-surface px-2 py-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-xs text-fg-dim hover:text-fg"
      >
        <span>
          {t("tasks_blocked_by")}
          {value.length > 0 && <span className="ml-1 text-accent">({value.length})</span>}
        </span>
        <span className="opacity-50">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto">
          {candidates.length === 0 ? (
            <p className="text-xs text-fg-faint">{t("tasks_dep_none")}</p>
          ) : (
            candidates.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 text-xs text-fg-dim hover:text-fg">
                <input
                  type="checkbox"
                  checked={value.includes(c.id)}
                  onChange={() => toggle(c.id)}
                  className="h-3.5 w-3.5 accent-accent"
                />
                <span className="mono-xs text-fg-faint">#{c.id}</span>
                <span className="truncate">{c.title}</span>
                {c.column === "done" && <Check size={14} className="ml-auto text-ok-fg" />}
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Collapsible repeat-schedule picker. A card with a recurrence acts as a
 * template: it stays put while the ticker drops a fresh copy into the backlog
 * on each cadence. `null` means no repeat; otherwise a daily/weekly/monthly rule
 * with an hour:minute (and a day-of-week / day-of-month where relevant).
 */
function RepeatPicker({
  value,
  onChange,
}: {
  value: Recurrence | null;
  onChange: (next: Recurrence | null) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(value != null);

  const kind = value?.kind ?? "none";
  const hour = value?.kind ? value.hour : 9;
  const minute = value?.kind ? value.minute : 0;
  const dayOfWeek = value?.kind === "weekly" ? value.dayOfWeek : 1;
  const dayOfMonth = value?.kind === "monthly" ? value.dayOfMonth : 1;

  const setKind = (k: string) => {
    if (k === "none") return onChange(null);
    if (k === "daily") return onChange({ kind: "daily", hour, minute });
    if (k === "weekly") return onChange({ kind: "weekly", dayOfWeek, hour, minute });
    onChange({ kind: "monthly", dayOfMonth, hour, minute });
  };
  const setTime = (h: number, m: number) => {
    if (!value) return;
    onChange({ ...value, hour: h, minute: m } as Recurrence);
  };

  const weekdayKeys: TranslationKey[] = [
    "weekday_sun",
    "weekday_mon",
    "weekday_tue",
    "weekday_wed",
    "weekday_thu",
    "weekday_fri",
    "weekday_sat",
  ];
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");

  return (
    <div className="mb-2 rounded border border-line bg-surface px-2 py-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-xs text-fg-dim hover:text-fg"
      >
        <span className="flex items-center gap-1">
          <Repeat size={13} />
          {t("tasks_repeat")}
          {value && (
            <span className="ml-1 text-accent">
              ({t(`tasks_repeat_${value.kind}` as TranslationKey)})
            </span>
          )}
        </span>
        <span className="opacity-50">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-2">
          <div className="flex flex-wrap gap-1">
            {(["none", "daily", "weekly", "monthly"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`rounded px-2 py-1 text-xs ${
                  kind === k ? "bg-accent/15 text-accent" : "text-fg-dim hover:bg-surface-2"
                }`}
              >
                {t(`tasks_repeat_${k}` as TranslationKey)}
              </button>
            ))}
          </div>
          {value?.kind === "weekly" && (
            <div className="flex flex-wrap gap-1">
              {weekdayKeys.map((wk, i) => (
                <button
                  key={wk}
                  onClick={() => onChange({ ...value, dayOfWeek: i })}
                  className={`rounded px-2 py-1 text-xs ${
                    value.dayOfWeek === i
                      ? "bg-accent/15 text-accent"
                      : "text-fg-dim hover:bg-surface-2"
                  }`}
                >
                  {t(wk)}
                </button>
              ))}
            </div>
          )}
          {value?.kind === "monthly" && (
            <label className="flex items-center gap-2 text-xs text-fg-dim">
              <span>{t("tasks_repeat_day_of_month")}</span>
              <input
                type="number"
                min={1}
                max={31}
                value={dayOfMonth}
                onChange={(e) =>
                  onChange({
                    ...value,
                    dayOfMonth: Math.min(31, Math.max(1, Number(e.target.value) || 1)),
                  })
                }
                className="w-16 rounded border border-line bg-input px-1.5 py-1 text-fg"
              />
            </label>
          )}
          {value && (
            <label className="flex items-center gap-2 text-xs text-fg-dim">
              <span>{t("tasks_repeat_at")}</span>
              <input
                type="time"
                value={`${hh}:${mm}`}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(":").map((x) => Number(x) || 0);
                  setTime(h ?? 0, m ?? 0);
                }}
                className="rounded border border-line bg-input px-1.5 py-1 text-fg"
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}

/** Collapsible config row for delegated-run timeout + max concurrency. */
function RunSettings({
  config,
  open,
  onToggle,
  onSave,
}: {
  config: TaskRunConfig;
  open: boolean;
  onToggle: () => void;
  onSave: (patch: Partial<TaskRunConfig>) => void;
}) {
  const { t } = useI18n();
  // Local draft (timeout shown in minutes for readability).
  const [mins, setMins] = useState(String(Math.round(config.timeoutMs / 60000)));
  const [conc, setConc] = useState(String(config.maxConcurrent));

  useEffect(() => {
    setMins(String(Math.round(config.timeoutMs / 60000)));
    setConc(String(config.maxConcurrent));
  }, [config.timeoutMs, config.maxConcurrent]);

  const dirty =
    Math.round(config.timeoutMs / 60000) !== Number(mins) || config.maxConcurrent !== Number(conc);

  const save = () => {
    const m = Math.max(0, Math.floor(Number(mins) || 0));
    const c = Math.max(0, Math.floor(Number(conc) || 0));
    onSave({ timeoutMs: m * 60000, maxConcurrent: c });
  };

  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wider text-fg-faint hover:text-fg-dim transition-colors"
      >
        <span>{t("tasks_run_settings")}</span>
        <span className="opacity-50">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-dim">{t("tasks_run_timeout")}</span>
            <input
              type="number"
              min={0}
              value={mins}
              onChange={(e) => setMins(e.target.value)}
              className="w-24 rounded bg-input px-2 py-1 text-sm text-fg outline-none focus:ring-1 focus:ring-accent/50"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-dim">{t("tasks_run_concurrency")}</span>
            <input
              type="number"
              min={0}
              value={conc}
              onChange={(e) => setConc(e.target.value)}
              className="w-24 rounded bg-input px-2 py-1 text-sm text-fg outline-none focus:ring-1 focus:ring-accent/50"
            />
          </label>
          <Button variant="primary" onClick={save} disabled={!dirty}>
            {t("save")}
          </Button>
          <span className="text-xs text-fg-faint">{t("tasks_run_settings_hint")}</span>
        </div>
      )}
    </div>
  );
}
