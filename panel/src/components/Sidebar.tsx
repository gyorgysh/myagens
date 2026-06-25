import type { Theme } from "../lib/useTheme.ts";
import { useI18n } from "../lib/useI18n.ts";
import type { TranslationKey } from "../i18n/en.ts";

export type Tab =
  | "chat"
  | "crew"
  | "health"
  | "status"
  | "workers"
  | "tasks"
  | "skills"
  | "prompt"
  | "memory"
  | "vault"
  | "connectors"
  | "updates"
  | "logs"
  | "sessions"
  | "schedules"
  | "heartbeat"
  | "usage";

type Item = { id: Tab; labelKey: TranslationKey; icon: string };
type Group = { headingKey: TranslationKey; items: Item[] };

export const NAV: Group[] = [
  {
    headingKey: "nav_monitor",
    items: [
      { id: "health", labelKey: "nav_health", icon: "▦" },
      { id: "sessions", labelKey: "nav_sessions", icon: "◇" },
      { id: "usage", labelKey: "nav_usage", icon: "↗" },
      { id: "logs", labelKey: "nav_logs", icon: "≣" },
    ],
  },
  {
    headingKey: "nav_operate",
    items: [
      { id: "chat", labelKey: "nav_chat", icon: "❯" },
      { id: "crew", labelKey: "nav_crew", icon: "⬡" },
      { id: "workers", labelKey: "nav_workers", icon: "◈" },
      { id: "tasks", labelKey: "nav_tasks", icon: "▤" },
      { id: "schedules", labelKey: "nav_schedules", icon: "◷" },
      { id: "heartbeat", labelKey: "nav_heartbeat", icon: "♡" },
    ],
  },
  {
    headingKey: "nav_configure",
    items: [
      { id: "skills", labelKey: "nav_skills", icon: "✦" },
      { id: "memory", labelKey: "nav_memory", icon: "❋" },
      { id: "vault", labelKey: "nav_vault", icon: "⚷" },
      { id: "connectors", labelKey: "nav_connectors", icon: "⊹" },
      { id: "prompt", labelKey: "nav_prompt", icon: "❝" },
    ],
  },
  {
    headingKey: "nav_others",
    items: [
      { id: "status", labelKey: "nav_status", icon: "◉" },
      { id: "updates", labelKey: "nav_updates", icon: "⤓" },
    ],
  },
];

export function tabLabel(tab: Tab): string {
  for (const g of NAV) for (const i of g.items) if (i.id === tab) return i.labelKey;
  return "";
}

/** All known tab ids, for URL <-> tab mapping. */
export const TAB_IDS: Tab[] = NAV.flatMap((g) => g.items.map((i) => i.id));

export function isTab(value: string): value is Tab {
  return (TAB_IDS as string[]).includes(value);
}

const THEME_ICON: Record<Theme, string> = { light: "☀", dark: "☾", matrix: "▚" };

export function Sidebar({
  tab,
  onSelect,
  theme,
  onToggleTheme,
  onSignOut,
  chatEnabled = true,
  updateAvailable = false,
  expanded = false,
  brandName = "MyHQ",
}: {
  tab: Tab | "settings";
  onSelect: (t: Tab | "settings") => void;
  theme: Theme;
  onToggleTheme: () => void;
  onSignOut: () => void;
  chatEnabled?: boolean;
  updateAvailable?: boolean;
  expanded?: boolean;
  brandName?: string;
}) {
  const { t } = useI18n();
  const labelCls = expanded ? "inline" : "hidden lg:inline";
  const nav = NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => i.id !== "chat" || chatEnabled),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Wordmark */}
      <div className="flex h-14 items-center gap-2 border-b border-line px-4">
        <span className="mono text-sm font-medium text-fg">
          <span className="text-accent">%</span>
          <span className={`ml-1.5 ${labelCls}`}>{brandName}</span>
          <span className="ml-0.5 animate-pulse text-accent">▮</span>
        </span>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto px-2 py-4">
        {nav.map((group) => (
          <div key={group.headingKey} className="mb-4">
            <div
              className={`mono mb-1 px-2 text-[10px] font-medium uppercase tracking-widest text-fg-faint ${labelCls}`}
            >
              {t(group.headingKey)}
            </div>
            {group.items.map((it) => {
              const active = it.id === tab;
              const badge = it.id === "updates" && updateAvailable;
              return (
                <button
                  key={it.id}
                  onClick={() => onSelect(it.id)}
                  title={t(it.labelKey)}
                  className={`flex w-full items-center gap-3 rounded-lg border-l-2 px-2.5 py-2 text-sm transition-colors ${
                    active
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-transparent text-fg-dim hover:bg-surface-2 hover:text-fg"
                  }`}
                >
                  <span className="relative w-4 shrink-0 text-center">
                    {it.icon}
                    {badge && (
                      <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-surface" />
                    )}
                  </span>
                  <span className={`flex-1 text-left ${labelCls}`}>{t(it.labelKey)}</span>
                  {badge && (
                    <span className={`rounded-full bg-accent/15 px-1.5 text-[10px] font-semibold text-accent ${labelCls}`}>
                      1
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer controls */}
      <div className="border-t border-line p-2 space-y-0.5">
        <button
          onClick={onToggleTheme}
          title="Toggle theme"
          className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-fg-dim transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <span className="w-4 shrink-0 text-center">{THEME_ICON[theme]}</span>
          <span className={labelCls}>
            {theme === "light" ? t("theme_light") : theme === "dark" ? t("theme_dark") : t("theme_matrix")}
          </span>
        </button>
        <button
          onClick={() => onSelect("settings")}
          title={t("nav_settings")}
          className={`flex w-full items-center gap-3 rounded-lg border-l-2 px-2.5 py-2 text-sm transition-colors ${
            tab === "settings"
              ? "border-accent bg-accent/10 text-accent"
              : "border-transparent text-fg-dim hover:bg-surface-2 hover:text-fg"
          }`}
        >
          <span className="w-4 shrink-0 text-center">⚙</span>
          <span className={labelCls}>{t("nav_settings")}</span>
        </button>
        <button
          onClick={onSignOut}
          title={t("sign_out")}
          className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-fg-dim transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <span className="w-4 shrink-0 text-center">⏻</span>
          <span className={labelCls}>{t("sign_out")}</span>
        </button>
      </div>
    </div>
  );
}
