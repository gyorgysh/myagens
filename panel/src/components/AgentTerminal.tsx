import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { useAgentTermSocket } from "../lib/useAgentTermSocket.ts";
import { useI18n } from "../lib/useI18n.ts";
import { resolveXtermTheme } from "../lib/themeColors.ts";

// xterm types only — the module is loaded dynamically below.
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

/** Server-side pane geometry (fixed in tmuxInstance.ts — viewers never refit). */
const PANE_COLS = 220;
const EMBED_FONT_PX = 12;

/**
 * Live read-only view onto an agent's persistent tmux-hosted claude instance
 * (Tmux mode), with an explicit "Take control" toggle before any keystroke is
 * forwarded — so watching can never accidentally type into the agent's TUI.
 * The instance renders at a fixed 220x50 server-side; the viewer scrolls
 * rather than refitting, so multiple watchers can't fight over geometry.
 *
 * Two presentations: the embedded card (Settings) with an expand button, and
 * a "cinema" overlay — a large centered modal, not true fullscreen — whose
 * font is sized so all 220 columns fit its width. With `cinemaOnly` the
 * component IS the overlay (mounted from a Terminal button elsewhere) and
 * closing it calls `onClose` so the parent unmounts it.
 */
export function AgentTerminal({
  agentId,
  cinemaOnly = false,
  onClose,
}: {
  agentId: string;
  /** Render only the cinema overlay (no embedded card); close → onClose(). */
  cinemaOnly?: boolean;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [ready, setReady] = useState(false);
  const [control, setControlState] = useState(false);
  const [cinema, setCinema] = useState(cinemaOnly);
  const [instState, setInstState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controlRef = useRef(false);
  const cinemaRef = useRef(cinemaOnly);

  useEffect(() => {
    if (!containerRef.current) return;
    let destroyed = false;

    void (async () => {
      // Dynamic import — the xterm bundle is only loaded when a viewer opens.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/xterm/css/xterm.css"),
      ]);
      if (destroyed || !containerRef.current) return;
      containerRef.current.replaceChildren();

      const term = new Terminal({
        cursorBlink: false,
        disableStdin: true, // read-only until take-control flips it
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: EMBED_FONT_PX,
        lineHeight: 1.3,
        cols: PANE_COLS,
        rows: 50,
        theme: resolveXtermTheme(),
        allowProposedApi: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);

      termRef.current = term;
      fitRef.current = fit;
      setReady(true);
    })();

    return () => {
      destroyed = true;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      setReady(false);
    };
  }, [agentId]);

  const { sendInput, setControl } = useAgentTermSocket(agentId, {
    onData: (data) => termRef.current?.write(data),
    onExit: () => {
      termRef.current?.write(`\r\n\x1b[33m[${t("agentterm_detached")}]\x1b[0m\r\n`);
    },
    onState: (state) => setInstState(state),
    onError: (err) => setError(err),
  });

  // Forward keystrokes only while take-control is on (belt on top of the
  // server-side gate, which is the real authority).
  useEffect(() => {
    if (!ready) return;
    const term = termRef.current;
    if (!term) return;
    const disp = term.onData((data) => {
      if (controlRef.current) sendInput(data);
    });
    return () => disp.dispose();
  }, [ready, sendInput]);

  // Size the font to the available width: the cinema panel fits all 220
  // columns to its width; embedded stays at 12px and scrolls horizontally.
  const applyFont = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    if (!cinemaRef.current) {
      term.options.fontSize = EMBED_FONT_PX;
      return;
    }
    const width = panelRef.current?.clientWidth ?? window.innerWidth;
    // Monospace glyphs render at ≈0.62em wide; small slack for scrollbars.
    const px = Math.floor((width - 28) / (PANE_COLS * 0.62));
    term.options.fontSize = Math.max(9, Math.min(20, px));
  }, []);

  const closeCinema = useCallback(() => {
    if (cinemaOnly) {
      onClose?.();
      return;
    }
    cinemaRef.current = false;
    setCinema(false);
  }, [cinemaOnly, onClose]);

  const toggleCinema = useCallback(() => {
    if (cinema) {
      closeCinema();
    } else {
      cinemaRef.current = true;
      setCinema(true);
    }
  }, [cinema, closeCinema]);

  useEffect(() => {
    applyFont();
    if (!cinema) return;
    const onResize = () => applyFont();
    window.addEventListener("resize", onResize);
    // Esc closes the overlay — but only while NOT controlling: with control
    // on, Esc belongs to the TUI (it's Claude's own interrupt key).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !controlRef.current) closeCinema();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
    };
  }, [cinema, applyFont, ready, closeCinema]);

  const toggleControl = () => {
    const next = !control;
    setControlState(next);
    controlRef.current = next;
    setControl(next);
    const term = termRef.current;
    if (term) term.options.disableStdin = !next;
  };

  // Stable two-level structure in both modes so React reuses the DOM nodes and
  // the xterm instance survives entering/leaving cinema view.
  return (
    <div
      className={
        cinema
          ? "fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-8"
          : "contents"
      }
      onMouseDown={(e) => {
        if (cinema && e.target === e.currentTarget) closeCinema();
      }}
    >
      <div
        ref={panelRef}
        className={
          cinema
            ? "flex h-[85vh] w-full max-w-[1400px] flex-col overflow-hidden rounded-xl border border-line bg-base shadow-2xl"
            : "overflow-hidden rounded-xl border border-line bg-base"
        }
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
          <span className="mono text-xs text-fg-dim">{agentId}</span>
          {instState && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                instState === "busy"
                  ? "bg-warn/15 text-warn-fg"
                  : instState === "stopped"
                    ? "bg-line text-fg-faint"
                    : "bg-ok/15 text-ok-fg"
              }`}
            >
              {instState}
            </span>
          )}
          <span className="ml-auto text-xs text-fg-faint">
            {control ? t("agentterm_control_on") : t("agentterm_readonly")}
          </span>
          <button
            onClick={toggleControl}
            className={`rounded-lg border px-2.5 py-1 text-xs ${
              control
                ? "border-warn/50 bg-warn/10 text-warn-fg"
                : "border-line text-fg-dim hover:text-fg"
            }`}
          >
            {control ? t("agentterm_release_control") : t("agentterm_take_control")}
          </button>
          <button
            onClick={toggleCinema}
            title={cinema ? t("agentterm_exit_fullscreen") : t("agentterm_fullscreen")}
            className="rounded-lg border border-line p-1.5 text-fg-dim hover:text-fg"
          >
            {cinema ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
        {error ? (
          <div className="p-3 text-xs text-warn-fg">{error}</div>
        ) : (
          <div className={cinema ? "flex-1 overflow-auto p-2" : "max-h-96 overflow-auto p-1"}>
            <div ref={containerRef} />
          </div>
        )}
      </div>
    </div>
  );
}
