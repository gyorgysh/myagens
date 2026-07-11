import { useEffect, useRef, useState } from "react";
import { useAgentTermSocket } from "../lib/useAgentTermSocket.ts";
import { useI18n } from "../lib/useI18n.ts";
import { resolveXtermTheme } from "../lib/themeColors.ts";

// xterm types only — the module is loaded dynamically below.
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

/**
 * Live read-only view onto an agent's persistent tmux-hosted claude instance
 * (Tmux mode), with an explicit "Take control" toggle before any keystroke is
 * forwarded — so watching can never accidentally type into the agent's TUI.
 * The instance renders at a fixed 220x50 server-side; the viewer scrolls
 * rather than refitting, so multiple watchers can't fight over geometry.
 */
export function AgentTerminal({ agentId }: { agentId: string }) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [ready, setReady] = useState(false);
  const [control, setControlState] = useState(false);
  const [instState, setInstState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controlRef = useRef(false);

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
        fontSize: 12,
        lineHeight: 1.3,
        cols: 220,
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

  const toggleControl = () => {
    const next = !control;
    setControlState(next);
    controlRef.current = next;
    setControl(next);
    const term = termRef.current;
    if (term) term.options.disableStdin = !next;
  };

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-base">
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
      </div>
      {error ? (
        <div className="p-3 text-xs text-warn-fg">{error}</div>
      ) : (
        <div className="max-h-96 overflow-auto p-1">
          <div ref={containerRef} />
        </div>
      )}
    </div>
  );
}
