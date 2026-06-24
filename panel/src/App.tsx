import { useEffect, useRef, useState } from "react";
import { api, clearToken, getToken } from "./api.ts";
import { useTheme } from "./lib/useTheme.ts";
import { Login } from "./components/Login.tsx";
import { Sidebar, tabLabel, isTab, type Tab } from "./components/Sidebar.tsx";
import { ChatView } from "./components/Chat.tsx";
import { HealthView } from "./components/Health.tsx";
import { StatusView } from "./components/Status.tsx";
import { SessionsView } from "./components/Sessions.tsx";
import { SchedulesView } from "./components/Schedules.tsx";
import { UsageView } from "./components/Usage.tsx";
import { PromptView_ } from "./components/Prompt.tsx";
import { SkillsView } from "./components/Skills.tsx";
import { MemoryView } from "./components/Memory.tsx";
import { VaultView } from "./components/Vault.tsx";
import { ConnectorsView } from "./components/Connectors.tsx";
import { TasksView } from "./components/Tasks.tsx";
import { WorkersView } from "./components/Workers.tsx";
import { LogsView } from "./components/Logs.tsx";
import { HeartbeatView_ } from "./components/Heartbeat.tsx";

/** Tab from the URL path (e.g. /status), falling back to health. */
function tabFromPath(): Tab {
  const seg = location.pathname.replace(/^\/+/, "").split("/")[0];
  return isTab(seg) ? seg : "health";
}

export function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [tab, setTab] = useState<Tab>(tabFromPath);
  const [drawer, setDrawer] = useState(false);
  const [chatEnabled, setChatEnabled] = useState(true);
  const { theme, toggle, set } = useTheme();

  // Switch tab and reflect it in the URL (so a refresh reloads the same view).
  const select = (t: Tab) => {
    setTab(t);
    setDrawer(false);
    if (location.pathname !== `/${t}`) history.pushState(null, "", `/${t}`);
  };

  // Learn which optional features are on (chat can be disabled via env).
  useEffect(() => {
    if (!authed) return;
    api.me().then((m) => setChatEnabled(m.chatEnabled)).catch(() => {});
  }, [authed]);

  // Keep the tab in sync with the URL on back/forward navigation.
  useEffect(() => {
    const onPop = () => setTab(tabFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Don't strand the user on a hidden tab.
  useEffect(() => {
    if (!chatEnabled && tab === "chat") select("health");
  }, [chatEnabled, tab]);

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
      <aside className="sticky top-0 hidden h-screen w-16 shrink-0 border-r border-line md:block lg:w-60">
        <Sidebar
          tab={tab}
          onSelect={select}
          theme={theme}
          onToggleTheme={onToggleTheme}
          onSignOut={onAuthError}
          chatEnabled={chatEnabled}
        />
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setDrawer(false)}
          />
          <aside className="absolute left-0 top-0 h-full w-64 border-r border-line shadow-xl">
            <Sidebar
              tab={tab}
              onSelect={select}
              theme={theme}
              onToggleTheme={onToggleTheme}
              onSignOut={onAuthError}
              chatEnabled={chatEnabled}
              expanded
            />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface px-4 md:hidden">
          <button
            onClick={() => setDrawer(true)}
            aria-label="Open menu"
            className="text-lg text-fg-muted"
          >
            ☰
          </button>
          <span className="mono text-sm font-medium text-fg">
            <span className="text-accent">%</span>
            <span className="ml-1.5">cct panel</span>
            <span className="ml-0.5 text-fg-dim">/ {tabLabel(tab).toLowerCase()}</span>
          </span>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
          {tab === "chat" && <ChatView onAuthError={onAuthError} />}
          {tab === "health" && <HealthView />}
          {tab === "status" && <StatusView onAuthError={onAuthError} />}
          {tab === "workers" && <WorkersView onAuthError={onAuthError} />}
          {tab === "tasks" && <TasksView onAuthError={onAuthError} />}
          {tab === "skills" && <SkillsView onAuthError={onAuthError} />}
          {tab === "memory" && <MemoryView onAuthError={onAuthError} />}
          {tab === "vault" && <VaultView onAuthError={onAuthError} />}
          {tab === "connectors" && <ConnectorsView onAuthError={onAuthError} />}
          {tab === "prompt" && <PromptView_ onAuthError={onAuthError} />}
          {tab === "logs" && <LogsView onAuthError={onAuthError} />}
          {tab === "sessions" && <SessionsView onAuthError={onAuthError} />}
          {tab === "schedules" && <SchedulesView onAuthError={onAuthError} />}
          {tab === "heartbeat" && <HeartbeatView_ onAuthError={onAuthError} />}
          {tab === "usage" && <UsageView onAuthError={onAuthError} />}

          {tab !== "chat" && (
          <footer className="mt-10 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs text-fg-faint">
            <span>Made open source with Claude &amp; Coffee ☕</span>
            <span className="text-fg-faint/50">·</span>
            <a
              href="https://gyorgy.sh"
              target="_blank"
              rel="noreferrer"
              className="text-fg-dim hover:text-fg-muted"
            >
              gyorgy.sh
            </a>
            <span className="text-fg-faint/50">·</span>
            <a
              href="https://github.com/gyorgysh/claude-code-telegram"
              target="_blank"
              rel="noreferrer"
              className="text-fg-dim hover:text-fg-muted"
            >
              GitHub
            </a>
          </footer>
          )}
        </main>
      </div>
    </div>
  );
}
