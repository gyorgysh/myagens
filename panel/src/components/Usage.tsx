import { api } from "../api.ts";
import { usePoll } from "../lib/usePoll.ts";
import { Card, Empty, Metric } from "./ui.tsx";
import { ms, usd } from "../lib/format.ts";

export function UsageView({ onAuthError }: { onAuthError: () => void }) {
  const { data, error } = usePoll(api.usage, 15000, onAuthError);

  if (error) return <Empty>Failed to load: {error}</Empty>;
  if (!data) return <Empty>Loading…</Empty>;

  const recent = data.daily.slice(-30);
  const maxCost = Math.max(0.0001, ...recent.map((d) => d.costUsd));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <Metric label="Cost today" value={usd(data.today.costUsd)} sub={`${data.today.turns} turns`} />
        </Card>
        <Card>
          <Metric label="Cost lifetime" value={usd(data.total.costUsd)} sub={`${data.total.turns} turns`} />
        </Card>
        <Card>
          <Metric label="Time today" value={ms(data.today.durationMs)} />
        </Card>
        <Card>
          <Metric label="Time lifetime" value={ms(data.total.durationMs)} />
        </Card>
      </div>

      <Card title="Daily cost (last 30 days)">
        {recent.length === 0 ? (
          <Empty>No activity recorded yet.</Empty>
        ) : (
          <div className="flex h-40 items-end gap-1">
            {recent.map((d) => (
              <div key={d.day} className="group flex flex-1 flex-col items-center justify-end">
                <div
                  className="w-full rounded-t bg-blue-500/70 transition-all group-hover:bg-blue-400"
                  style={{ height: `${(d.costUsd / maxCost) * 100}%` }}
                  title={`${d.day}: ${usd(d.costUsd)} · ${d.turns} turns`}
                />
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
