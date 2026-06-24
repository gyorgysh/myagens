import { useState } from "react";
import { clearToken, getToken } from "./api.ts";
import { useTheme } from "./lib/useTheme.ts";
import { Login } from "./components/Login.tsx";
import { HealthView } from "./components/Health.tsx";
import { SessionsView } from "./components/Sessions.tsx";
import { SchedulesView } from "./components/Schedules.tsx";
import { UsageView } from "./components/Usage.tsx";

type Tab = "health" | "sessions" | "schedules" | "usage";

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "health", label: "System", icon: "▦" },
  { id: "sessions", label: "Sessions", icon: "◇" },
  { id: "schedules", label: "Schedules", icon: "◷" },
  { id: "usage", label: "Usage", icon: "↗" },
];

export function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [tab, setTab] = useState<Tab>("health");
  const { theme, toggle } = useTheme();

  const onAuthError = () => {
    clearToken();
    setAuthed(false);
  };

  if (!authed) return <Login onAuthed={() => setAuthed(true)} />;

  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col px-4 py-5">
      <header className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-fg">Claude Code · Control</h1>
          <p className="text-xs text-fg-faint">embedded management panel</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggle}
            aria-label="Toggle theme"
            title={theme === "dark" ? "Switch to light" : "Switch to dark"}
            className="rounded-lg border border-line px-2.5 py-1.5 text-sm text-fg-muted hover:bg-surface-2"
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button
            onClick={onAuthError}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted hover:bg-surface-2"
          >
            Sign out
          </button>
        </div>
      </header>

      <nav className="mb-5 flex gap-1 rounded-xl border border-line bg-surface p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
              tab === t.id
                ? "bg-surface-2 text-fg"
                : "text-fg-dim hover:text-fg-muted"
            }`}
          >
            <span className="text-fg-faint">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>

      <main className="flex-1">
        {tab === "health" && <HealthView />}
        {tab === "sessions" && <SessionsView onAuthError={onAuthError} />}
        {tab === "schedules" && <SchedulesView onAuthError={onAuthError} />}
        {tab === "usage" && <UsageView onAuthError={onAuthError} />}
      </main>

      <footer className="mt-8 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs text-fg-faint">
        <span>Made with Claude &amp; Coffee ☕</span>
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
    </div>
  );
}
