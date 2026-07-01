import { useEffect, useRef, useState } from "react";
import { useActiveRuns, type ActiveRun } from "../lib/useActiveRuns.ts";
import { useI18n } from "../lib/useI18n.ts";
import { uptime } from "../lib/format.ts";
import { RunLog } from "./RunLog.tsx";
import { Bot, ListChecks, ChevronDown, ChevronUp, Loader2 } from "lucide-react";

/** Live "now" that ticks once a second so elapsed timers stay current. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Short verb for the last tool, mirroring the activity feed's labelling. */
function shortTool(tool?: string): string | undefined {
  if (!tool) return undefined;
  const head = tool.split(/\s+/)[0]?.replace(/^mcp__[^_]+__/, "");
  return head;
}

/**
 * Slim, persistent "What's running" strip pinned to the bottom of the viewport.
 * Subscribes to every in-flight autonomous run (Lead/worker runs and delegated
 * kanban-card runs) over the shared /ws. Collapsed it shows a one-line summary
 * (count + the newest run's name/elapsed/last tool); tapping expands a panel
 * listing each run with its live transcript.
 */
export function StatusStrip({ enabled = true }: { enabled?: boolean }) {
  const { t } = useI18n();
  const runs = useActiveRuns(enabled);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const now = useNow(runs.length > 0);
  const active = runs.length > 0;

  // Keep the strip mounted (and remember the last runs) briefly after the last
  // run ends so the exit transition can play out instead of vanishing instantly.
  const [mounted, setMounted] = useState(active);
  const [shown, setShown] = useState(active);
  const lastRunsRef = useRef<ActiveRun[]>(runs);
  if (active) lastRunsRef.current = runs;

  useEffect(() => {
    if (active) {
      setMounted(true);
      // Next frame: flip to the "shown" state so the enter transition runs from
      // the off-screen/transparent starting styles.
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    // Run just ended: play the exit transition, then unmount.
    setShown(false);
    setOpen(false);
    setFocused(null);
    const id = setTimeout(() => setMounted(false), 200);
    return () => clearTimeout(id);
  }, [active]);

  if (!mounted) return null;

  // While exiting we render the last known runs so the content doesn't blank out
  // mid-animation.
  const display = active ? runs : lastRunsRef.current;
  const newest = display[0];
  if (!newest) return null;
  const elapsed = (r: ActiveRun) => uptime((now - r.startedAt) / 1000);

  return (
    <div
      className={`fixed inset-x-0 bottom-16 z-40 transform-gpu transition-all duration-200 ease-out md:bottom-0 ${
        shown ? "translate-y-0 opacity-100" : "translate-y-full opacity-0"
      }`}
    >
      {/* Expanded panel (above the bar). */}
      {open && (
        <div className="mx-auto max-h-[60vh] w-full max-w-3xl overflow-y-auto rounded-t-2xl border border-b-0 border-line bg-surface p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-fg-muted">
              {t("status_strip_title")}
            </span>
            <button
              onClick={() => setOpen(false)}
              className="text-fg-faint transition-colors hover:text-fg"
              aria-label={t("close")}
            >
              <ChevronDown size={16} />
            </button>
          </div>
          <ul className="flex flex-col gap-2">
            {display.map((r) => {
              const tool = shortTool(r.tool);
              const isOpen = focused === r.key;
              return (
                <li key={r.key} className="rounded-xl border border-line bg-base p-2">
                  <button
                    onClick={() => setFocused(isOpen ? null : r.key)}
                    className="flex w-full items-center gap-2 text-left"
                  >
                    {r.kind === "worker" ? (
                      <Bot size={15} className="shrink-0 text-accent" />
                    ) : (
                      <ListChecks size={15} className="shrink-0 text-accent" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">{r.label}</span>
                    {tool && (
                      <span className="mono shrink-0 text-xs text-fg-faint">{tool}</span>
                    )}
                    <span className="mono shrink-0 text-xs tabular text-fg-dim">{elapsed(r)}</span>
                    {isOpen ? (
                      <ChevronUp size={14} className="shrink-0 text-fg-faint" />
                    ) : (
                      <ChevronDown size={14} className="shrink-0 text-fg-faint" />
                    )}
                  </button>
                  {isOpen && r.runId && <RunLog runId={r.runId} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Collapsed bar. */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="mx-auto flex w-full max-w-3xl items-center gap-2 border-t border-line bg-surface px-4 py-2 text-left shadow-[0_-2px_8px_rgba(0,0,0,0.08)] transition-colors hover:bg-surface-2"
      >
        <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
        <span className="shrink-0 text-xs font-medium text-fg-muted">
          {display.length === 1
            ? t("status_strip_one")
            : t("status_strip_n").replace("{n}", String(display.length))}
        </span>
        <span className="mx-1 text-fg-faint" aria-hidden>·</span>
        <span className="min-w-0 flex-1 truncate text-xs text-fg-dim">{newest.label}</span>
        <span className="mono shrink-0 text-xs tabular text-fg-dim">{elapsed(newest)}</span>
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-fg-faint" />
        ) : (
          <ChevronUp size={14} className="shrink-0 text-fg-faint" />
        )}
      </button>
    </div>
  );
}
