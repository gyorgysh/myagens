import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useI18n } from "../lib/useI18n.ts";
import type { TranslationKey } from "../i18n/en.ts";
import type { Tab } from "./Sidebar.tsx";

// ---------------------------------------------------------------------------
// Empty-state illustrations
//
// A small set of line-art SVGs sharing one visual language: 1.5px strokes in
// `currentColor` so they inherit the muted theme token from the <Empty> wrapper
// and adapt to light / dark / matrix automatically. No fills, no hardcoded
// colours.
// ---------------------------------------------------------------------------

const svgProps = {
  width: 72,
  height: 72,
  viewBox: "0 0 48 48",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** Crew / workers — a head with two reports below it. */
export function CrewArt() {
  return (
    <svg {...svgProps} aria-hidden>
      <circle cx="24" cy="11" r="5" />
      <circle cx="13" cy="33" r="4.5" />
      <circle cx="35" cy="33" r="4.5" />
      <path d="M24 16v6m0 0l-9 7m9-7l9 7" />
    </svg>
  );
}

/** Schedules — a clock face. */
export function ScheduleArt() {
  return (
    <svg {...svgProps} aria-hidden>
      <circle cx="24" cy="24" r="16" />
      <path d="M24 15v9l6 4" />
    </svg>
  );
}

/** Inbox — an open tray with an envelope. */
export function InboxArt() {
  return (
    <svg {...svgProps} aria-hidden>
      <path d="M8 28v8a2 2 0 002 2h28a2 2 0 002-2v-8" />
      <path d="M8 28l5-16a2 2 0 012-1.5h18a2 2 0 012 1.5l5 16" />
      <path d="M8 28h9l2 4h10l2-4h9" />
    </svg>
  );
}

/** Skills — a spark / asterisk in a rounded square. */
export function SkillsArt() {
  return (
    <svg {...svgProps} aria-hidden>
      <rect x="9" y="9" width="30" height="30" rx="4" />
      <path d="M24 16v16M16 24h16M18.5 18.5l11 11M29.5 18.5l-11 11" />
    </svg>
  );
}

/** Memory — overlapping notes / cards. */
export function MemoryArt() {
  return (
    <svg {...svgProps} aria-hidden>
      <rect x="9" y="13" width="22" height="26" rx="2" />
      <path d="M17 9h22v26" />
      <path d="M13.5 20h13M13.5 25h13M13.5 30h8" />
    </svg>
  );
}

/** Vault — a padlock. */
export function VaultArt() {
  return (
    <svg {...svgProps} aria-hidden>
      <rect x="11" y="21" width="26" height="18" rx="3" />
      <path d="M16 21v-5a8 8 0 0116 0v5" />
      <circle cx="24" cy="29" r="2" />
      <path d="M24 31v3" />
    </svg>
  );
}

/** Sessions — a chat bubble. */
export function SessionsArt() {
  return (
    <svg {...svgProps} aria-hidden>
      <path d="M9 12a3 3 0 013-3h24a3 3 0 013 3v16a3 3 0 01-3 3H20l-8 7v-7h-0a3 3 0 01-3-3z" />
      <path d="M16 17h16M16 22h10" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// First-run "Getting started" checklist
//
// Shows on the dashboard until every step is done OR the card is dismissed.
// Each step links to the tab where the action lives. Steps reflect real state
// (a worker exists, a schedule exists, a secret is vaulted, a connector is
// attached) so the checklist self-completes as the user sets things up.
// ---------------------------------------------------------------------------

type Step = {
  key: TranslationKey;
  descKey: TranslationKey;
  tab: Tab;
  done: boolean;
};

const DISMISS_KEY = "cct.onboarding.dismissed";

export function GettingStarted({ onGoto }: { onGoto: (t: Tab) => void }) {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1");
  const [steps, setSteps] = useState<Step[] | null>(null);

  useEffect(() => {
    if (dismissed) return;
    let alive = true;
    Promise.allSettled([api.workers(), api.schedules(), api.vault(), api.connectors()]).then(
      ([w, s, v, c]) => {
        if (!alive) return;
        const hasWorker = w.status === "fulfilled" && w.value.workers.length > 0;
        const hasSchedule = s.status === "fulfilled" && s.value.schedules.length > 0;
        const hasSecret = v.status === "fulfilled" && v.value.secrets.length > 0;
        const hasConnector =
          c.status === "fulfilled" && c.value.connectors.some((x) => Boolean(x.secretId));
        setSteps([
          { key: "onb_step_crew", descKey: "onb_step_crew_desc", tab: "crew", done: hasWorker },
          { key: "onb_step_schedule", descKey: "onb_step_schedule_desc", tab: "schedules", done: hasSchedule },
          { key: "onb_step_vault", descKey: "onb_step_vault_desc", tab: "vault", done: hasSecret },
          { key: "onb_step_connect", descKey: "onb_step_connect_desc", tab: "connectors", done: hasConnector },
        ]);
      },
    );
    return () => {
      alive = false;
    };
  }, [dismissed]);

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  if (dismissed || !steps) return null;
  const doneCount = steps.filter((s) => s.done).length;
  // Self-dismiss once everything is set up — no clutter for configured installs.
  if (doneCount === steps.length) return null;

  const pct = Math.round((doneCount / steps.length) * 100);

  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-fg">{t("onb_title")}</h3>
          <p className="mt-0.5 text-xs text-fg-dim">{t("onb_desc")}</p>
        </div>
        <button
          onClick={dismiss}
          className="shrink-0 text-xs text-fg-faint hover:text-fg-muted"
          aria-label={t("onb_dismiss")}
        >
          {t("onb_dismiss")}
        </button>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="tabular shrink-0 text-xs text-fg-dim">
          {doneCount}/{steps.length}
        </span>
      </div>

      <ul className="space-y-1.5">
        {steps.map((s) => (
          <li key={s.key}>
            <button
              onClick={() => onGoto(s.tab)}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
                  s.done
                    ? "border-accent bg-accent text-accent-fg"
                    : "border-line text-transparent"
                }`}
              >
                ✓
              </span>
              <span className="min-w-0 flex-1">
                <span className={`text-sm ${s.done ? "text-fg-dim line-through" : "text-fg"}`}>
                  {t(s.key)}
                </span>
                {!s.done && (
                  <span className="block truncate text-xs text-fg-faint">{t(s.descKey)}</span>
                )}
              </span>
              {!s.done && <span className="shrink-0 text-xs text-accent">→</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
