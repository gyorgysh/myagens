import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api, checkToken, clearToken, getToken, setToken, type Branding } from "./api.ts";
import { useTheme } from "./lib/useTheme.ts";
import { Login } from "./components/Login.tsx";
import { Sidebar, BottomNav, MoreDrawer, tabLabel, isTab, isCommandChild, type Tab } from "./components/Sidebar.tsx";
import { useI18n } from "./lib/useI18n.ts";
import type { TranslationKey } from "./i18n/en.ts";
// Eager — these are on the critical path (first paint / always visible).
import { CommandHub } from "./components/CommandHub.tsx";
import { HealthView } from "./components/Health.tsx";
import { SetupView } from "./components/Setup.tsx";
import { ToastViewport, Breadcrumb } from "./components/ui.tsx";
import { ConnectionBanner } from "./components/ConnectionBanner.tsx";
import { PresenceBanner } from "./components/PresenceBanner.tsx";
import { PlaybookSizeBanner } from "./components/PlaybookSizeBanner.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { StatusStrip } from "./components/StatusStrip.tsx";
import { useSuggestionEvents } from "./lib/useSuggestionEvents.ts";
// Lazy — loaded on first visit to that tab.
const CrewView       = lazy(() => import("./components/Crew.tsx").then((m) => ({ default: m.CrewView })));
const StatusView     = lazy(() => import("./components/Status.tsx").then((m) => ({ default: m.StatusView })));
const SessionsView   = lazy(() => import("./components/Sessions.tsx").then((m) => ({ default: m.SessionsView })));
const SchedulesView  = lazy(() => import("./components/Schedules.tsx").then((m) => ({ default: m.SchedulesView })));
const WebhookTriggersView = lazy(() => import("./components/WebhookTriggers.tsx").then((m) => ({ default: m.WebhookTriggersView })));
const UsageView      = lazy(() => import("./components/Usage.tsx").then((m) => ({ default: m.UsageView })));
const PromptView_    = lazy(() => import("./components/Prompt.tsx").then((m) => ({ default: m.PromptView_ })));
const SkillsView     = lazy(() => import("./components/Skills.tsx").then((m) => ({ default: m.SkillsView })));
const MemoryView     = lazy(() => import("./components/Memory.tsx").then((m) => ({ default: m.MemoryView })));
const VaultView      = lazy(() => import("./components/Vault.tsx").then((m) => ({ default: m.VaultView })));
const BackupView     = lazy(() => import("./components/Backup.tsx").then((m) => ({ default: m.BackupView })));
const ConnectorsView = lazy(() => import("./components/Connectors.tsx").then((m) => ({ default: m.ConnectorsView })));
const WebhookToolsView = lazy(() => import("./components/WebhookTools.tsx").then((m) => ({ default: m.WebhookToolsView })));
const UpdatesView    = lazy(() => import("./components/Updates.tsx").then((m) => ({ default: m.UpdatesView })));
const TasksView      = lazy(() => import("./components/Tasks.tsx").then((m) => ({ default: m.TasksView })));
const InboxView      = lazy(() => import("./components/Inbox.tsx").then((m) => ({ default: m.InboxView })));
const WorkersView    = lazy(() => import("./components/Workers.tsx").then((m) => ({ default: m.WorkersView })));
const LogsView       = lazy(() => import("./components/Logs.tsx").then((m) => ({ default: m.LogsView })));
const HeartbeatView_ = lazy(() => import("./components/Heartbeat.tsx").then((m) => ({ default: m.HeartbeatView_ })));
const SettingsView   = lazy(() => import("./components/Settings.tsx").then((m) => ({ default: m.SettingsView })));
const RemoteAccessView = lazy(() => import("./components/RemoteAccess.tsx").then((m) => ({ default: m.RemoteAccessView })));
const FeedbackView   = lazy(() => import("./components/Feedback.tsx").then((m) => ({ default: m.FeedbackView })));

/**
 * Apply white-label branding to the document chrome (title, favicon, accent).
 * `branding` is the *effective* branding from `/api/me`: env defaults unless the
 * licensed feature is unlocked, so this is a no-op for unlicensed installs.
 */
