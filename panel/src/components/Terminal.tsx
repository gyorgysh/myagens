import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { useTerminalSocket } from "../lib/useTerminalSocket.ts";
import { useI18n } from "../lib/useI18n.ts";
import { Callout } from "./ui.tsx";

// xterm types only — the module is loaded dynamically below.
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

interface TerminalStatus {
  available: boolean;
  reason?: "disabled" | "unsupported" | null;
  shell: string;
}

export function TerminalView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [ready, setReady] = useState(false);

  // Load terminal status from the server.
  useEffect(() => {
    api
      .terminalStatus()
      .then(setStatus)
      .catch((e) => {
        if (e?.name === "AuthError") onAuthError();
      });
  }, [onAuthError]);

  // Initialise xterm once we know node-pty is available and the container is mounted.
  useEffect(() => {
    if (!status?.available) return;
    if (!containerRef.current) return;

    let destroyed = false;

    void (async () => {
      // Dynamic import — bundle only loaded when this tab is visited. The
      // stylesheet is essential: it hides the off-screen helper textarea
      // (.xterm-helper-textarea) and positions the cursor; without it that
      // textarea renders as a visible second input.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/xterm/css/xterm.css"),
      ]);

      // Bail if the effect was torn down while the import was in flight
      // (StrictMode double-mount / HMR). Without this a second xterm canvas
      // gets opened into the same container — the classic "double cursor".
      if (destroyed || !containerRef.current) return;

      // Defensively clear any leftover xterm DOM from a previous mount whose
      // async init landed after cleanup, so we never stack two terminals.
      containerRef.current.replaceChildren();

      // Map CSS custom properties to xterm's theme. We read the *resolved*
      // value (getComputedStyle resolves nested var() chains to a concrete
      // color), falling back to a safe value if the token is missing — xterm's
      // color parser needs concrete colors, not empty strings. Background and
      // foreground must come from the same active theme or text goes invisible
      // (e.g. light-theme black text on a hardcoded dark fallback bg).
      const style = getComputedStyle(document.documentElement);
      const cssVar = (name: string, fallback: string) =>
        style.getPropertyValue(name).trim() || fallback;

      // Detect whether the active theme is light, so we can pick readable
      // ANSI black/white shades (dark/matrix: dim-white text; light: dark text).
      // `data-theme` on <html> is the source of truth; default (unset) is dark.
      const isLight = document.documentElement.getAttribute("data-theme") === "light";
      const bg = cssVar("--color-page", isLight ? "#f8f9fb" : "#0a0a0b");
      const fg = cssVar("--color-fg", isLight ? "#18181b" : "#e2e2e6");
      const accent = cssVar("--color-accent", "#7a7ee0");

      const term = new Terminal({
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.4,
        theme: {
          background: bg,
          foreground: fg,
          cursor: accent,
          cursorAccent: bg,
          selectionBackground: accent + "44",
          black: isLight ? "#3a3a42" : "#1a1a1e",
          brightBlack: isLight ? "#71717a" : "#3a3a42",
          white: isLight ? "#3f3f46" : "#c8c8d0",
          brightWhite: isLight ? "#18181b" : "#e2e2e6",
        },
        allowProposedApi: false,
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      fit.fit();

      termRef.current = term;
      fitRef.current = fit;

      // Ask the server to spawn the shell at the correct initial size.
      const { cols, rows } = term;
      void api.terminalSpawn(cols, rows).catch(() => {});

      setReady(true);
    })();

    return () => {
      destroyed = true;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      setReady(false);
    };
  }, [status?.available]);

  // Resize handler — refit xterm and notify the server.
  useEffect(() => {
    if (!ready) return;
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      fitRef.current?.fit();
      const term = termRef.current;
      if (term) void api.terminalResize(term.cols, term.rows).catch(() => {});
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ready]);

  // Wire keystrokes from xterm to the PTY via WebSocket. The hook stores these
  // handlers in a ref internally, so a fresh object each render is fine.
  const { send } = useTerminalSocket({
    onData: (data: string) => termRef.current?.write(data),
    onExit: (_code: number) => {
      termRef.current?.write("\r\n\x1b[31m[shell exited — press any key to restart]\x1b[0m\r\n");
    },
  });

  useEffect(() => {
    if (!ready) return;
    const term = termRef.current;
    if (!term) return;
    const disp = term.onData((data) => send(data));
    return () => disp.dispose();
  }, [ready, send]);

  // --- Render ---

  if (status === null) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-fg-dim">
        {t("terminal_connecting")}
      </div>
    );
  }

  if (!status.available) {
    const disabled = status.reason === "disabled";
    return (
      <div className="space-y-4">
        <Callout
          title={disabled ? t("terminal_disabled_title") : t("terminal_unavailable_title")}
        >
          {disabled ? t("terminal_disabled_body") : t("terminal_unavailable_body")}
        </Callout>
        <LockedTerminal
          shell={status.shell}
          label={disabled ? t("terminal_disabled_overlay") : t("terminal_unavailable_overlay")}
        />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col overflow-hidden rounded-xl border border-line bg-base">
      {/* Header bar */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="mono text-xs text-fg-dim">{status.shell}</span>
        <span className="ml-auto text-xs text-fg-faint">{t("terminal_shared_hint")}</span>
      </div>
      {/* xterm canvas fills the rest */}
      <div
        ref={containerRef}
        className="min-h-0 flex-1 p-1"
        style={{ contain: "strict" }}
      />
    </div>
  );
}

/** A blurred, non-interactive mock terminal shown when the real terminal is
 *  disabled/unavailable — communicates "this is where the shell would be" with
 *  a lock badge over fake prompt lines, instead of leaving the page empty. */
function LockedTerminal({ shell, label }: { shell: string; label: string }) {
  const { t } = useI18n();
  // Static, harmless sample lines purely for visual texture behind the blur.
  const lines = [
    "$ git status",
    "On branch main",
    "nothing to commit, working tree clean",
    "$ npm run build",
    "✓ built in 1.24s",
    "$ ls -la",
    "drwxr-xr-x  12 user  staff   384 .",
    "$ ▍",
  ];
  return (
    <div className="relative h-[calc(100vh-16rem)] min-h-64 overflow-hidden rounded-xl border border-line bg-base">
      {/* Header bar mirrors the live terminal's */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="mono text-xs text-fg-faint">{shell}</span>
        <span className="ml-auto text-xs text-fg-faint">🔒</span>
      </div>
      {/* Blurred fake terminal body */}
      <div
        aria-hidden
        className="mono select-none space-y-1 p-3 text-xs text-fg-dim blur-[3px]"
      >
        {lines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
      {/* Lock overlay */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-base/40 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface text-2xl">
          🔒
        </div>
        <div className="text-sm font-medium text-fg">{label}</div>
        <div className="max-w-xs text-xs text-fg-faint">{t("terminal_locked_hint")}</div>
      </div>
    </div>
  );
}
