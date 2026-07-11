/**
 * TmuxViewer — live panel views onto persistent tmux-hosted claude instances
 * (Tmux mode, src/claude/tmuxInstance.ts).
 *
 * One refcounted node-pty child per agent runs `tmux attach-session` at the
 * instance's fixed 220x50 geometry; its output fans out ONLY to the panel
 * sockets subscribed to that agent (targeted sends, not a hub broadcast —
 * unlike the global host-shell terminal in ptyManager.ts). Killing the attach
 * pty detaches the viewer; the tmux session itself keeps running. Take-control
 * input authorization is enforced by the WS layer in panel/server.ts (per
 * socket, server-side); this module just moves bytes.
 *
 * node-pty is an optionalDependency — degrade to "viewer unavailable" when it
 * is missing, mirroring ptyManager's lazy-load trick.
 */

import { execFile } from "node:child_process";
import { log } from "../logger.js";
import { listInstances, onInstanceChange } from "../claude/tmuxInstance.js";

type IPty = import("node-pty").IPty;
type NodePtyModule = typeof import("node-pty");

let _ptyMod: NodePtyModule | null = null;
async function loadPty(): Promise<NodePtyModule | null> {
  if (_ptyMod) return _ptyMod;
  try {
    // Non-literal specifier so tsc doesn't try to resolve at compile time.
    const mod = await import(/* @vite-ignore */ "node-pty");
    _ptyMod = mod as NodePtyModule;
    return _ptyMod;
  } catch {
    return null;
  }
}

/** Minimal env for `tmux attach` — it needs no secrets, just a sane terminal. */
function attachEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { TERM: "xterm-256color" };
  for (const key of ["PATH", "HOME", "USER", "SHELL", "LANG"]) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  return env;
}

type SendFn = (msg: unknown) => void;

interface Viewer {
  pty: IPty | null;
  spawning: Promise<void> | null;
  subs: Map<string, SendFn>; // socketId → targeted send
}

const viewers = new Map<string, Viewer>(); // agentId → viewer

// Push live instance-state changes (busy/idle/stopped, RC URL) to whoever is
// watching that agent, so the panel badge updates without polling.
onInstanceChange((info) => {
  const v = viewers.get(info.agentId);
  if (!v) return;
  fanOut(v, {
    type: "agent-term",
    agentId: info.agentId,
    event: "state",
    state: info.state,
    rcUrl: info.rcUrl,
  });
});

function fanOut(v: Viewer, msg: unknown): void {
  for (const send of v.subs.values()) {
    try {
      send(msg);
    } catch {
      /* client gone; dropSocket will clean up */
    }
  }
}

function instanceFor(agentId: string) {
  return listInstances().find((i) => i.agentId === agentId);
}

/** Recent pane content (rendered text incl. scrollback) for the history seed. */
function captureHistory(sessionName: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "tmux",
      // `=name:` (not bare `=name`): pane-level commands reject a bare
      // exact-match session target on modern tmux ("can't find pane").
      ["capture-pane", "-p", "-t", `=${sessionName}:`, "-S", "-200"],
      { timeout: 5000 },
      (err, stdout) => resolve(err ? "" : stdout),
    );
  });
}

async function spawnAttach(agentId: string, sessionName: string, v: Viewer): Promise<void> {
  const ptyMod = await loadPty();
  if (!ptyMod) throw new Error("node-pty unavailable — live viewer disabled on this install");
  if (v.pty) return;
  const pty = ptyMod.spawn("tmux", ["attach-session", "-t", `=${sessionName}`], {
    name: "xterm-256color",
    cols: 220,
    rows: 50,
    cwd: process.env.HOME ?? "/",
    env: attachEnv(),
  });
  v.pty = pty;
  pty.onData((data) => fanOut(v, { type: "agent-term", agentId, event: "data", data }));
  pty.onExit(({ exitCode }) => {
    log.info("[tmux-viewer] attach exited", { agentId, exitCode });
    v.pty = null;
    fanOut(v, { type: "agent-term", agentId, event: "exit" });
  });
}

/**
 * Subscribe a panel socket to an agent's live terminal. The first subscriber
 * spawns the shared attach pty; every subscriber gets a history seed first.
 */
export async function subscribe(
  agentId: string,
  socketId: string,
  send: SendFn,
): Promise<{ ok: boolean; error?: string }> {
  const inst = instanceFor(agentId);
  if (!inst) return { ok: false, error: "no persistent instance for this agent" };
  if (inst.state === "stopped") return { ok: false, error: "instance is not running" };

  let v = viewers.get(agentId);
  if (!v) {
    v = { pty: null, spawning: null, subs: new Map() };
    viewers.set(agentId, v);
  }
  v.subs.set(socketId, send);

  try {
    send({
      type: "agent-term",
      agentId,
      event: "history",
      data: await captureHistory(inst.sessionName),
    });
  } catch {
    /* client gone already */
  }

  if (!v.pty) {
    v.spawning ??= spawnAttach(agentId, inst.sessionName, v).finally(() => {
      if (v) v.spawning = null;
    });
    try {
      await v.spawning;
    } catch (err) {
      unsubscribe(agentId, socketId);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: true };
}

export function unsubscribe(agentId: string, socketId: string): void {
  const v = viewers.get(agentId);
  if (!v) return;
  v.subs.delete(socketId);
  if (v.subs.size === 0) {
    try {
      v.pty?.kill();
    } catch {
      /* already gone */
    }
    viewers.delete(agentId);
  }
}

/** Remove a closed socket from every agent it was watching. */
export function dropSocket(socketId: string): void {
  for (const agentId of [...viewers.keys()]) unsubscribe(agentId, socketId);
}

/** Forward take-control keystrokes into the attached TUI. */
export function write(agentId: string, data: string): void {
  const inst = instanceFor(agentId);
  if (inst?.foreign) {
    log.warn("[tmux-viewer] input to foreign session refused", { agentId });
    return;
  }
  const v = viewers.get(agentId);
  if (!v?.pty) {
    log.debug("[tmux-viewer] input dropped — no attach pty", { agentId });
    return;
  }
  v.pty.write(data);
}