function applyBranding(branding: Branding | undefined, brandName: string): void {
  const title = branding?.panelTitle || brandName;
  if (title) document.title = title;
  if (branding?.faviconUrl) {
    let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = branding.faviconUrl;
  }
  if (branding?.accentColor) {
    document.documentElement.style.setProperty("--color-accent", branding.accentColor);
  }
}

/** Tab from the URL path (e.g. /status), falling back to health. */
function tabFromPath(): Tab | "settings" {
  const seg = location.pathname.replace(/^\/+/, "").split("/")[0];
  if (seg === "settings") return "settings";
  return isTab(seg) ? seg : "health";
}

export function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [tab, setTab] = useState<Tab | "settings">(tabFromPath);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [chatEnabled, setChatEnabled] = useState(true);
  const [terminalEnabled, setTerminalEnabled] = useState(false);
  const [brandName, setBrandName] = useState("MyHQ");
  const [logoUrl, setLogoUrl] = useState<string | undefined>(undefined);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateCount, setUpdateCount] = useState(0);
  const [inboxPending, setInboxPending] = useState(0);
  const { theme, toggle, set } = useTheme();
  const { t } = useI18n();

  // Accept a token passed in the URL (?token=…) — used by the installer's
  // one-click login link so the first visit authenticates without pasting the
  // secret. Validate it, persist it, then strip it from the URL so the token
  // isn't left in browser history or leaked by sharing the address bar.
  useEffect(() => {
    const url = new URL(location.href);
    const urlToken = url.searchParams.get("token");
    if (!urlToken) return;
    let cancelled = false;
    void (async () => {
      const ok = await checkToken(urlToken).catch(() => false);
      if (cancelled) return;
      if (ok) {
        setToken(urlToken);
        setAuthed(true);
      }
      url.searchParams.delete("token");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live pending-suggestions count for the Inbox nav badge: seed it once, then
  // let the shared /ws keep it current (the server pushes the full list on change).
  useEffect(() => {
    if (!authed) return;
    api
      .suggestions("pending")
      .then((r) => setInboxPending(r.suggestions.length))
      .catch(() => {});
  }, [authed]);
  useSuggestionEvents((list) =>
    setInboxPending(list.filter((s) => s.status === "pending").length),
  );

  // Switch tab and reflect it in the URL (so a refresh reloads the same view).
  const select = (t: Tab | "settings") => {
    setTab(t);
    setDrawer(false);
    if (location.pathname !== `/${t}`) history.pushState(null, "", `/${t}`);
  };

  // Jump to the Chat view with a specific agent pre-selected (used by the
  // "Web Chat" badges in Crew / Agents). The agent id rides along as a query
  // param; ChatView reads and then strips it on mount.
  const chatWith = (agentId: string) => {
    setTab("chat");
    setDrawer(false);
    history.pushState(null, "", `/chat?agent=${encodeURIComponent(agentId)}`);
  };

  // Jump to the Workers tab with a specific worker's editor opened (used by the
  // Chat profile card's "Edit agent" link). WorkersView reads the `worker`
  // query param on mount and expands that row's editor.
  const editWorker = (workerId: string) => {
    setTab("workers");
    setDrawer(false);
    history.pushState(null, "", `/workers?worker=${encodeURIComponent(workerId)}`);
  };

  // Learn which optional features are on (chat can be disabled via env).
  useEffect(() => {
    if (!authed) return;
    api.me().then((m) => {
      setChatEnabled(m.chatEnabled);
      setTerminalEnabled(m.terminalEnabled);
      if (m.brandName) setBrandName(m.brandName);
      setUpdateAvailable(m.updateAvailable);
      setUpdateCount(m.updateCount ?? 0);
      applyBranding(m.branding, m.brandName);
      setLogoUrl(m.branding?.logoUrl);
    }).catch(() => {});
  }, [authed]);

  // Keep the tab in sync with the URL on back/forward navigation.
  useEffect(() => {
    const onPop = () => setTab(tabFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Cmd+K / Ctrl+K opens the command palette.
  useEffect(() => {
    if (!authed) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [authed]);

  // Don't strand the user on the Command hub when both its sub-views are off.
  useEffect(() => {
    if (!chatEnabled && !terminalEnabled && (tab === "command" || isCommandChild(tab))) {
      select("health");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatEnabled, terminalEnabled, tab]);

  // Hidden easter egg: flipping the light/dark theme 9 times unlocks (and the
  // next flip leaves) the matrix theme.
  const flips = useRef(0);
  const onToggleTheme = () => {
    if (theme === "matrix") {
      flips.current = 0;
      set("dark");
      return;
    }
    flips.current += 1;
    if (flips.current >= 9) {
      flips.current = 0;
      set("matrix");
      return;
    }
    toggle();
  };

  const onAuthError = () => {
    clearToken();
    setAuthed(false);
  };

  if (!authed) return <Login onAuthed={() => setAuthed(true)} />;

  return (
    <div className="flex min-h-full">
      {/* Desktop / tablet sidebar — icon rail on md, full on lg. */}
      <aside className="sticky top-0 hidden h-dvh w-16 shrink-0 border-r border-line md:block lg:w-60">
        <Sidebar
          tab={tab}
          onSelect={select}
          theme={theme}
          onToggleTheme={onToggleTheme}
          onSignOut={onAuthError}
          chatEnabled={chatEnabled}
          updateAvailable={updateAvailable}
          updateCount={updateCount}
          inboxPending={inboxPending}
          brandName={brandName}
          logoUrl={logoUrl}
        />
      </aside>

      {/* Mobile "More" drawer — a grouped, searchable bottom sheet over the full
          set of destinations (replaces the old flat left-drawer). */}
      <MoreDrawer
        open={drawer}
        tab={tab}
        onSelect={select}
        onClose={() => setDrawer(false)}
        chatEnabled={chatEnabled}
        inboxPending={inboxPending}
        updateAvailable={updateAvailable}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface px-4 md:hidden">
          <button
            onClick={() => setDrawer(true)}
            aria-label={t("app_open_menu")}
            className="text-lg text-fg-muted"
          >
            ☰
          </button>
          {/* Mobile breadcrumb / back affordance: the brand returns to the
              dashboard, the trailing segment names the current view. */}
          <span className="mono flex-1 text-sm font-medium text-fg">
            <button
              onClick={() => select("health")}
              className="text-accent transition-opacity hover:opacity-80"
              aria-label={t("breadcrumb_home")}
            >
              %<span className="ml-1.5 text-fg">{brandName}</span>
            </button>
            {tab !== "health" && (
              <span className="ml-0.5 text-fg-dim">
                / {tab === "settings" ? t("nav_settings").toLowerCase() : t(tabLabel(tab as Tab) as TranslationKey).toLowerCase()}
              </span>
            )}
          </span>
          <button
            onClick={() => setPalette(true)}
            aria-label={t("cmd_open")}
            className="text-base text-fg-dim transition-colors hover:text-fg"
          >
            ⌕
          </button>
        </header>

        <ConnectionBanner />
        <PresenceBanner />
        <PlaybookSizeBanner onGotoPrompt={() => select("prompt")} />

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24 pt-6 sm:px-6 md:pb-6">
          {/* Desktop breadcrumb: Home → current view. Hidden on mobile (the top
              bar already shows it) and skipped for the dashboard itself and the
              full-height chat/terminal views (which own their vertical space). */}
          {tab !== "health" && tab !== "command" && !isCommandChild(tab) && (
            <Breadcrumb
              className="mb-4 hidden md:flex"
              items={[
                { label: t("breadcrumb_home"), onClick: () => select("health") },
                {
                  label:
                    tab === "settings"
                      ? t("nav_settings")
                      : t(tabLabel(tab as Tab) as TranslationKey),
                },
              ]}
            />
          )}
          {/* Eager tabs — on the critical path, no Suspense needed. */}
          {tab === "setup" && <SetupView onAuthError={onAuthError} onGoto={select} />}
          {(tab === "command" || isCommandChild(tab)) && (
            <CommandHub
              tab={tab}
              onSubTab={select}
              chatEnabled={chatEnabled}
              terminalEnabled={terminalEnabled}
              onAuthError={onAuthError}
              onEditAgent={editWorker}
            />
          )}
          {tab === "health" && <HealthView onGoto={select} />}
          {/* Lazy tabs — loaded on first visit. Suspense shows nothing while the
              chunk fetches (chunks are small, flash would be jarring). */}
          <Suspense>
            {tab === "crew" && (
              <CrewView onAuthError={onAuthError} onChat={chatEnabled ? chatWith : undefined} />
            )}
            {tab === "status" && <StatusView onAuthError={onAuthError} />}
            {tab === "updates" && (
              <UpdatesView
                onAuthError={onAuthError}
                onStatus={(available, count) => {
                  setUpdateAvailable(available);
                  setUpdateCount(count);
                }}
              />
            )}
            {tab === "workers" && (
              <WorkersView onAuthError={onAuthError} onChat={chatEnabled ? chatWith : undefined} />
            )}
            {tab === "inbox" && <InboxView onAuthError={onAuthError} />}
            {tab === "tasks" && <TasksView onAuthError={onAuthError} />}
            {tab === "skills" && <SkillsView onAuthError={onAuthError} />}
            {tab === "memory" && <MemoryView onAuthError={onAuthError} />}
            {tab === "vault" && <VaultView onAuthError={onAuthError} />}
            {tab === "backup" && <BackupView onAuthError={onAuthError} />}
            {tab === "connectors" && (
              <div className="space-y-4">
                <ConnectorsView onAuthError={onAuthError} onGoto={select} />
                <WebhookToolsView onAuthError={onAuthError} />
              </div>
            )}
            {tab === "prompt" && <PromptView_ onAuthError={onAuthError} />}
            {tab === "logs" && <LogsView onAuthError={onAuthError} />}
            {tab === "sessions" && <SessionsView onAuthError={onAuthError} />}
            {tab === "schedules" && <SchedulesView onAuthError={onAuthError} />}
            {tab === "webhooks" && <WebhookTriggersView onAuthError={onAuthError} />}
            {tab === "heartbeat" && <HeartbeatView_ onAuthError={onAuthError} />}
            {tab === "remote" && <RemoteAccessView onAuthError={onAuthError} />}
            {tab === "feedback" && <FeedbackView onAuthError={onAuthError} onGoto={select} />}
            {tab === "usage" && <UsageView onAuthError={onAuthError} />}
            {tab === "settings" && <SettingsView onAuthError={onAuthError} />}
          </Suspense>

          {tab !== "command" && !isCommandChild(tab) && (
          <footer className="mt-10">
            {/* A thin gradient rule above the footer gives it a deliberate
                edge without adding weight: it fades in from transparent to a
                faint accent at the centre and back, reading as a subtle brand
                motif rather than a hard divider. */}
            <div className="mx-auto h-px max-w-xs bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs text-fg-faint">
              <span>{t("app_footer_made_with")}</span>
              <span className="text-accent/40" aria-hidden>
                ◈
              </span>
              <a
                href="https://gyorgy.sh"
                target="_blank"
                rel="noreferrer"
                className="text-fg-dim hover:text-fg-muted"
              >
                gyorgy.sh
              </a>
              <span className="text-accent/40" aria-hidden>
                ◈
              </span>
              <a
                href="https://github.com/gyorgysh/myhq"
                target="_blank"
                rel="noreferrer"
                className="text-fg-dim hover:text-fg-muted"
              >
                GitHub
              </a>
            </div>
          </footer>
          )}
        </main>
      </div>

      {/* Mobile bottom nav — high-traffic tabs + a More button opening the drawer. */}
      <BottomNav
        tab={tab}
        onSelect={select}
        onOpenMenu={() => setDrawer(true)}
        inboxPending={inboxPending}
      />

      {/* Live "what's running" strip — pinned to the bottom whenever any
          autonomous run (Lead/worker or delegated kanban card) is in flight. */}
      <StatusStrip />

      {/* Global toast stack (success / error / info), shared across all views. */}
      <ToastViewport />

      {/* Cmd+K / Ctrl+K command palette — keyboard-first navigation. */}
      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        onSelect={(t) => { select(t); setPalette(false); }}
        chatEnabled={chatEnabled}
      />
    </div>
  );
}
