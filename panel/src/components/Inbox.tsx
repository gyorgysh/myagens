import { useEffect, useState } from "react";
import { api, AuthError, type Suggestion, type SuggestionStatus, type Worker } from "../api.ts";
import { useI18n } from "../lib/useI18n.ts";
import type { TranslationKey } from "../i18n/en.ts";
import { relTime } from "../lib/format.ts";
import { useSuggestionEvents } from "../lib/useSuggestionEvents.ts";
import { useListAnimate } from "../lib/useListAnimate.ts";
import { toast } from "../lib/useToast.ts";
import { Badge, Button, Card, Empty, InfoCard } from "./ui.tsx";
import { InboxArt } from "./onboarding.tsx";
import { Markdown } from "../lib/markdown.tsx";

type Filter = "pending" | "accepted" | "dismissed";

const FILTERS: Filter[] = ["pending", "accepted", "dismissed"];

const STATUS_TONE: Record<SuggestionStatus, "blue" | "green" | "zinc"> = {
  pending: "blue",
  accepted: "green",
  dismissed: "zinc",
};

export function InboxView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [all, setAll] = useState<Suggestion[]>([]);
  const [leads, setLeads] = useState<Worker[]>([]);
  const [filter, setFilter] = useState<Filter>("pending");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [listRef] = useListAnimate();

  // Bulk selection state — mirrors the Tasks board multi-select.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Optional Lead to force a (bulk or single) delegate to — the "delegate as
  // Iris" path. Empty string = auto-route to the best-fit Lead.
  const [delegateLead, setDelegateLead] = useState("");

  const load = () =>
    api
      .suggestions()
      .then((r) => setAll(r.suggestions))
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));

  useEffect(() => {
    void load();
    // Lead list powers the "delegate as …" picker; failures are non-fatal.
    api
      .workers()
      .then((r) => setLeads(r.workers.filter((w) => w.role === "lead" && w.enabled)))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live updates: the server pushes the full list on every change.
  useSuggestionEvents((list) => setAll(list));

  const accept = async (id: string) => {
    setBusy(id);
    try {
      await api.acceptSuggestion(id);
      await load();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const delegate = async (id: string) => {
    setBusy(id);
    setNotice(null);
    try {
      const r = await api.delegateSuggestion(id, delegateLead || undefined);
      setNotice(
        r.leadName
          ? t("inbox_delegated_lead").replace("{lead}", r.leadName)
          : t("inbox_delegated_generic"),
      );
      await load();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async (id: string) => {
    setBusy(id);
    try {
      await api.dismissSuggestion(id);
      await load();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  // --- bulk selection helpers (Tasks-board parity) ---
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

  /** Select or deselect every pending suggestion at once. */
  const toggleSelectAll = (ids: string[]) => {
    if (!ids.length) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };

  const bulkAccept = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    await Promise.all(ids.map((id) => api.acceptSuggestion(id).catch(() => {})));
    exitSelectMode();
    await load();
    toast.success(t("inbox_bulk_parked").replace("{n}", String(ids.length)));
  };

  const bulkDelegate = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    await Promise.all(ids.map((id) => api.delegateSuggestion(id, delegateLead || undefined).catch(() => {})));
    exitSelectMode();
    await load();
    const lead = leads.find((l) => l.id === delegateLead);
    toast.success(
      lead
        ? t("inbox_bulk_delegated_lead").replace("{n}", String(ids.length)).replace("{lead}", lead.name)
        : t("inbox_bulk_delegated").replace("{n}", String(ids.length)),
    );
  };

  const bulkDismiss = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    await Promise.all(ids.map((id) => api.dismissSuggestion(id).catch(() => {})));
    exitSelectMode();
    await load();
    toast.success(t("inbox_bulk_dismissed").replace("{n}", String(ids.length)));
  };

  // Merge the selected suggestions into a single combined task and delegate it
  // as one autonomous run, then dismiss the originals (Tasks-board parity).
  const bulkRunTogether = async () => {
    const ids = [...selected];
    const n = ids.length;
    if (!n) return;
    if (!confirm(t("inbox_bulk_run_together_confirm").replace("{n}", String(n)))) return;
    const picked = all.filter((s) => selected.has(s.id));
    const combinedTitle = picked.map((s) => s.title).join("; ");
    const combinedNotes = picked
      .map((s) => `### ${s.title}\n${s.detail ?? ""}`.trim())
      .join("\n\n");
    const combined = await api.createTask({ title: combinedTitle, notes: combinedNotes, column: "backlog" });
    await api.delegateTask(combined.id).catch(() => {});
    // Dismiss the originals now that they are merged into the combined run.
    await Promise.all(ids.map((id) => api.dismissSuggestion(id).catch(() => {})));
    exitSelectMode();
    await load();
    toast.success(t("inbox_bulk_combined").replace("{n}", String(n)));
  };

  if (error) return <Empty>Failed to load: {error}</Empty>;

  const items = all.filter((s) => s.status === filter);
  const selectableIds = items.map((s) => s.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  // Selection only applies to the pending tab (the only one with actions).
  const canSelect = filter === "pending";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-fg">{t("inbox_title")}</h1>
        <p className="mt-1 text-sm text-fg-dim">{t("inbox_subtitle")}</p>
      </div>

      <InfoCard
        id="inbox"
        title={t("inbox_info_title")}
        body={t("inbox_info_body")}
        items={[
          { label: t("inbox_delegate"), text: t("inbox_info_delegate") },
          { label: t("inbox_accept"), text: t("inbox_info_park") },
          { label: t("inbox_dismiss"), text: t("inbox_info_dismiss") },
        ]}
      />

      {notice && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-accent">
          {notice}
        </div>
      )}

      {/* Filter chips */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const active = f === filter;
          const count = all.filter((s) => s.status === f).length;
          return (
            <button
              key={f}
              onClick={() => {
                setFilter(f);
                exitSelectMode();
              }}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-line text-fg-dim hover:bg-surface-2 hover:text-fg"
              }`}
            >
              {t(`inbox_filter_${f}` as TranslationKey)}
              {count > 0 && <span className="ml-1.5 text-fg-faint">{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Delegate-as picker — applies to single and bulk delegate. */}
      {canSelect && items.length > 0 && leads.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-fg-dim">
          <span>{t("inbox_delegate_as")}</span>
          <select
            value={delegateLead}
            onChange={(e) => setDelegateLead(e.target.value)}
            className="min-h-[36px] rounded border border-line bg-surface px-2 text-xs text-fg"
          >
            <option value="">{t("inbox_delegate_auto")}</option>
            {leads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Bulk action toolbar (pending tab only) */}
      {canSelect && items.length > 0 && (
        selectMode ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2">
            <span className="text-xs text-fg-dim">
              {t("inbox_bulk_selected").replace("{n}", String(selected.size))}
            </span>
            <button
              onClick={() => toggleSelectAll(selectableIds)}
              className="flex min-h-[44px] items-center rounded border border-line px-2.5 text-xs text-fg-dim hover:bg-surface-2 transition-colors"
            >
              {allSelected ? t("inbox_select_none") : t("inbox_select_all")}
            </button>
            <button
              onClick={bulkDelegate}
              disabled={selected.size === 0}
              className="flex min-h-[44px] items-center rounded border border-line px-2.5 text-xs text-accent hover:bg-accent/10 disabled:opacity-40 transition-colors"
            >
              {t("inbox_bulk_delegate").replace("{n}", String(selected.size))}
            </button>
            <button
              onClick={bulkAccept}
              disabled={selected.size === 0}
              className="flex min-h-[44px] items-center rounded border border-line px-2.5 text-xs text-fg-dim hover:bg-surface-2 disabled:opacity-40 transition-colors"
            >
              {t("inbox_bulk_park").replace("{n}", String(selected.size))}
            </button>
            <button
              onClick={bulkDismiss}
              disabled={selected.size === 0}
              className="flex min-h-[44px] items-center rounded border border-line px-2.5 text-xs text-fg-dim hover:bg-surface-2 disabled:opacity-40 transition-colors"
            >
              {t("inbox_bulk_dismiss").replace("{n}", String(selected.size))}
            </button>
            <button
              onClick={bulkRunTogether}
              disabled={selected.size < 2}
              className="flex min-h-[44px] items-center rounded border border-line px-2.5 text-xs text-fg-dim hover:bg-surface-2 disabled:opacity-40 transition-colors"
            >
              {t("inbox_bulk_run_together")}
            </button>
            <button
              onClick={exitSelectMode}
              className="ml-auto flex min-h-[44px] items-center rounded px-2.5 text-xs text-fg-faint hover:text-fg-dim transition-colors"
            >
              {t("inbox_select_cancel")}
            </button>
          </div>
        ) : (
          <div className="flex justify-end">
            <button
              onClick={() => setSelectMode(true)}
              className="flex min-h-[44px] items-center rounded px-2.5 text-xs text-fg-faint hover:text-fg-dim transition-colors"
            >
              {t("inbox_select_mode")}
            </button>
          </div>
        )
      )}

      {items.length === 0 ? (
        <Card>
          <Empty
            icon={<InboxArt />}
            title={t(`inbox_empty_${filter}` as TranslationKey)}
          >
            {t(`inbox_empty_${filter}_desc` as TranslationKey)}
          </Empty>
        </Card>
      ) : (
        <div ref={listRef} className="space-y-2">
          {items.map((s) => (
            <SuggestionCard
              key={s.id}
              s={s}
              t={t}
              busy={busy === s.id}
              selectMode={selectMode}
              selected={selected.has(s.id)}
              onToggleSelect={() => toggleSelect(s.id)}
              onAccept={() => accept(s.id)}
              onDelegate={() => delegate(s.id)}
              onDismiss={() => dismiss(s.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SuggestionCard({
  s,
  t,
  busy,
  selectMode,
  selected,
  onToggleSelect,
  onAccept,
  onDelegate,
  onDismiss,
}: {
  s: Suggestion;
  t: ReturnType<typeof useI18n>["t"];
  busy: boolean;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onAccept: () => void;
  onDelegate: () => void;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className={`rounded-lg border bg-surface overflow-hidden transition-colors ${
        selected ? "border-accent/60 ring-1 ring-accent/40" : "border-line"
      }`}
    >
      <div
        className="flex flex-wrap items-start gap-2 p-3"
        onClick={selectMode ? onToggleSelect : undefined}
        role={selectMode ? "button" : undefined}
        tabIndex={selectMode ? 0 : undefined}
        onKeyDown={
          selectMode
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggleSelect();
                }
              }
            : undefined
        }
      >
        {selectMode && (
          <label className="relative -m-1 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              onClick={(e) => e.stopPropagation()}
              className="h-3.5 w-3.5 cursor-pointer accent-accent"
            />
          </label>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg">{s.title}</span>
            <Badge tone={STATUS_TONE[s.status]}>{t(`inbox_status_${s.status}` as TranslationKey)}</Badge>
            {s.category && <Badge tone="zinc">{s.category}</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-faint">
            <span className="text-fg-dim">{s.fromAgentName}</span>
            <span>·</span>
            <span className="tabular">{relTime(s.createdAt)}</span>
          </div>
          {s.detail && (
            <>
              <div
                className={`mt-2 text-sm text-fg-muted ${open ? "" : "max-h-12 overflow-hidden"}`}
              >
                <Markdown text={s.detail} />
              </div>
              {s.detail.length > 120 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen((o) => !o);
                  }}
                  className="mt-1 text-xs text-fg-dim hover:text-fg-muted"
                >
                  {open ? t("inbox_less") : t("inbox_more")}
                </button>
              )}
            </>
          )}
        </div>

        {!selectMode && s.status === "pending" && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="primary" disabled={busy} onClick={onDelegate}>
              {t("inbox_delegate")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={onAccept}>
              {t("inbox_accept")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={onDismiss}>
              {t("inbox_dismiss")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
