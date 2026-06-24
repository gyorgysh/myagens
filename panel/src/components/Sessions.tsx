import { api } from "../api.ts";
import { usePoll } from "../lib/usePoll.ts";
import { Badge, Card, Empty } from "./ui.tsx";
import { ms, usd } from "../lib/format.ts";

export function SessionsView({ onAuthError }: { onAuthError: () => void }) {
  const { data, error } = usePoll(api.sessions, 5000, onAuthError);

  if (error) return <Empty>Failed to load: {error}</Empty>;
  const sessions = data?.sessions ?? [];
  if (!sessions.length) return <Empty>No sessions yet.</Empty>;

  return (
    <div className="space-y-3">
      {sessions.map((s) => (
        <Card key={s.chatId}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-fg">chat {s.chatId}</span>
            <Badge tone={s.mode === "auto" ? "amber" : "zinc"}>{s.mode}</Badge>
            {s.busy && <Badge tone="blue">busy</Badge>}
            {s.hasContext && <Badge tone="green">context</Badge>}
            <span className="ml-auto tabular text-xs text-fg-dim">
              {s.usage.total.turns} turns · {usd(s.usage.total.costUsd)} · {ms(s.usage.total.durationMs)}
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
              today: {s.usage.today.turns} turns · {usd(s.usage.today.costUsd)}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
