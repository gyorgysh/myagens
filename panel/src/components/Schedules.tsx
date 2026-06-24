import { api } from "../api.ts";
import { usePoll } from "../lib/usePoll.ts";
import { Badge, Card, Empty } from "./ui.tsx";
import { relTime } from "../lib/format.ts";

export function SchedulesView({ onAuthError }: { onAuthError: () => void }) {
  const { data, error } = usePoll(api.schedules, 10000, onAuthError);

  if (error) return <Empty>Failed to load: {error}</Empty>;
  const schedules = data?.schedules ?? [];
  if (!schedules.length) return <Empty>No schedules. Create them from Telegram with /schedule.</Empty>;

  return (
    <div className="space-y-3">
      {schedules.map((s) => (
        <Card key={s.id}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="blue">{s.spec}</Badge>
            <span className="font-mono text-xs text-fg-dim">chat {s.chatId}</span>
            <span className="ml-auto tabular text-xs text-fg-muted">
              next {relTime(s.nextRunAt)}
              {s.lastRunAt ? ` · last ${relTime(s.lastRunAt)}` : ""}
            </span>
          </div>
          <div className="mt-2 text-sm text-fg">{s.prompt}</div>
          <div className="mt-1 truncate font-mono text-xs text-fg-faint" title={s.cwd}>
            {s.cwd}
          </div>
        </Card>
      ))}
    </div>
  );
}
