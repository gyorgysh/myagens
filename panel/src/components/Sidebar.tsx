import type { Theme } from "../lib/useTheme.ts";

export type Tab =
  | "chat"
  | "health"
  | "status"
  | "workers"
  | "tasks"
  | "skills"
  | "prompt"
  | "memory"
  | "vault"
  | "connectors"
  | "logs"
  | "sessions"
  | "schedules"
  | "heartbeat"
  | "usage";

type Item = { id: Tab; label: string; icon: string };
type Group = { heading: string; items: Item[] };

export const NAV: Group[] = [
  {
    heading: "Monitor",
    items: [
      { id: "health", label: "System", icon: "▦" },
      { id: "sessions", label: "Sessions", icon: "◇" },
      { id: "usage", label: "Usage", icon: "↗" },
      { id: "logs", label: "Logs", icon: "≣" },
    ],
  },
  {
    heading: "Operate",
    items: [
      { id: "chat", label: "Chat", icon: "❯" },
      { id: "workers", label: "Agents", icon: "◈" },
      { id: "tasks", label: "Tasks", icon: "▤" },
      { id: "schedules", label: "Schedules", icon: "◷" },
      { id: "heartbeat", label: "Heartbeat", icon: "♡" },
    ],
  },
  {
    heading: "Configure",
    items: [
      { id: "skills", label: "Skills", icon: "✦" },
      { id: "memory", label: "Memory", icon: "❋" },
      { id: "vault", label: "Vault", icon: "⚷" },
      { id: "connectors", label: "Connectors", icon: "⊹" },
      { id: "prompt", label: "Prompt", icon: "❝" },
    ],
  },
  {
    heading: "Others",
    items: [{ id: "status", label: "Status", icon: "◉" }],
  },
];

export function tabLabel(tab: Tab): string {
  for (const g of NAV) for (const i of g.items) if (i.id === tab) return i.label;
  return "";
}

/** All known tab ids, for URL <-> tab mapping. */
export const TAB_IDS: Tab[] = NAV.flatMap((g) => g.items.map((i) => i.id));

export function isTab(value: string): value is Tab {
  return (TAB_IDS as string[]).includes(value);
}

const THEME_ICON: Record<Theme, string> = { light: "☀", dark: "☾", matrix: "▚" };

/**
 * Left navigation. Responsive on its own via Tailwind: an icon-only rail on
 * tablet (md) that expands to labels on desktop (lg). When `expanded` is set
 * (the mobile drawer) it always shows full width + labels.
 */
export function Sidebar({
  tab,
  onSelect,
  theme,
  onToggleTheme,
  onSignOut,
  chatEnabled = true,
  expanded = false,
}: {
  tab: Tab;
  onSelect: (t: Tab) => void;
  theme: Theme;
  onToggleTheme: () => void;
  onSignOut: () => void;
  chatEnabled?: boolean;
  expanded?: boolean;
}) {
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
          <span className={`ml-1.5 ${labelCls}`}>cct panel</span>
          <span className="ml-0.5 animate-pulse text-accent">▮</span>
        </span>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto px-2 py-4">
        {nav.map((group) => (
          <div key={group.heading} className="mb-4">
            <div
              className={`mono mb-1 px-2 text-[10px] font-medium uppercase tracking-widest text-fg-faint ${labelCls}`}
            >
              {group.heading}
            </div>
            {group.items.map((it) => {
              const active = it.id === tab;
              return (
                <button
                  key={it.id}
                  onClick={() => onSelect(it.id)}
                  title={it.label}
                  className={`flex w-full items-center gap-3 rounded-lg border-l-2 px-2.5 py-2 text-sm transition-colors ${
                    active
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-transparent text-fg-dim hover:bg-surface-2 hover:text-fg"
                  }`}
                >
                  <span className="w-4 shrink-0 text-center">{it.icon}</span>
                  <span className={labelCls}>{it.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer controls */}
      <div className="border-t border-line p-2">
        <button
          onClick={onToggleTheme}
          title="Toggle theme"
          className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-fg-dim transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <span className="w-4 shrink-0 text-center">{THEME_ICON[theme]}</span>
          <span className={labelCls}>
            {theme === "light" ? "Light" : theme === "dark" ? "Dark" : "Matrix"}
          </span>
        </button>
        <button
          onClick={onSignOut}
          title="Sign out"
          className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-fg-dim transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <span className="w-4 shrink-0 text-center">⏻</span>
          <span className={labelCls}>Sign out</span>
        </button>
      </div>
    </div>
  );
}
