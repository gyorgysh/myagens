import type { Theme } from "../lib/useTheme.ts";
import { useI18n } from "../lib/useI18n.ts";
import type { TranslationKey } from "../i18n/en.ts";

export type Tab =
  | "setup"
  | "chat"
  | "terminal"
  | "crew"
  | "health"
  | "status"
  | "workers"
  | "inbox"
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
  | "remote"
  | "usage";

type Item = { id: Tab; labelKey: TranslationKey; icon: string; hintKey?: TranslationKey };
type Group = { headingKey: TranslationKey; items: Item[] };

export const NAV: Group[] = [
  {
    headingKey: "nav_monitor",
    items: [
      { id: "health", labelKey: "nav_health", icon: "▦", hintKey: "nav_health_hint" },
      { id: "sessions", labelKey: "nav_sessions", icon: "◇", hintKey: "nav_sessions_hint" },
      { id: "usage", labelKey: "nav_usage", icon: "↗", hintKey: "nav_usage_hint" },
      { id: "logs", labelKey: "nav_logs", icon: "≣", hintKey: "nav_logs_hint" },
    ],
  },
  {
    headingKey: "nav_operate",
    items: [
      { id: "chat", labelKey: "nav_chat", icon: "❯", hintKey: "nav_chat_hint" },
      { id: "terminal", labelKey: "nav_terminal", icon: "▸", hintKey: "nav_terminal_hint" },
      { id: "crew", labelKey: "nav_crew", icon: "⬡", hintKey: "nav_crew_hint" },
      { id: "workers", labelKey: "nav_workers", icon: "◈", hintKey: "nav_workers_hint" },
      { id: "inbox", labelKey: "nav_inbox", icon: "✉", hintKey: "nav_inbox_hint" },
      { id: "tasks", labelKey: "nav_tasks", icon: "▤", hintKey: "nav_tasks_hint" },
      { id: "schedules", labelKey: "nav_schedules", icon: "◷", hintKey: "nav_schedules_hint" },
      { id: "heartbeat", labelKey: "nav_heartbeat", icon: "♡", hintKey: "nav_heartbeat_hint" },
    ],
  },
  {
    headingKey: "nav_configure",
    items: [
      { id: "setup", labelKey: "nav_setup", icon: "✎", hintKey: "nav_setup_hint" },
      { id: "skills", labelKey: "nav_skills", icon: "✦", hintKey: "nav_skills_hint" },
      { id: "memory", labelKey: "nav_memory", icon: "❋", hintKey: "nav_memory_hint" },
      { id: "vault", labelKey: "nav_vault", icon: "⚷", hintKey: "nav_vault_hint" },
      { id: "connectors", labelKey: "nav_connectors", icon: "⊹", hintKey: "nav_connectors_hint" },
      { id: "prompt", labelKey: "nav_prompt", icon: "❝", hintKey: "nav_prompt_hint" },
    ],
  },
  {
    headingKey: "nav_others",
    items: [
      { id: "status", labelKey: "nav_status", icon: "◉", hintKey: "nav_status_hint" },
      { id: "updates", labelKey: "nav_updates", icon: "⤓", hintKey: "nav_updates_hint" },
      { id: "remote", labelKey: "nav_remote", icon: "⇆", hintKey: "nav_remote_hint" },
    ],
  },
];

export function tabLabel(tab: Tab): string {
  for (const g of NAV) for (const i of g.items) if (i.id === tab) return i.labelKey;
  return "";
}

/** A handful of high-traffic tabs surfaced in the mobile bottom nav. */
const BOTTOM_NAV: Item[] = [
  { id: "health", labelKey: "nav_health", icon: "▦" },
  { id: "chat", labelKey: "nav_chat", icon: "❯" },
  { id: "tasks", labelKey: "nav_tasks", icon: "▤" },
  { id: "inbox", labelKey: "nav_inbox", icon: "✉" },
];

/** Fixed bottom navigation bar shown only on narrow screens (below md). */
export function BottomNav({
  tab,
  onSelect,
  onOpenMenu,
  chatEnabled = true,
  inboxPending = 0,
}: {
  tab: Tab | "settings";
  onSelect: (t: Tab) => void;
  onOpenMenu: () => void;
  chatEnabled?: boolean;
  inboxPending?: number;
}) {
  const { t } = useI18n();
  const items = BOTTOM_NAV.filter((i) => i.id !== "chat" || chatEnabled);
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface md:hidden">
      {items.map((it) => {
        const active = it.id === tab;
        const showBadge = it.id === "inbox" && inboxPending > 0;
        return (
          <button
            key={it.id}
            onClick={() => onSelect(it.id)}
            className={`relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] transition-colors ${
              active ? "text-accent" : "text-fg-dim"
            }`}
          >
            <span className="relative text-base leading-none">
              {it.icon}
              {showBadge && (
                <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
              )}
            </span>
            <span>{t(it.labelKey)}</span>
          </button>
        );
      })}
      <button
        onClick={onOpenMenu}
        className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] text-fg-dim transition-colors"
      >
        <span className="text-base leading-none">☰</span>
        <span>{t("nav_more")}</span>
      </button>
    </nav>
  );
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
  updateCount = 0,
  inboxPending = 0,
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
  updateCount?: number;
  inboxPending?: number;
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
              const inboxBadge = it.id === "inbox" && inboxPending > 0;
              const updateBadge = it.id === "updates" && updateAvailable;
              const badge = updateBadge || inboxBadge;
              const count = inboxBadge ? inboxPending : updateCount;
              const badgeText = count > 99 ? "99+" : String(count || 1);
              return (
                <button
                  key={it.id}
                  onClick={() => onSelect(it.id)}
                  title={it.hintKey ? `${t(it.labelKey)} — ${t(it.hintKey)}` : t(it.labelKey)}
                  aria-label={it.hintKey ? `${t(it.labelKey)}: ${t(it.hintKey)}` : t(it.labelKey)}
                  aria-current={active ? "page" : undefined}
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
                      {badgeText}
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
          title={t("theme_toggle")}
          aria-label={t("theme_toggle")}
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
          aria-label={t("nav_settings")}
          aria-current={tab === "settings" ? "page" : undefined}
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
          aria-label={t("sign_out")}
          className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-fg-dim transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <span className="w-4 shrink-0 text-center">⏻</span>
          <span className={labelCls}>{t("sign_out")}</span>
        </button>
      </div>
    </div>
  );
}
