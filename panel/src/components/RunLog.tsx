import { useEffect, useState } from "react";
import { api, type RunLogEvent } from "../api.ts";
import { useI18n } from "../lib/useI18n.ts";

/** Map a tool name to a small icon + verb, mirroring the Activity feed. */
function describe(tool: string): { icon: string; verb: string } {
  const base = tool.replace(/^mcp__[^_]+__/, "");
  const map: Record<string, { icon: string; verb: string }> = {
    Bash: { icon: "⚡", verb: "Run" },
    Read: { icon: "📖", verb: "Read" },
    Write: { icon: "✏️", verb: "Write" },
    Edit: { icon: "✏️", verb: "Edit" },
    Glob: { icon: "🔍", verb: "Find" },
    Grep: { icon: "🔍", verb: "Search" },
    Task: { icon: "🧰", verb: "Subagent" },
    WebFetch: { icon: "🌐", verb: "Fetch" },
    WebSearch: { icon: "🌐", verb: "Search" },
    TodoWrite: { icon: "✅", verb: "Plan" },
  };
  return map[base] ?? { icon: "🔧", verb: base };
}

/**
 * Full, uncapped transcript for a single run. Lazily fetched on first open from
 * `/api/runs/:runId/log`. Text deltas are coalesced into paragraphs; tool calls
 * and result/error markers are shown as labelled rows.
 */
export function RunLog({ runId }: { runId: string }) {
  const { t } = useI18n();
  const [events, setEvents] = useState<RunLogEvent[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api
      .runLog(runId)
      .then((r) => setEvents(r.events))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [runId]);

  if (loading && !events) return <div className="mt-2 text-xs text-fg-faint">{t("runlog_loading")}</div>;
  if (!events || events.length === 0)
    return <div className="mt-2 text-xs text-fg-faint">{t("runlog_empty")}</div>;

  return (
    <div className="mt-2 max-h-96 overflow-y-auto rounded border border-line bg-base p-2">
      {events.map((e, i) => {
        if (e.kind === "text") {
          if (!e.text?.trim()) return null;
          return (
            <div key={i} className="whitespace-pre-wrap text-xs text-fg-dim">
              {e.text}
            </div>
          );
        }
        if (e.kind === "tool") {
          const d = describe(e.tool ?? "");
          return (
            <div key={i} className="mt-1 flex items-start gap-1.5 text-xs text-accent">
              <span>{d.icon}</span>
              <span className="font-medium">{d.verb}</span>
              {e.arg && <span className="mono min-w-0 truncate text-fg-faint">{e.arg}</span>}
            </div>
          );
        }
        if (e.kind === "result" && e.isError) {
          return (
            <div key={i} className="mt-0.5 text-xs text-red-400">
              ✗ {t("runlog_tool_error")}
            </div>
          );
        }
        if (e.kind === "end") {
          return (
            <div key={i} className="mt-2 border-t border-line pt-1 text-xs text-fg-faint">
              {t("runlog_finished").replace("{status}", e.status ?? "")}
              {e.durationMs != null && ` · ${Math.round(e.durationMs / 1000)}s`}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
