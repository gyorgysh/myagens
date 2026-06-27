import { useEffect, useState } from "react";
import { api, AuthError, type Suggestion, type SuggestionStatus } from "../api.ts";
import { useI18n } from "../lib/useI18n.ts";
import type { TranslationKey } from "../i18n/en.ts";
import { relTime } from "../lib/format.ts";
import { useSuggestionEvents } from "../lib/useSuggestionEvents.ts";
import { Badge, Button, Card, Empty, InfoCard } from "./ui.tsx";
import { InboxArt } from "./onboarding.tsx";

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
  const [filter, setFilter] = useState<Filter>("pending");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () =>
    api
      .suggestions()
      .then((r) => setAll(r.suggestions))
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));

  useEffect(() => {
    void load();
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
      const r = await api.delegateSuggestion(id);
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

  if (error) return <Empty>Failed to load: {error}</Empty>;

  const items = all.filter((s) => s.status === filter);
  const pendingCount = all.filter((s) => s.status === "pending").length;

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
              onClick={() => setFilter(f)}
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

      {filter === "pending" && pendingCount === 0 ? (
        <Card>
          <Empty icon={<InboxArt />} title={t("inbox_empty_pending")} />
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <Empty>{t("inbox_empty")}</Empty>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((s) => (
            <SuggestionCard
              key={s.id}
              s={s}
              t={t}
              busy={busy === s.id}
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
  onAccept,
  onDelegate,
  onDismiss,
}: {
  s: Suggestion;
  t: ReturnType<typeof useI18n>["t"];
  busy: boolean;
  onAccept: () => void;
  onDelegate: () => void;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-line bg-surface overflow-hidden">
      <div className="flex flex-wrap items-start gap-2 p-3">
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
              <p className={`mt-2 whitespace-pre-wrap text-sm text-fg-muted ${open ? "" : "line-clamp-2"}`}>
                {s.detail}
              </p>
              {s.detail.length > 120 && (
                <button
                  onClick={() => setOpen((o) => !o)}
                  className="mt-1 text-xs text-fg-dim hover:text-fg-muted"
                >
                  {open ? t("inbox_less") : t("inbox_more")}
                </button>
              )}
            </>
          )}
        </div>

        {s.status === "pending" && (
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
