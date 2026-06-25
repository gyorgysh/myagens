import { api } from "../api.ts";
import { usePoll } from "../lib/usePoll.ts";
import { Badge, Card, Empty } from "./ui.tsx";
import { ms, usd } from "../lib/format.ts";

export function SessionsView({ onAuthError }: { onAuthError: () => void }) {
  const { data, error } = usePoll(api.sessions, 5000, onAuthError);

  if (error) return <Empty>Failed to load: {error}</Empty>;
  const sessions = data?.sessions ?? [];

  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-dim">
        One live slot per Telegram chat. Each slot tracks the current working directory, autonomy
        mode, and allow-lists for that chat. <strong className="text-fg">Context</strong> means an
        active conversation thread exists — <code>/new</code> clears it (the slot stays, context
        resets). Turn history is in the <strong className="text-fg">Usage</strong> view.
      </p>

      {sessions.length === 0 && <Empty>No sessions yet — send the bot a message to start one.</Empty>}

      {sessions.map((s) => (
        <Card key={s.chatId}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-fg">chat {s.chatId}</span>
            <Badge tone={s.autonomy === "full" ? "amber" : s.autonomy === "supervised" ? "blue" : "zinc"}>{s.autonomy}</Badge>
            {s.busy && <Badge tone="blue">busy</Badge>}
            {s.hasContext ? (
              <Badge tone="green">context</Badge>
            ) : (
              <Badge tone="zinc">no context</Badge>
            )}
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
