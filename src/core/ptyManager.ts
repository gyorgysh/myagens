/**
 * PtyManager — a singleton that owns one persistent PTY shell session.
 * Multiplexed to all panel WebSocket clients via the broadcast callback.
 *
 * node-pty is an optionalDependency. If it failed to build (missing
 * build-tools on the host), this module degrades gracefully: `available`
 * is false and all methods are no-ops.
 */

import { statSync } from "fs";
import { log as logger } from "../logger.js";
import { config } from "../config.js";

/** Maximum scrollback kept in memory (bytes). Replayed only within a session. */
const SCROLLBACK_CAP = 10_000;

/**
 * Build the environment handed to the spawned shell.
 *
 * Default (PANEL_TERMINAL_INHERIT_ENV=false): a minimal sanitized env so the
 * shell can't simply `env`/`echo $ANTHROPIC_API_KEY` the bot's secrets back out.
 * Only a small allow-list of non-sensitive vars is forwarded. When inherit is
 * explicitly enabled, fall back to the full process env (legacy behaviour).
 */
function buildShellEnv(): NodeJS.ProcessEnv {
  if (config.PANEL_TERMINAL_INHERIT_ENV) {
    return { ...process.env, TERM: "xterm-256color" };
  }
  const allow = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TZ",
    "TMPDIR",
    "PWD",
  ];
  const env: NodeJS.ProcessEnv = { TERM: "xterm-256color" };
  for (const key of allow) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  return env;
}

/** Default shell search order. */
const SHELL_CANDIDATES = [
  process.env.SHELL,
  "/bin/bash",
  "/usr/bin/bash",
  "/bin/zsh",
  "/usr/bin/zsh",
  "/bin/sh",
].filter(Boolean) as string[];

function findShell(): string {
  for (const s of SHELL_CANDIDATES) {
    try { statSync(s); return s; } catch { /* try next */ }
  }
  return "/bin/sh";
}

type BroadcastFn = (msg: unknown) => void;
type IPty = import("node-pty").IPty;
type NodePtyModule = typeof import("node-pty");

// Attempt to load node-pty. Stored as a module-level variable resolved once.
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

export class PtyManager {
  private broadcast: BroadcastFn = () => {};
  private pty: IPty | null = null;
  private scrollback = "";
  private _available: boolean | null = null;

  start(broadcast: BroadcastFn): void {
    this.broadcast = broadcast;
    // Feature is opt-in: a panel-token holder gets arbitrary host execution.
    if (!config.PANEL_TERMINAL_ENABLED) {
      this._available = false;
      logger.info("[pty] terminal disabled (PANEL_TERMINAL_ENABLED=false)");
      return;
    }
    // Loud warning when the panel is reachable beyond loopback: a terminal
    // behind an exposed panel is a remote shell.
    if (config.PANEL_HOST !== "127.0.0.1" && config.PANEL_HOST !== "localhost") {
      logger.warn(
        `[pty] terminal ENABLED while panel binds ${config.PANEL_HOST} — this is a remote shell; ensure the panel is firewalled / behind a private network`,
      );
    }
    // Probe availability in background.
    void loadPty().then((m) => {
      this._available = m !== null;
      if (!m) logger.warn("[pty] node-pty not available — terminal tab disabled");
    });
  }

  get enabled(): boolean {
    return config.PANEL_TERMINAL_ENABLED;
  }

  get available(): boolean {
    return config.PANEL_TERMINAL_ENABLED && (this._available ?? false);
  }

  get availableResolved(): boolean | null {
    if (!config.PANEL_TERMINAL_ENABLED) return false;
    return this._available;
  }

  /** Current scrollback for a newly-connected client. */
  getHistory(): string {
    return this.scrollback;
  }

  get currentShell(): string {
    return findShell();
  }

  /** Lazily spawn (or re-use) the PTY process. */
  private async spawnIfNeeded(cols = 120, rows = 30): Promise<void> {
    if (!config.PANEL_TERMINAL_ENABLED) return; // hard gate
    if (this.pty) return;
    const ptyMod = await loadPty();
    if (!ptyMod) return;

    const shell = findShell();
    logger.info(`[pty] spawning ${shell} (${cols}x${rows})`);

    try {
      this.pty = ptyMod.spawn(shell, [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd: process.env.HOME ?? "/",
        env: buildShellEnv(),
      });
    } catch (e) {
      // Native spawn can fail even when the module loads (e.g. a non-executable
      // spawn-helper in the prebuild). Degrade gracefully → terminal stays disabled.
      this._available = false;
      logger.warn(`[pty] spawn failed — terminal disabled: ${(e as Error).message}`);
      return;
    }

    this.pty.onData((data) => {
      this.scrollback += data;
      if (this.scrollback.length > SCROLLBACK_CAP) {
        this.scrollback = this.scrollback.slice(this.scrollback.length - SCROLLBACK_CAP);
      }
      this.broadcast({ type: "terminal", event: "data", data });
    });

    this.pty.onExit(({ exitCode }) => {
      logger.info(`[pty] shell exited (${exitCode}) — will respawn on next input`);
      this.pty = null;
      this.scrollback = "";
      this.broadcast({ type: "terminal", event: "exit", exitCode });
    });
  }

  /** Initialise the shell (called when the first client opens the terminal tab). */
  spawn(cols = 120, rows = 30): void {
    void this.spawnIfNeeded(cols, rows);
  }

  write(data: string): void {
    if (this.pty) {
      this.pty.write(data);
    } else {
      void this.spawnIfNeeded().then(() => this.pty?.write(data));
    }
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  kill(): void {
    try { this.pty?.kill(); } catch { /* ignore */ }
    this.pty = null;
  }
}

export const ptyManager = new PtyManager();
