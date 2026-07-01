import { useEffect, useRef, useState } from "react";
import type { Theme } from "../lib/useTheme.ts";
import { useI18n } from "../lib/useI18n.ts";
import type { TranslationKey } from "../i18n/en.ts";
import {
  LayoutDashboard,
  ScrollText,
  HeartPulse,
  History,
  TrendingUp,
  Terminal,
  ListTodo,
  Hexagon,
  Inbox,
  Bot,
  Clock,
  Brain,
  KeyRound,
  Plug,
  Webhook,
  MessageSquareQuote,
  FileText,
  Sparkles,
  Pencil,
  Activity,
  Download,
  Database,
  ArrowLeftRight,
  PenLine,
  Settings,
  Sun,
  Moon,
  Binary,
  Contrast,
  Power,
  Menu,
  Images,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";

export type Tab =
  | "setup"
  | "command"
  | "chat"
  | "terminal"
  | "crew"
  | "health"
  | "status"
  | "workers"
  | "inbox"
  | "tasks"
  | "skills"
  | "templates"
  | "prompt"
  | "memory"
  | "vault"
  | "backup"
  | "connectors"
  | "gallery"
  | "updates"
  | "logs"
  | "audit"
  | "sessions"
  | "schedules"
  | "webhooks"
  | "heartbeat"
  | "remote"
  | "feedback"
  | "usage";

type Item = { id: Tab; labelKey: TranslationKey; icon: LucideIcon; hintKey?: TranslationKey };
type Group = { headingKey: TranslationKey; items: Item[] };

/**
 * Primary navigation items surfaced in the mobile bottom bar (high-traffic,
 * always one tap away on phones).
 */
export const PRIMARY_NAV: Item[] = [
  { id: "health", labelKey: "nav_health", icon: LayoutDashboard, hintKey: "nav_health_hint" },
  { id: "command", labelKey: "nav_command", icon: Terminal, hintKey: "nav_command_hint" },
  { id: "tasks", labelKey: "nav_tasks", icon: ListTodo, hintKey: "nav_tasks_hint" },
  { id: "crew", labelKey: "nav_crew", icon: Hexagon, hintKey: "nav_crew_hint" },
  { id: "inbox", labelKey: "nav_inbox", icon: Inbox, hintKey: "nav_inbox_hint" },
];

/**
 * @deprecated Use NAV groups directly. Kept for mobile More drawer compatibility.
 */
export const MORE_NAV: Item[] = [
  { id: "logs", labelKey: "nav_logs", icon: ScrollText, hintKey: "nav_logs_hint" },
  { id: "heartbeat", labelKey: "nav_heartbeat", icon: HeartPulse, hintKey: "nav_heartbeat_hint" },
  { id: "sessions", labelKey: "nav_sessions", icon: History, hintKey: "nav_sessions_hint" },
  { id: "usage", labelKey: "nav_usage", icon: TrendingUp, hintKey: "nav_usage_hint" },
  { id: "workers", labelKey: "nav_workers", icon: Bot, hintKey: "nav_workers_hint" },
  { id: "schedules", labelKey: "nav_schedules", icon: Clock, hintKey: "nav_schedules_hint" },
  { id: "memory", labelKey: "nav_memory", icon: Brain, hintKey: "nav_memory_hint" },
  { id: "vault", labelKey: "nav_vault", icon: KeyRound, hintKey: "nav_vault_hint" },
  { id: "connectors", labelKey: "nav_connectors", icon: Plug, hintKey: "nav_connectors_hint" },
  { id: "prompt", labelKey: "nav_prompt", icon: MessageSquareQuote, hintKey: "nav_prompt_hint" },
  { id: "templates", labelKey: "nav_templates", icon: FileText, hintKey: "nav_templates_hint" },
  { id: "skills", labelKey: "nav_skills", icon: Sparkles, hintKey: "nav_skills_hint" },
  { id: "setup", labelKey: "nav_setup", icon: Pencil, hintKey: "nav_setup_hint" },
];

/**
 * Canonical three-group nav structure: Monitor / Operate / Configure.
 * On desktop the sidebar renders all three groups with section headings.
 * On mobile these groups feed the searchable More drawer.
 */
export const NAV: Group[] = [
  {
    // Monitor — things you observe passively: system state, events, activity
    headingKey: "nav_monitor",
    items: [
      { id: "health", labelKey: "nav_health", icon: LayoutDashboard, hintKey: "nav_health_hint" },
      { id: "logs", labelKey: "nav_logs", icon: ScrollText, hintKey: "nav_logs_hint" },
      { id: "audit", labelKey: "nav_audit", icon: ShieldAlert, hintKey: "nav_audit_hint" },
      { id: "heartbeat", labelKey: "nav_heartbeat", icon: HeartPulse, hintKey: "nav_heartbeat_hint" },
      { id: "sessions", labelKey: "nav_sessions", icon: History, hintKey: "nav_sessions_hint" },
      { id: "usage", labelKey: "nav_usage", icon: TrendingUp, hintKey: "nav_usage_hint" },
    ],
  },
  {
    // Operate — things you actively work with day to day
    headingKey: "nav_operate",
    items: [
      { id: "command", labelKey: "nav_command", icon: Terminal, hintKey: "nav_command_hint" },
      { id: "tasks", labelKey: "nav_tasks", icon: ListTodo, hintKey: "nav_tasks_hint" },
      { id: "crew", labelKey: "nav_crew", icon: Hexagon, hintKey: "nav_crew_hint" },
      { id: "inbox", labelKey: "nav_inbox", icon: Inbox, hintKey: "nav_inbox_hint" },
      { id: "workers", labelKey: "nav_workers", icon: Bot, hintKey: "nav_workers_hint" },
      { id: "schedules", labelKey: "nav_schedules", icon: Clock, hintKey: "nav_schedules_hint" },
      { id: "webhooks", labelKey: "nav_webhooks", icon: Webhook, hintKey: "nav_webhooks_hint" },
    ],
  },
  {
    // Configure — set once, rarely revisit
    headingKey: "nav_configure",
    items: [
      { id: "memory", labelKey: "nav_memory", icon: Brain, hintKey: "nav_memory_hint" },
      { id: "vault", labelKey: "nav_vault", icon: KeyRound, hintKey: "nav_vault_hint" },
      { id: "connectors", labelKey: "nav_connectors", icon: Plug, hintKey: "nav_connectors_hint" },
      { id: "gallery", labelKey: "nav_gallery", icon: Images, hintKey: "nav_gallery_hint" },
      { id: "prompt", labelKey: "nav_prompt", icon: MessageSquareQuote, hintKey: "nav_prompt_hint" },
      { id: "templates", labelKey: "nav_templates", icon: FileText, hintKey: "nav_templates_hint" },
      { id: "skills", labelKey: "nav_skills", icon: Sparkles, hintKey: "nav_skills_hint" },
      { id: "setup", labelKey: "nav_setup", icon: Pencil, hintKey: "nav_setup_hint" },
    ],
  },
];

/**
 * Utility / meta items visited rarely (Status, Updates, Backup, Remote Access,
 * Feedback). They live in the sidebar footer rather than the main nav flow, so
 * the high-traffic groups above stay short. Status/update badges still surface
 * here via the footer link icons.
 */
export const FOOTER_NAV: Item[] = [
  { id: "status", labelKey: "nav_status", icon: Activity, hintKey: "nav_status_hint" },
  { id: "updates", labelKey: "nav_updates", icon: Download, hintKey: "nav_updates_hint" },
  { id: "backup", labelKey: "nav_backup", icon: Database, hintKey: "nav_backup_hint" },
  { id: "remote", labelKey: "nav_remote", icon: ArrowLeftRight, hintKey: "nav_remote_hint" },
  { id: "feedback", labelKey: "nav_feedback", icon: PenLine, hintKey: "nav_feedback_hint" },
];

/** Every group + the footer items, for search/lookup that must span all tabs. */
export const ALL_GROUPS: Group[] = [...NAV, { headingKey: "nav_others", items: FOOTER_NAV }];

/**
 * The legacy chat/terminal tabs are folded into the Command Hub. They stay
 * routable (old bookmarks / deep-links still work) but should resolve to the
 * unified Command tab in the sidebar's active-state highlighting.
 */
const COMMAND_CHILDREN: Tab[] = ["chat", "terminal"];
export function isCommandChild(tab: Tab | "settings"): boolean {
  return COMMAND_CHILDREN.includes(tab as Tab);
}
/** Tabs that resolve to the Settings highlight. Currently none — vault,
 *  connectors, prompt, and skills are top-level nav items in Configure. */
const SETTINGS_CHILDREN: Tab[] = [];
export function isSettingsChild(tab: Tab | "settings"): boolean {
  return SETTINGS_CHILDREN.includes(tab as Tab);
}

export function tabLabel(tab: Tab): string {
  for (const g of ALL_GROUPS) for (const i of g.items) if (i.id === tab) return i.labelKey;
  // Legacy command children resolve to the Command Hub label.
  if (isCommandChild(tab)) return "nav_command";
  return "";
}

/** A handful of high-traffic tabs surfaced in the mobile bottom nav. */
const BOTTOM_NAV: Item[] = [
  { id: "health", labelKey: "nav_health", icon: LayoutDashboard },
  { id: "command", labelKey: "nav_command", icon: Terminal },
  { id: "tasks", labelKey: "nav_tasks", icon: ListTodo },
  { id: "inbox", labelKey: "nav_inbox", icon: Inbox },
];

/** Fixed bottom navigation bar shown only on narrow screens (below md). */
export function BottomNav({
  tab,
  onSelect,
  onOpenMenu,
  inboxPending = 0,
}: {
  tab: Tab | "settings";
  onSelect: (t: Tab) => void;
  onOpenMenu: () => void;
  inboxPending?: number;
}) {
  const { t } = useI18n();
  // The Command Hub stays visible even when chat is disabled (it still hosts
  // the Terminal sub-tab); the hub itself handles a disabled sub-tab.
  const items = BOTTOM_NAV;
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface md:hidden">
      {items.map((it) => {
        const active = it.id === tab || (it.id === "command" && isCommandChild(tab));
        const showBadge = it.id === "inbox" && inboxPending > 0;
        const Icon = it.icon;
        return (
          <button
            key={it.id}
            onClick={() => onSelect(it.id)}
            className={`relative flex flex-1 flex-col items-center gap-0.5 py-2 text-xs transition-colors ${
              active ? "text-accent" : "text-fg-dim"
            }`}
          >
            <span className="relative leading-none">
              <Icon className="h-5 w-5" strokeWidth={active ? 2.25 : 1.75} />
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
        className="flex flex-1 flex-col items-center gap-0.5 py-2 text-xs text-fg-dim transition-colors"
      >
        <Menu className="h-5 w-5" strokeWidth={1.75} />
        <span>{t("nav_more")}</span>
      </button>
    </nav>
  );
}

/**
 * Mobile "More" bottom-sheet drawer. Replaces the flat drawer with a grouped,
 * searchable surface: a filter input at the top instantly narrows the 20-odd
 * destinations (the core discoverability problem on a phone), and the results
 * keep the same section headings as the sidebar. Springs up from the bottom;
 * tapping the backdrop or swiping down dismisses it.
 */
export function MoreDrawer({
  open,
  tab,
  onSelect,
  onClose,
  chatEnabled = true,
  inboxPending = 0,
  updateAvailable = false,
}: {
  open: boolean;
  tab: Tab | "settings";
  onSelect: (t: Tab | "settings") => void;
  onClose: () => void;
  chatEnabled?: boolean;
  inboxPending?: number;
  updateAvailable?: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Track touch for a swipe-down-to-dismiss gesture on the sheet handle.
  const touchStartY = useRef<number | null>(null);

  // Reset the filter each time the sheet opens and focus the search field.
  useEffect(() => {
    if (open) {
      setQuery("");
      // Defer focus until the sheet has sprung into place.
      const id = window.setTimeout(() => inputRef.current?.focus(), 250);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  // Close on Escape for keyboard users / external bluetooth keyboards.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  void chatEnabled; // Command Hub stays listed regardless; the hub handles a disabled sub-tab.
  const q = query.trim().toLowerCase();
  const groups = ALL_GROUPS.map((g) => ({
    headingKey: g.headingKey,
    items: g.items.filter((it) => {
      if (!q) return true;
      const label = t(it.labelKey).toLowerCase();
      const hint = it.hintKey ? t(it.hintKey).toLowerCase() : "";
      return label.includes(q) || hint.includes(q);
    }),
  })).filter((g) => g.items.length > 0);

  // The standalone Settings destination is searchable too.
  const settingsMatches =
    !q || t("nav_settings").toLowerCase().includes(q) || t("nav_settings_hint").toLowerCase().includes(q);

  return (
    <div
      className={`fixed inset-0 z-40 md:hidden ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("nav_more")}
        onTouchStart={(e) => (touchStartY.current = e.touches[0].clientY)}
        onTouchEnd={(e) => {
          if (touchStartY.current == null) return;
          if (e.changedTouches[0].clientY - touchStartY.current > 60) onClose();
          touchStartY.current = null;
        }}
        className={`absolute inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t border-line bg-surface pb-safe shadow-2xl transition-transform duration-300 ${
          open ? "translate-y-0 ease-[cubic-bezier(0.22,1,0.36,1)]" : "translate-y-full"
        }`}
      >
        {/* Grab handle */}
        <div className="sticky top-0 z-10 bg-surface pt-2">
          <div className="mx-auto h-1 w-10 rounded-full bg-line" aria-hidden />
          <div className="px-4 pb-2 pt-3">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("nav_more_search")}
              aria-label={t("nav_more_search")}
              className="w-full rounded-lg border border-line bg-input px-3 py-2.5 text-sm text-fg outline-none focus:border-accent"
            />
          </div>
        </div>

        <div className="px-2 pb-4">
          {groups.length === 0 && !settingsMatches ? (
            <p className="px-2 py-8 text-center text-sm text-fg-faint">{t("nav_more_no_results")}</p>
          ) : (
            <>
              {groups.map((g) => (
                <div key={g.headingKey} className="mb-3">
                  <div className="mono-xs mb-1 px-2 font-medium uppercase tracking-widest text-fg-faint">
                    {t(g.headingKey)}
                  </div>
                  {g.items.map((it) => {
                    const active = it.id === tab || (it.id === "command" && isCommandChild(tab));
                    const inboxBadge = it.id === "inbox" && inboxPending > 0;
                    const updateBadge = it.id === "updates" && updateAvailable;
                    const Icon = it.icon;
                    return (
                      <button
                        key={it.id}
                        onClick={() => {
                          onSelect(it.id);
                          onClose();
                        }}
                        aria-current={active ? "page" : undefined}
                        className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm transition-colors ${
                          active
                            ? "bg-accent/10 text-accent"
                            : "text-fg-dim hover:bg-surface-2 active:bg-surface-2"
                        }`}
                      >
                        <Icon className="h-4 w-4 shrink-0" strokeWidth={active ? 2.25 : 1.75} />
                        <span className="min-w-0 flex-1 text-left">
                          <span className="block truncate">{t(it.labelKey)}</span>
                          {it.hintKey && (
                            <span className="block truncate text-xs text-fg-faint">{t(it.hintKey)}</span>
                          )}
                        </span>
                        {(inboxBadge || updateBadge) && (
                          <span className="shrink-0 rounded-full bg-accent/15 px-1.5 text-xs font-semibold text-accent">
                            {inboxBadge ? (inboxPending > 99 ? "99+" : inboxPending) : t("nav_more_new")}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
              {settingsMatches && (
                <button
                  onClick={() => {
                    onSelect("settings");
                    onClose();
                  }}
                  aria-current={tab === "settings" || isSettingsChild(tab) ? "page" : undefined}
                  className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm transition-colors ${
                    tab === "settings" || isSettingsChild(tab)
                      ? "bg-accent/10 text-accent"
                      : "text-fg-dim hover:bg-surface-2 active:bg-surface-2"
                  }`}
                >
                  <Settings
                    className="h-4 w-4 shrink-0"
                    strokeWidth={tab === "settings" || isSettingsChild(tab) ? 2.25 : 1.75}
                  />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate">{t("nav_settings")}</span>
                    <span className="block truncate text-xs text-fg-faint">{t("nav_settings_hint")}</span>
                  </span>
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * All known tab ids, for URL <-> tab mapping. Built from the grouped nav plus
 * the Command Hub children (chat/terminal), which are routable for legacy
 * deep-links even though they no longer appear as standalone nav entries.
 */
export const TAB_IDS: Tab[] = Array.from(
  new Set<Tab>([...ALL_GROUPS.flatMap((g) => g.items.map((i) => i.id)), ...COMMAND_CHILDREN]),
);

export function isTab(value: string): value is Tab {
  return (TAB_IDS as string[]).includes(value);
}

const THEME_ICON: Record<Theme, LucideIcon> = { light: Sun, dark: Moon, matrix: Binary, contrast: Contrast };

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
  logoUrl,
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
  logoUrl?: string;
}) {
  const { t } = useI18n();
  void chatEnabled; // Command Hub stays visible regardless; see App.tsx routing.
  const labelCls = expanded ? "inline" : "hidden lg:inline";

  // No More/Less toggle on desktop — all groups are always visible.

  // One nav row. `active` highlights the current tab; the Command Hub also
  // highlights when one of its legacy children (chat/terminal) is the route.
  const navButton = (it: Item) => {
    const active = it.id === tab || (it.id === "command" && isCommandChild(tab));
    const inboxBadge = it.id === "inbox" && inboxPending > 0;
    const updateBadge = it.id === "updates" && updateAvailable;
    const badge = updateBadge || inboxBadge;
    const count = inboxBadge ? inboxPending : updateCount;
    const badgeText = count > 99 ? "99+" : String(count || 1);
    const Icon = it.icon;
    return (
      <button
        key={it.id}
        onClick={() => onSelect(it.id)}
        title={it.hintKey ? `${t(it.labelKey)} — ${t(it.hintKey)}` : t(it.labelKey)}
        aria-label={it.hintKey ? `${t(it.labelKey)}: ${t(it.hintKey)}` : t(it.labelKey)}
        aria-current={active ? "page" : undefined}
        className={`flex w-full items-center gap-2 rounded-lg border-l-2 px-2.5 py-1.5 text-xs transition-colors ${
          active
            ? "border-accent bg-accent/10 text-accent"
            : "border-transparent text-fg-dim hover:bg-surface-2 hover:text-fg"
        }`}
      >
        <span className="relative flex h-5 w-5 shrink-0 items-center justify-center leading-none">
          <Icon className="h-[18px] w-[18px]" strokeWidth={active ? 2.25 : 1.75} />
          {badge && (
            <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-surface" />
          )}
        </span>
        <span className={`flex-1 text-left ${labelCls}`}>{t(it.labelKey)}</span>
        {badge && (
          <span className={`rounded-full bg-accent/15 px-1.5 text-xs font-semibold text-accent ${labelCls}`}>
            {badgeText}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Wordmark */}
      <div className="flex h-12 items-center gap-2 border-b border-line px-4">
        {logoUrl ? (
          <span className="flex items-center gap-2">
            <img src={logoUrl} alt={brandName} className="h-6 w-6 rounded object-contain" />
            <span className={`text-sm font-medium text-fg ${labelCls}`}>{brandName}</span>
          </span>
        ) : (
          <span className="mono text-sm font-medium text-fg">
            <span className="text-accent">%</span>
            <span className={`ml-1.5 ${labelCls}`}>{brandName}</span>
            <span className="ml-0.5 animate-pulse text-accent">▮</span>
          </span>
        )}
      </div>

      {/* Nav — all three groups always visible on desktop with section
          headings. On the narrow tablet icon rail (md, not expanded) only
          icons render; labels are hidden via labelCls. Mobile uses the
          bottom nav + More drawer instead. */}
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {NAV.map((group, gi) => (
          <div key={group.headingKey} className={gi > 0 ? "mt-2.5" : ""}>
            <div
              className={`mono-xs mb-0.5 px-2.5 font-medium uppercase tracking-widest text-fg-faint ${labelCls}`}
            >
              {t(group.headingKey)}
            </div>
            <div className="space-y-0.5">{group.items.map(navButton)}</div>
          </div>
        ))}
      </nav>

      {/* Footer controls */}
      <div className="border-t border-line p-1.5 space-y-0.5">
        {/* Utility / meta links (Status, Updates, Backup, Remote, Feedback):
            demoted out of the main nav into a compact icon row so the
            high-traffic groups above stay short. Labels appear inline only when
            the sidebar is expanded; on the icon rail they're icon-only links. */}
        <div
          className={`mb-1 flex gap-0.5 pb-1 ${expanded ? "flex-wrap" : "flex-col lg:flex-row lg:flex-wrap"}`}
        >
          {FOOTER_NAV.map((it) => {
            const active = it.id === tab;
            const updateBadge = it.id === "updates" && updateAvailable;
            const Icon = it.icon;
            return (
              <button
                key={it.id}
                onClick={() => onSelect(it.id)}
                title={it.hintKey ? `${t(it.labelKey)} — ${t(it.hintKey)}` : t(it.labelKey)}
                aria-label={it.hintKey ? `${t(it.labelKey)}: ${t(it.hintKey)}` : t(it.labelKey)}
                aria-current={active ? "page" : undefined}
                className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${
                  expanded ? "w-full" : "lg:w-auto"
                } ${
                  active
                    ? "bg-accent/10 text-accent"
                    : "text-fg-faint hover:bg-surface-2 hover:text-fg-dim"
                }`}
              >
                <span className="relative flex h-5 w-5 shrink-0 items-center justify-center leading-none">
                  <Icon className="h-4 w-4" strokeWidth={active ? 2.25 : 1.75} />
                  {updateBadge && (
                    <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-surface" />
                  )}
                </span>
                <span className={labelCls}>{t(it.labelKey)}</span>
              </button>
            );
          })}
        </div>
        {(() => {
          const ThemeIcon = THEME_ICON[theme];
          return (
            <button
              onClick={onToggleTheme}
              title={t("theme_toggle")}
              aria-label={t("theme_toggle")}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-fg-dim transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center leading-none">
                <ThemeIcon className="h-[18px] w-[18px]" strokeWidth={1.75} />
              </span>
              <span className={labelCls}>
                {theme === "light"
                  ? t("theme_light")
                  : theme === "dark"
                    ? t("theme_dark")
                    : theme === "contrast"
                      ? t("theme_contrast")
                      : t("theme_matrix")}
              </span>
            </button>
          );
        })()}
        <button
          onClick={() => onSelect("settings")}
          title={t("nav_settings")}
          aria-label={t("nav_settings")}
          aria-current={tab === "settings" || isSettingsChild(tab) ? "page" : undefined}
          className={`flex w-full items-center gap-2 rounded-lg border-l-2 px-2.5 py-1.5 text-xs transition-colors ${
            tab === "settings" || isSettingsChild(tab)
              ? "border-accent bg-accent/10 text-accent"
              : "border-transparent text-fg-dim hover:bg-surface-2 hover:text-fg"
          }`}
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center leading-none">
            <Settings
              className="h-[18px] w-[18px]"
              strokeWidth={tab === "settings" || isSettingsChild(tab) ? 2.25 : 1.75}
            />
          </span>
          <span className={labelCls}>{t("nav_settings")}</span>
        </button>
        <button
          onClick={onSignOut}
          title={t("sign_out")}
          aria-label={t("sign_out")}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-fg-dim transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center leading-none">
            <Power className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </span>
          <span className={labelCls}>{t("sign_out")}</span>
        </button>
      </div>
    </div>
  );
}
