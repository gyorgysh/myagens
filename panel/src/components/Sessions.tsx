import { api } from "../api.ts";
import { usePoll } from "../lib/usePoll.ts";
import { Badge, Card, Empty } from "./ui.tsx";
import { SessionsArt } from "./onboarding.tsx";
import { ms, usd } from "../lib/format.ts";
import { useI18n } from "../lib/useI18n.ts";

export function SessionsView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
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

      {sessions.length === 0 && <Empty icon={<SessionsArt />}>{t("sessions_empty")}</Empty>}

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
              {s.usage.total.turns} {t("sessions_turns")} · {usd(s.usage.total.costUsd)} · {ms(s.usage.total.durationMs)}
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
              {t("sessions_today")}: {s.usage.today.turns} {t("sessions_turns")} · {usd(s.usage.today.costUsd)}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
