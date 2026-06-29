import { useEffect, useState } from "react";
import { api, AuthError, type ConversationHit } from "../api.ts";
import { usePoll } from "../lib/usePoll.ts";
import { Badge, Card, Empty, Input } from "./ui.tsx";
import { SessionsArt } from "./onboarding.tsx";
import { ms, usd } from "../lib/format.ts";
import { useSubscription } from "../lib/useSubscription.ts";
import { useI18n } from "../lib/useI18n.ts";

/**
 * Full-text + semantic search across stored conversations: the live main chat
 * and every recent autonomous run transcript. Debounced; backed by
 * GET /api/conversations/search (hybrid ranker, keyword fallback).
 */
function ConversationSearch({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ConversationHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setSearched(false);
      return;
    }
    setBusy(true);
    const handle = setTimeout(() => {
      api
        .searchConversations(q)
        .then((r) => {
          setHits(r.hits);
          setSearched(true);
        })
        .catch((e) => e instanceof AuthError && onAuthError())
        .finally(() => setBusy(false));
    }, 300);
    return () => clearTimeout(handle);
  }, [query, onAuthError]);

  return (
    <Card title={t("convsearch_title")}>
      <p className="mb-2 text-sm text-fg-dim">{t("convsearch_desc")}</p>
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("convsearch_placeholder")} />
      {busy && <div className="mt-2 text-xs text-fg-faint">{t("convsearch_searching")}</div>}
      {!busy && searched && hits.length === 0 && (
        <div className="mt-2 text-sm text-fg-dim">{t("convsearch_no_results")}</div>
      )}
      {hits.length > 0 && (
        <ul className="mt-3 space-y-2">
          {hits.map((h) => (
            <li key={h.id} className="rounded-lg border border-line bg-surface/40 p-2.5">
              <div className="flex items-center gap-2">
                <Badge tone={h.source === "chat" ? "blue" : "violet"}>
                  {h.source === "chat" ? t("convsearch_source_chat") : t("convsearch_source_run")}
                </Badge>
                <span className="truncate text-xs text-fg-dim">{h.label}</span>
                <span className="ml-auto shrink-0 text-xs text-fg-faint">{new Date(h.ts).toLocaleString()}</span>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-fg">{h.snippet}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function SessionsView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const hideCost = useSubscription();
  const { data, error } = usePoll(api.sessions, 5000, onAuthError);

  if (error) return <Empty>{t("sessions_failed_load").replace("{error}", error)}</Empty>;
  const sessions = data?.sessions ?? [];

  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-dim">
        {t("sessions_desc_1")}
        <strong className="text-fg">{t("sessions_context_word")}</strong>
        {t("sessions_desc_2")}<code>/new</code>{t("sessions_desc_3")}
        <strong className="text-fg">{t("sessions_usage_word")}</strong>
        {t("sessions_desc_4")}
      </p>

      <ConversationSearch onAuthError={onAuthError} />

      {sessions.length === 0 && (
        <Empty icon={<SessionsArt />} title={t("sessions_empty")}>
          {t("sessions_empty_desc")}
        </Empty>
      )}

      {sessions.map((s) => (
        <Card key={s.chatId}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-fg">{t("sessions_chat")} {s.chatId}</span>
            <Badge tone={s.autonomy === "full" ? "amber" : s.autonomy === "auto_until_error" ? "amber" : s.autonomy === "supervised" ? "blue" : "zinc"}>{t(s.autonomy as "full" | "supervised" | "standard" | "auto_until_error")}</Badge>
            {s.busy && <Badge tone="blue">{t("sessions_busy")}</Badge>}
            {s.hasContext ? (
              <Badge tone="green">{t("sessions_context")}</Badge>
            ) : (
              <Badge tone="zinc">{t("sessions_no_context")}</Badge>
            )}
            <span className="ml-auto tabular text-xs text-fg-dim">
              {s.usage.total.turns} {t("sessions_turns")}{hideCost ? "" : ` · ${usd(s.usage.total.costUsd)}`} · {ms(s.usage.total.durationMs)}
            </span>
          </div>
          <div className="mt-2 truncate font-mono text-xs text-fg-dim" title={s.cwd}>
            {s.cwd}
          </div>
          {(s.allowedTools.length > 0 || s.allowedBashCmds.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {s.allowedTools.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
              {s.allowedBashCmds.map((c) => (
                <Badge key={c}>$ {c}</Badge>
              ))}
            </div>
          )}
          {s.usage.today.turns > 0 && (
            <div className="tabular mt-2 text-xs text-fg-faint">
              {t("sessions_today")}: {s.usage.today.turns} {t("sessions_turns")}{hideCost ? "" : ` · ${usd(s.usage.today.costUsd)}`}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
