import { execFile, spawn as spawnChild } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { log } from "../logger.js";
import { dataPath, loadJson, saveJson } from "../core/jsonStore.js";
import type { RunOptions, RunResult, TmuxRunSpec, TokenUsage } from "./runner.js";
import {
  TranscriptTail,
  findSessionTranscript,
  transcriptExists,
  type TranscriptUsage,
} from "./transcriptTail.js";

/**
 * Persistent tmux-hosted Claude instances ("Tmux mode").
 *
 * The plain `claude` CLI only activates Remote Control (the live session you can
 * watch/steer from claude.ai/code or the mobile app) in its INTERACTIVE TUI, not
 * in headless `-p`/stream-json mode (still true as of CLI v2.1.207; headless RC
 * is open upstream FRs anthropics/claude-code#30447/#29116). Beyond RC, spawning
 * a fresh CLI per turn means the human-facing conversation has no live, durable
 * home. So for opted-in agents we host the real TUI inside a *named tmux
 * session* — `tmux new-session -d` gives it a terminal even though this process
 * has none — feed each prompt with paste-buffer/send-keys, and capture each
 * reply by tailing the CLI's OWN session transcript (the append-only JSONL
 * under ~/.claude/projects/<cwd-slug>/, see transcriptTail.ts): structured
 * text/tool_use/usage per message, streamed live, nothing injected into the
 * conversation. The old `/export <file>` capture survives only as a last-resort
 * fallback for when the transcript can't be located. tmux (not a raw node-pty)
 * is the point: the session survives bot restarts (we re-adopt it on boot), and
 * the user can watch or take over with `tmux attach -t <name>` from any
 * terminal, from the panel viewer, or — with RC on — from the Claude app.
 *
 * Tradeoffs vs the SDK backend (by design, documented for callers):
 *  - Runs in bypassPermissions only (the TUI can't route approvals to Telegram),
 *    so tmux mode is gated on `full` autonomy by the resolvers.
 *  - Our in-process MCP servers are NOT attached (an external CLI can't consume
 *    SDK `createSdkMcpServer` objects); `opts.mcpServers`/`canUseTool` and the
 *    system-prompt append options are ignored — the TUI builds its own context
 *    from the cwd's CLAUDE.md like any interactive session.
 * Intended for Atlas and Leads under full autonomy; everything unattended
 * (delegated cards, council votes, maintenance one-shots) stays on the SDK.
 */

const STORE_FILE = "tmux-instances.json";
const SESSION_PREFIX = "myagens-";
const TMUX_LOG_DIR = dataPath("tmux");

/** How a spawn attempt may seed conversation history (the resume ladder).
 *  Deliberately NO `--continue` rung: it resumes whatever session in the cwd
 *  is newest, and SDK one-shots (reflection passes, delegated runs) write to
 *  the same project dir — `--continue` once resurrected a reflection pass's
 *  conversation into the user's TUI. Only ids we bound ourselves are trusted. */
type ResumeRung = "local-resume" | "rc-resume" | "fresh";

interface StoredInstance {
  agentName: string;
  sessionName: string;
  cwd: string;
  /** RC flag the live (or last) claude process was spawned with. */
  remoteControl: boolean;
  rcUrl?: string;
  /** claude.ai session id scraped from the RC URL, for `--resume` on respawn. */
  rcSessionId?: string;
  /** Local CLI session id (transcript filename) — the reliable resume token. */
  localSessionId?: string;
  /** The session-transcript JSONL replies are captured from. */
  transcriptPath?: string;
  model?: string;
  turnCount: number;
  createdAt: number;
}

interface TmuxStore {
  version: 1;
  instances: Record<string, StoredInstance>;
}

export interface TmuxInstanceInfo {
  agentId: string;
  agentName: string;
  sessionName: string;
  cwd: string;
  remoteControl: boolean;
  rcUrl?: string;
  state: "starting" | "idle" | "busy" | "stopped";
  turnCount: number;
  startedAt?: number;
  /** True when the session was re-adopted from a previous process. */
  adopted?: boolean;
  /** A live `myagens-*` session we didn't create: listed, peekable, never driven. */
  foreign?: boolean;
}

interface Instance {
  agentId: string;
  st: StoredInstance;
  state: "starting" | "idle" | "busy" | "stopped";
  /** Serializes turns on one instance (one TUI can't run two prompts at once). */
  chain: Promise<unknown>;
  adopted: boolean;
  startedAt?: number;
  /** One-time notices surfaced through the next turn's onText. */
  pendingNotices: string[];
  /** Lazily-reconciled setting drift already notified (cleared on restart). */
  noticedRcDrift?: boolean;
  noticedCwdDrift?: boolean;
  /** True until the stored transcript binding has been (re)verified this
   *  process — a respawn can fork the conversation into a new session file. */
  transcriptStale: boolean;
}

const store: TmuxStore = loadJson<TmuxStore>(STORE_FILE, { version: 1, instances: {} });
const instances = new Map<string, Instance>();
/** Live myagens-* tmux sessions with no store entry (read-only). */
let foreignSessions: string[] = [];

const listeners: Array<(info: TmuxInstanceInfo) => void> = [];

/** Subscribe to instance state changes (panel WS broadcast hook). */
export function onInstanceChange(cb: (info: TmuxInstanceInfo) => void): void {
  listeners.push(cb);
}

function emitChange(inst: Instance): void {
  const info = toInfo(inst);
  for (const cb of listeners) {
    try {
      cb(info);
    } catch {
      /* listener errors must not break turns */
    }
  }
}

function persist(): void {
  saveJson(STORE_FILE, store);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Project-dir-style slug so session names / log folders read per agent. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

/* ------------------------------------------------------------------ tmux IO */

/** Run a tmux command via execFile (no shell), resolving stdout. */
function tmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

/** Like tmux(), but swallow failures (best-effort cosmetics/cleanup). */
async function tmuxQuiet(args: string[]): Promise<string | null> {
  try {
    return await tmux(args);
  } catch {
    return null;
  }
}

/** Run a tmux command feeding `input` on stdin (for load-buffer -). */
function tmuxStdin(args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnChild("tmux", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `tmux exited ${code}`));
    });
    child.stdin.end(input);
  });
}

let availableCache: boolean | undefined;

/** Probe for the tmux binary once (cached). Called at boot by adoptInstances(). */
export async function tmuxAvailable(): Promise<boolean> {
  if (availableCache === undefined) {
    availableCache = (await tmuxQuiet(["-V"])) !== null;
    if (!availableCache) {
      log.warn("tmux is not installed — Tmux-mode agents will fall back to SDK turns", {
        hint: "brew install tmux / apt install tmux",
      });
    }
  }
  return availableCache;
}

/** Cached probe result for synchronous gates (false until the boot probe ran). */
export function tmuxAvailableSync(): boolean {
  return availableCache === true;
}

/** Exact-match session target (has-session / kill-session). */
function sessT(sessionName: string): string {
  return `=${sessionName}`;
}

/** Exact-match pane/option target. Pane-level commands (send-keys,
 *  paste-buffer, capture-pane) and set-option reject a bare `=name` on
 *  modern tmux ("can't find pane") — they need the trailing colon
 *  (exact session, default window/pane). Verified against tmux 3.7b. */
function paneT(sessionName: string): string {
  return `=${sessionName}:`;
}

async function hasSession(sessionName: string): Promise<boolean> {
  return (await tmuxQuiet(["has-session", "-t", sessT(sessionName)])) !== null;
}

/** Rendered pane text (tmux strips ANSI for us). `lines` > 0 adds scrollback. */
async function capture(sessionName: string, lines = 0): Promise<string> {
  const args = ["capture-pane", "-p", "-t", paneT(sessionName)];
  if (lines > 0) args.push("-S", `-${lines}`);
  return (await tmuxQuiet(args)) ?? "";
}

async function listLiveSessions(): Promise<string[]> {
  const out = await tmuxQuiet(["list-sessions", "-F", "#{session_name}"]);
  if (!out) return []; // no server running counts as "no sessions"
  return out.split("\n").map((s) => s.trim()).filter((s) => s.startsWith(SESSION_PREFIX));
}

/** POSIX single-quote so agent names/paths survive tmux's `sh -c` invocation. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/* -------------------------------------------------------------- lifecycle */

function sessionNameFor(agentId: string, agentName: string): string {
  const base = SESSION_PREFIX + slug(agentName);
  const taken = Object.entries(store.instances).some(
    ([id, st]) => id !== agentId && st.sessionName === base,
  );
  return taken ? `${base}-${slug(agentId).slice(0, 8)}` : base;
}

export interface TmuxSpawnSpec extends TmuxRunSpec {
  cwd: string;
  model?: string;
  /** Provider env overrides (ANTHROPIC_BASE_URL/…); applied at spawn only. */
  env?: Record<string, string | undefined>;
}

function buildClaudeCommand(spec: TmuxSpawnSpec, rung: ResumeRung, st: StoredInstance): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (v !== undefined && /^[A-Z_][A-Z0-9_]*$/.test(k)) parts.push(`${k}=${shq(v)}`);
  }
  parts.push("claude", "--permission-mode", "bypassPermissions");
  if (spec.model) parts.push("--model", shq(spec.model));
  if (spec.remoteControl) parts.push("--remote-control", shq(spec.agentName));
  if (rung === "local-resume" && st.localSessionId) parts.push("--resume", shq(st.localSessionId));
  if (rung === "rc-resume" && st.rcSessionId) parts.push("--resume", shq(st.rcSessionId));
  return parts.join(" ");
}

interface ReadyResult {
  ok: boolean;
  reason?: string;
  rcUrl?: string;
}

/**
 * Wait for a freshly spawned TUI to settle at its idle input box, auto-answering
 * the two startup dialogs on the way. Readiness gates on the screen having fully
 * SETTLED, not just on content appearing: the bypass-permissions warning dialog
 * can render *after* the RC URL prints, and submitting a prompt before answering
 * it leaks the dialog's "2" auto-answer into the conversation. Answering a
 * dialog repaints the screen, so a sustained quiet window reliably lands us at
 * the idle input box with every dialog handled.
 */
async function waitReady(sessionName: string, expectRcUrl: boolean): Promise<ReadyResult> {
  const start = Date.now();
  let trusted = false;
  let accepted = false;
  let rcUrl: string | undefined;
  let lastScreenHash = "";
  let lastChange = Date.now();

  while (Date.now() - start < 45_000) {
    await sleep(300);
    if (!(await hasSession(sessionName))) return { ok: false, reason: "process exited" };
    const screen = await capture(sessionName);
    const hash = createHash("sha256").update(screen).digest("hex");
    if (hash !== lastScreenHash) {
      lastScreenHash = hash;
      lastChange = Date.now();
    }
    const flat = screen.replace(/\s+/g, " ");
    // A resume flag the CLI rejects usually kills the process (caught above),
    // but catch an on-screen refusal too so the ladder can fall through.
    if (/no conversation found/i.test(flat)) return { ok: false, reason: "resume rejected" };
    if (!rcUrl) {
      const m = /claude\.ai\/code\/session_[\w-]+/.exec(screen);
      if (m) rcUrl = "https://" + m[0];
    }
    if (!trusted && /trust\s*this\s*folder/i.test(flat)) {
      trusted = true;
      await sleep(400);
      await tmuxQuiet(["send-keys", "-t", paneT(sessionName), "Enter"]);
      continue;
    }
    // Match the bypass WARNING DIALOG specifically ("...accept all
    // responsibility..."), not the persistent "bypass permissions on" status
    // line — matching the latter would type a spurious "2" into the input box.
    if (!accepted && /accept\s*all\s*responsibility/i.test(flat)) {
      accepted = true;
      await sleep(500);
      await tmuxQuiet(["send-keys", "-t", paneT(sessionName), "-l", "--", "2"]);
      await sleep(250);
      await tmuxQuiet(["send-keys", "-t", paneT(sessionName), "Enter"]);
      continue;
    }
    const settled =
      screen.trim().length > 0 &&
      Date.now() - lastChange > 2500 &&
      (!expectRcUrl || Boolean(rcUrl));
    if (settled) return { ok: true, rcUrl };
  }
  return { ok: false, reason: "did not settle within 45s", rcUrl };
}

/**
 * Spawn the TUI in a detached tmux session, walking the resume ladder:
 *  1. a persisted local CLI session id     → `--resume <uuid>` (the transcript
 *     filename — the CLI's real resume token, most reliable)
 *  2. RC on + a persisted RC session id    → `--remote-control --resume <id>`
 *  3. fresh spawn (always works)
 * Rungs 1–2 exist so a respawn re-attaches the previous conversation / claude.ai
 * session instead of spamming a new one; each rung is verified by the readiness
 * probe and failure falls through to the next.
 */
async function spawnLadder(inst: Instance, spec: TmuxSpawnSpec): Promise<void> {
  const st = inst.st;
  const rungs: ResumeRung[] = [];
  if (st.localSessionId) rungs.push("local-resume");
  if (spec.remoteControl && st.rcSessionId) rungs.push("rc-resume");
  rungs.push("fresh");

  inst.state = "starting";
  emitChange(inst);

  for (const rung of rungs) {
    await tmuxQuiet(["kill-session", "-t", sessT(st.sessionName)]);
    const cmd = buildClaudeCommand(spec, rung, st);
    try {
      await tmux([
        "new-session", "-d", "-s", st.sessionName, "-c", spec.cwd, "-x", "220", "-y", "50", cmd,
      ]);
    } catch (err) {
      log.error("[tmux] new-session failed", { agent: spec.agentName, error: String(err) });
      continue;
    }
    // Cosmetic: no status bar in viewers; size follows the most recent client.
    await tmuxQuiet(["set-option", "-t", paneT(st.sessionName), "status", "off"]);
    await tmuxQuiet(["set-option", "-t", paneT(st.sessionName), "window-size", "latest"]);

    const ready = await waitReady(st.sessionName, spec.remoteControl);
    if (ready.ok) {
      st.cwd = spec.cwd;
      st.model = spec.model;
      st.remoteControl = spec.remoteControl;
      if (ready.rcUrl) {
        st.rcUrl = ready.rcUrl;
        const m = /session_[\w-]+/.exec(ready.rcUrl);
        if (m) st.rcSessionId = m[0];
      } else if (!spec.remoteControl) {
        st.rcUrl = undefined;
      }
      inst.state = "idle";
      inst.adopted = false;
      inst.startedAt = Date.now();
      inst.noticedRcDrift = false;
      inst.noticedCwdDrift = false;
      // Resuming forks the conversation into a NEW session file — rebind the
      // transcript on the next turn. A fresh spawn also invalidates the old
      // session id (resuming it later would resurrect an abandoned thread).
      inst.transcriptStale = true;
      if (rung === "fresh") {
        st.localSessionId = undefined;
        st.transcriptPath = undefined;
      }
      // Surface where the conversation lives ONCE per actual (re)spawn — not
      // on every process boot / reply. /status carries the same info on demand.
      inst.pendingNotices.push(
        [
          `🖥 Persistent session \`${st.sessionName}\` ${rung === "fresh" ? "started" : "resumed"} — watch or take over with \`tmux attach -t ${st.sessionName}\`.`,
          st.rcUrl ? `🔗 Mirrored live at ${st.rcUrl}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      if (rung === "fresh" && rungs.length > 1) {
        inst.pendingNotices.push(
          "⚠️ The previous persistent conversation could not be resumed — started a fresh one.",
        );
      }
      log.info("[tmux] instance ready", {
        agent: spec.agentName,
        session: st.sessionName,
        rung,
        rc: spec.remoteControl,
        url: st.rcUrl,
      });
      persist();
      emitChange(inst);
      pruneTmuxLogs(); // bound disk each time an instance starts (cheap)
      return;
    }
    log.warn("[tmux] spawn rung failed", { agent: spec.agentName, rung, reason: ready.reason });
  }
  inst.state = "stopped";
  emitChange(inst);
  throw new Error("persistent claude instance failed to start (see logs)");
}

function getOrCreateInstance(spec: TmuxSpawnSpec): Instance {
  let inst = instances.get(spec.agentId);
  if (!inst) {
    let st = store.instances[spec.agentId];
    if (!st) {
      st = {
        agentName: spec.agentName,
        sessionName: sessionNameFor(spec.agentId, spec.agentName),
        cwd: spec.cwd,
        remoteControl: spec.remoteControl,
        turnCount: 0,
        createdAt: Date.now(),
      };
      store.instances[spec.agentId] = st;
      persist();
    }
    inst = {
      agentId: spec.agentId,
      st,
      state: "stopped",
      chain: Promise.resolve(),
      adopted: false,
      pendingNotices: [],
      transcriptStale: true,
    };
    instances.set(spec.agentId, inst);
  }
  return inst;
}

/**
 * Make sure a live, ready instance exists for this spec. A live instance is
 * reused as-is; RC/cwd changes are reconciled *lazily* — surfaced as a one-time
 * notice, applied only by an explicit restart (never a silent kill mid-
 * conversation). A dead/missing session respawns via the resume ladder.
 */
export async function ensureInstance(spec: TmuxSpawnSpec): Promise<TmuxInstanceInfo> {
  if (!(await tmuxAvailable())) throw new Error("tmux is not installed");
  const inst = getOrCreateInstance(spec);

  if (await hasSession(inst.st.sessionName)) {
    if (inst.state === "stopped") inst.state = "idle"; // adopted or externally revived
    if (inst.st.remoteControl !== spec.remoteControl && !inst.noticedRcDrift) {
      inst.noticedRcDrift = true;
      inst.pendingNotices.push(
        `ℹ️ Remote Control is now ${spec.remoteControl ? "ON" : "OFF"} in settings — restart the persistent instance to apply it.`,
      );
    } else if (inst.st.remoteControl === spec.remoteControl) {
      inst.noticedRcDrift = false;
    }
    if (inst.st.cwd !== spec.cwd && !inst.noticedCwdDrift) {
      inst.noticedCwdDrift = true;
      inst.pendingNotices.push(
        `ℹ️ This persistent instance runs in \`${inst.st.cwd}\` — the new directory applies when the instance restarts.`,
      );
    } else if (inst.st.cwd === spec.cwd) {
      inst.noticedCwdDrift = false;
    }
    return toInfo(inst);
  }

  await spawnLadder(inst, spec);
  return toInfo(inst);
}

/** Every known instance (running or stopped) plus foreign myagens-* sessions. */
export function listInstances(): TmuxInstanceInfo[] {
  const out: TmuxInstanceInfo[] = [];
  const seen = new Set<string>();
  for (const inst of instances.values()) {
    out.push(toInfo(inst));
    seen.add(inst.agentId);
  }
  for (const [agentId, st] of Object.entries(store.instances)) {
    if (!seen.has(agentId)) {
      out.push({
        agentId,
        agentName: st.agentName,
        sessionName: st.sessionName,
        cwd: st.cwd,
        remoteControl: st.remoteControl,
        rcUrl: st.rcUrl,
        state: "stopped",
        turnCount: st.turnCount,
      });
    }
  }
  const known = new Set(Object.values(store.instances).map((s) => s.sessionName));
  for (const name of foreignSessions) {
    if (!known.has(name)) {
      out.push({
        agentId: name,
        agentName: name,
        sessionName: name,
        cwd: "",
        remoteControl: false,
        state: "idle",
        turnCount: 0,
        foreign: true,
      });
    }
  }
  return out;
}

function toInfo(inst: Instance): TmuxInstanceInfo {
  return {
    agentId: inst.agentId,
    agentName: inst.st.agentName,
    sessionName: inst.st.sessionName,
    cwd: inst.st.cwd,
    remoteControl: inst.st.remoteControl,
    rcUrl: inst.st.rcUrl,
    state: inst.state,
    turnCount: inst.st.turnCount,
    startedAt: inst.startedAt,
    adopted: inst.adopted || undefined,
  };
}

/** Resolve an agent id (or a raw/foreign session name) to a tmux session name. */
function resolveSessionName(agentId: string): string | null {
  const inst = instances.get(agentId) ?? null;
  if (inst) return inst.st.sessionName;
  const st = store.instances[agentId];
  if (st) return st.sessionName;
  if (foreignSessions.includes(agentId)) return agentId;
  return null;
}

/** Recent rendered output of an instance's pane (read-only, safe for anyone). */
export async function peekInstance(agentId: string, lines = 40): Promise<string> {
  const name = resolveSessionName(agentId);
  if (!name) throw new Error(`no persistent instance for "${agentId}"`);
  if (!(await hasSession(name))) throw new Error(`instance "${agentId}" is not running`);
  const text = await capture(name, Math.max(0, Math.min(lines, 200)));
  // Trim trailing blank screen rows so a peek isn't 50 lines of padding.
  return text.replace(/\s+$/, "");
}

/** Inject raw text into an instance's input box (steer tool / take-control). */
export async function sendToInstance(agentId: string, text: string, submit = true): Promise<void> {
  const inst = instances.get(agentId);
  const name = inst?.st.sessionName ?? (store.instances[agentId]?.sessionName || null);
  if (!name) throw new Error(`no persistent instance for "${agentId}"`);
  if (!(await hasSession(name))) throw new Error(`instance "${agentId}" is not running`);
  await pasteText(name, text);
  if (submit) {
    await sleep(150);
    await tmux(["send-keys", "-t", paneT(name), "Enter"]);
  }
}

/**
 * Drop an instance's conversation: kill the session and clear every resume
 * token, so the next turn spawns a genuinely fresh conversation instead of
 * walking the resume ladder back into the old one. Wired to the user's
 * explicit "new conversation" actions (/new etc.) — with a persistent TUI,
 * resetting only the SDK resume token would leave the old thread alive.
 */
export async function resetInstanceConversation(agentId: string): Promise<void> {
  const inst = instances.get(agentId);
  const st = inst?.st ?? store.instances[agentId];
  if (!st) return;
  await tmuxQuiet(["kill-session", "-t", sessT(st.sessionName)]);
  st.localSessionId = undefined;
  st.transcriptPath = undefined;
  st.rcSessionId = undefined;
  st.rcUrl = undefined;
  if (inst) {
    inst.state = "stopped";
    inst.transcriptStale = true;
    emitChange(inst);
  }
  persist();
  log.info("[tmux] conversation reset", { agentId, session: st.sessionName });
}

/** Stop an instance (tmux kill-session). The store entry survives for resume. */
export async function stopInstance(agentId: string): Promise<void> {
  const inst = instances.get(agentId);
  const name = resolveSessionName(agentId);
  if (!name) throw new Error(`no persistent instance for "${agentId}"`);
  if (foreignSessions.includes(name) && !store.instances[agentId]) {
    throw new Error("refusing to stop a tmux session this bot does not manage");
  }
  await tmuxQuiet(["kill-session", "-t", sessT(name)]);
  if (inst) {
    inst.state = "stopped";
    emitChange(inst);
  }
  log.info("[tmux] instance stopped", { agentId, session: name });
}

/**
 * Kill and respawn an instance (the only path that applies a pending RC/cwd
 * change). `remoteControl` overrides the stored flag when given.
 */
export async function restartInstance(
  agentId: string,
  opts: { remoteControl?: boolean } = {},
): Promise<TmuxInstanceInfo> {
  const inst = instances.get(agentId);
  const st = inst?.st ?? store.instances[agentId];
  if (!st) throw new Error(`no persistent instance for "${agentId}"`);
  const spec: TmuxSpawnSpec = {
    agentId,
    agentName: st.agentName,
    remoteControl: opts.remoteControl ?? st.remoteControl,
    cwd: st.cwd,
    model: st.model,
    // Provider env overrides are not persisted (they can carry secrets); a
    // restart spawns without them — the next SDK-resolved turn re-supplies them
    // only via a full respawn, which is acceptable for this edge case.
  };
  const target = getOrCreateInstance(spec);
  await tmuxQuiet(["kill-session", "-t", sessT(st.sessionName)]);
  target.state = "stopped";
  await spawnLadder(target, spec);
  return toInfo(target);
}

/**
 * Boot-time reconciliation: probe tmux, then re-adopt any store entry whose
 * session is still alive (that's the whole point of tmux hosting — the
 * conversation outlives the bot process). Live `myagens-*` sessions with no
 * store entry are recorded as foreign: listed and peekable, never driven or
 * killed. Called once from app startup; a missing tmux binary makes this a
 * warning + no-op.
 */
export async function adoptInstances(): Promise<void> {
  if (!(await tmuxAvailable())) return;
  const live = await listLiveSessions();
  const known = new Set<string>();
  for (const [agentId, st] of Object.entries(store.instances)) {
    known.add(st.sessionName);
    if (!live.includes(st.sessionName)) continue;
    const inst = getOrCreateInstance({
      agentId,
      agentName: st.agentName,
      remoteControl: st.remoteControl,
      cwd: st.cwd,
      model: st.model,
    });
    inst.adopted = true;
    inst.startedAt = Date.now();
    // The claude process itself survived, so its transcript binding is still
    // the live conversation — no need to re-discover it on the next turn.
    if (transcriptExists(st.transcriptPath)) inst.transcriptStale = false;
    const screen = await capture(st.sessionName);
    inst.state = /esc\s*to\s*interrupt/i.test(screen.replace(/\s+/g, " ")) ? "busy" : "idle";
    const m = /claude\.ai\/code\/session_[\w-]+/.exec(screen);
    if (m) {
      st.rcUrl = "https://" + m[0];
      const id = /session_[\w-]+/.exec(st.rcUrl);
      if (id) st.rcSessionId = id[0];
    }
    log.info("[tmux] adopted running instance", {
      agentId,
      session: st.sessionName,
      state: inst.state,
    });
    emitChange(inst);
  }
  foreignSessions = live.filter((n) => !known.has(n));
  if (foreignSessions.length) {
    log.info("[tmux] found unmanaged myagens-* sessions (read-only)", {
      sessions: foreignSessions,
    });
  }
  persist();
}

/* ------------------------------------------------------------------- turns */

/** Paste text into the TUI input box without submitting (bracketed paste). */
async function pasteText(sessionName: string, text: string): Promise<void> {
  const buf = `myagens-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  try {
    await tmuxStdin(["load-buffer", "-b", buf, "-"], text);
    // -p = bracketed paste, so the TUI inserts embedded newlines instead of
    // submitting on each one; -d deletes the buffer after pasting.
    await tmux(["paste-buffer", "-d", "-p", "-b", buf, "-t", paneT(sessionName)]);
  } catch (err) {
    // Fallback (tmux < 2.4 or a paste hiccup): flatten newlines and type it.
    log.warn("[tmux] paste-buffer failed, falling back to send-keys", { error: String(err) });
    await tmuxQuiet(["delete-buffer", "-b", buf]);
    const oneLine = text.replace(/\r?\n/g, " ").trim();
    await tmux(["send-keys", "-t", paneT(sessionName), "-l", "--", oneLine]);
  }
}

/**
 * Wait for the turn submitted at `submittedAt` to finish. "Finished" means the
 * busy marker ("esc to interrupt", shown only while a turn runs) was seen AFTER
 * submit and has since disappeared, with the rendered screen stable for
 * `quietMs` — the stability check tells a real completion from the model's
 * silent thinking pauses (the spinner keeps repainting while it thinks). A
 * fallback covers turns so trivial the busy marker never rendered.
 * `onTick` runs every iteration (transcript tailing) — errors are swallowed so
 * a capture hiccup can never kill completion detection.
 */
async function waitForTurn(
  sessionName: string,
  submittedAt: number,
  quietMs: number,
  maxMs: number,
  signal: AbortSignal,
  onTick?: () => void,
): Promise<"done" | "aborted" | "timeout" | "died"> {
  let lastBusy = 0;
  let lastHash = "";
  let lastChange = Date.now();
  while (Date.now() - submittedAt < maxMs) {
    if (signal.aborted) return "aborted";
    await sleep(500);
    if (!(await hasSession(sessionName))) return "died";
    try {
      onTick?.();
    } catch {
      /* capture must not break the wait */
    }
    const screen = await capture(sessionName);
    const hash = createHash("sha256").update(screen).digest("hex");
    if (hash !== lastHash) {
      lastHash = hash;
      lastChange = Date.now();
    }
    if (/esc\s*to\s*interrupt/i.test(screen.replace(/\s+/g, " ").slice(-2000))) {
      lastBusy = Date.now();
    }
    const now = Date.now();
    const started = lastBusy > submittedAt;
    if (started && now - lastBusy > quietMs && now - lastChange > quietMs) return "done";
    if (!started && now - submittedAt > 8000 && now - lastChange > 4000) return "done";
  }
  return "timeout";
}

/**
 * Take the assistant reply that follows the LAST real user prompt in an export.
 * Export lines: "❯ <prompt>" (user), "⏺ <text>" (assistant), "✻/✳/✽ …" (status).
 * Slash-command echoes ("❯ /export …") are skipped so we anchor on a real turn.
 */
export function extractLatestReply(exportText: string): string | null {
  const lines = exportText.split("\n");
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].replace(/\s+/g, " ").trim();
    if (l.startsWith("❯")) {
      const body = l.replace(/^❯\s*/, "");
      if (body.startsWith("/")) continue;
      idx = i;
      break;
    }
  }
  if (idx === -1) return null;
  const out: string[] = [];
  let inReply = false;
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith("❯")) break;
    if (l.startsWith("✻") || l.startsWith("✳") || l.startsWith("✽")) continue;
    if (l.startsWith("⏺")) {
      inReply = true;
      out.push(l.replace(/^⏺\s*/, ""));
      continue;
    }
    if (inReply) out.push(lines[i].replace(/^\s{0,2}/, ""));
  }
  const text = out.join("\n").trim();
  return text || null;
}

/** Per-turn cap, kept under the stall watchdog so it can never fire first. */
function turnCapMs(): number {
  const cap = config.TMUX_TURN_TIMEOUT_MS;
  const stall = config.TURN_STALL_TIMEOUT_MS;
  if (stall > 0) return Math.max(60_000, Math.min(cap, stall - 60_000));
  return cap;
}

/**
 * Answer a startup dialog the TUI may be parked on (trust-folder / bypass
 * warning) before a prompt is fed. waitReady only guards our own spawns — an
 * ADOPTED session (bot restarted while the TUI sat at a dialog) can still be
 * stuck on one, and pasting a prompt into a dialog corrupts the answer.
 */
async function clearStartupDialogs(sessionName: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const flat = (await capture(sessionName)).replace(/\s+/g, " ");
    if (/trust\s*this\s*folder/i.test(flat)) {
      await tmuxQuiet(["send-keys", "-t", paneT(sessionName), "Enter"]);
      await sleep(700);
      continue;
    }
    if (/accept\s*all\s*responsibility/i.test(flat)) {
      await tmuxQuiet(["send-keys", "-t", paneT(sessionName), "-l", "--", "2"]);
      await sleep(250);
      await tmuxQuiet(["send-keys", "-t", paneT(sessionName), "Enter"]);
      await sleep(700);
      continue;
    }
    return;
  }
}

/** Run one turn through an agent's persistent instance (claude-tmux backend). */
export async function runTurnOnInstance(spec: TmuxRunSpec, opts: RunOptions): Promise<RunResult> {
  const spawnSpec: TmuxSpawnSpec = {
    ...spec,
    cwd: opts.cwd,
    model: opts.model,
    env: opts.env,
  };
  let inst: Instance;
  try {
    await ensureInstance(spawnSpec);
    inst = instances.get(spec.agentId)!;
  } catch (err) {
    log.error("[tmux] failed to start instance", { agent: spec.agentName, error: String(err) });
    return {
      isError: true,
      text: `Persistent instance could not start: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Serialize turns on this instance — one TUI can't run two prompts at once.
  const run = inst.chain.then(() => doTurn(inst, opts));
  inst.chain = run.catch(() => {});
  return run;
}

async function doTurn(inst: Instance, opts: RunOptions): Promise<RunResult> {
  if (opts.abortController.signal.aborted) return { isError: true, text: "aborted" };
  const st = inst.st;
  const name = st.sessionName;

  inst.state = "busy";
  emitChange(inst);
  try {
    const turn = ++st.turnCount;
    persist();

    for (const notice of inst.pendingNotices.splice(0)) opts.onText(notice + "\n\n");

    // Bind the CLI's session transcript — the structured reply channel. A
    // verified binding tails from its end; a stale one (fresh process or a
    // respawn, which can fork a new session file) is re-discovered after
    // submit by matching the prompt we just pasted.
    let tail: TranscriptTail | null = null;
    if (!inst.transcriptStale && transcriptExists(st.transcriptPath)) {
      tail = new TranscriptTail(st.transcriptPath, "end");
    }

    // An adopted session can be parked on a startup dialog — answer it before
    // typing anything, or the prompt would be pasted into the dialog.
    await clearStartupDialogs(name);

    // Feed the prompt. C-u clears any residue left in the input line first, so
    // a prior unsubmitted command (a human half-typed into the TUI) can't
    // concatenate with this prompt.
    await tmux(["send-keys", "-t", paneT(name), "C-u"]);
    await sleep(150);
    await pasteText(name, opts.prompt);
    await sleep(150);
    const submittedAt = Date.now();
    await tmux(["send-keys", "-t", paneT(name), "Enter"]);

    // Live capture off the transcript: stream text, surface tool calls, and
    // fold token usage as lines land — the same callback fan-out the SDK
    // backend does, just sourced from the TUI's own JSONL.
    const seenLines = new Set<string>();
    const usageByMsg = new Map<string, TranscriptUsage>();
    const textParts: string[] = [];
    const toolCalls: Array<{ name: string; input: unknown }> = [];
    let lastDiscovery = 0;

    const drain = (): void => {
      if (!tail) return;
      for (const e of tail.poll()) {
        if (e.type !== "assistant" || e.isSidechain) continue;
        if (!e.timestamp || Date.parse(e.timestamp) < submittedAt - 2000) continue;
        if (e.uuid) {
          if (seenLines.has(e.uuid)) continue;
          seenLines.add(e.uuid);
        }
        const msg = e.message;
        if (msg?.id && msg.usage && msg.model !== "<synthetic>") usageByMsg.set(msg.id, msg.usage);
        const blocks = Array.isArray(msg?.content) ? msg.content : [];
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            opts.onText((textParts.length ? "\n\n" : "") + block.text);
            textParts.push(block.text);
          } else if (block.type === "tool_use" && block.name) {
            toolCalls.push({ name: block.name, input: block.input });
            opts.onToolUse(block.name, block.input);
          }
        }
      }
    };

    const onTick = (): void => {
      if (!tail && Date.now() - lastDiscovery >= 2000) {
        lastDiscovery = Date.now();
        const found = findSessionTranscript(st.cwd, submittedAt, opts.prompt);
        if (found) {
          st.transcriptPath = found.path;
          st.localSessionId = found.sessionId;
          inst.transcriptStale = false;
          persist();
          tail = new TranscriptTail(found.path, "recent");
          log.info("[tmux] bound session transcript", {
            agent: st.agentName,
            sessionId: found.sessionId,
          });
        }
      }
      drain();
    };

    const outcome = await waitForTurn(
      name,
      submittedAt,
      2500,
      turnCapMs(),
      opts.abortController.signal,
      onTick,
    );
    if (outcome === "aborted") {
      // Esc is the TUI's own interrupt — stop generation, keep the instance.
      await tmuxQuiet(["send-keys", "-t", paneT(name), "Escape"]);
      return { isError: true, text: "aborted" };
    }
    if (outcome === "died") {
      inst.state = "stopped";
      emitChange(inst);
      return {
        isError: true,
        text: "The persistent claude instance exited mid-turn. It will be respawned on the next message.",
      };
    }
    if (outcome === "timeout") {
      log.warn("[tmux] turn hit its time cap", { agent: st.agentName, capMs: turnCapMs() });
      // Fall through — return whatever was captured by this point.
    }

    if (!tail) {
      // Transcript never located (unexpected CLI layout?) — legacy capture.
      log.warn("[tmux] transcript never found — falling back to /export capture", {
        agent: st.agentName,
        turn,
      });
      return await captureViaExport(inst, opts, turn);
    }

    // Transcript writes can trail the rendered screen by a beat.
    await sleep(800);
    drain();

    const reply = textParts.join("\n\n").trim();
    const tokens = sumUsage(usageByMsg);
    if (!reply) {
      return {
        isError: false,
        text: "(the persistent session produced no text reply)",
        tokens,
        toolCalls,
      };
    }
    return { isError: false, text: reply, tokens, toolCalls };
  } finally {
    if (inst.state === "busy") {
      inst.state = "idle";
      emitChange(inst);
    }
  }
}

/** Fold per-API-call usage (deduped by message id upstream) into turn totals. */
function sumUsage(usageByMsg: Map<string, TranscriptUsage>): TokenUsage | undefined {
  if (!usageByMsg.size) return undefined;
  const t: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const u of usageByMsg.values()) {
    t.inputTokens += u.input_tokens ?? 0;
    t.outputTokens += u.output_tokens ?? 0;
    t.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    t.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
  }
  return t;
}

/**
 * Legacy capture: type `/export <path>` into the TUI and parse the export.
 * Only reached when the session transcript could not be located — the export
 * pollutes the conversation with a slash command, so the transcript channel
 * is always preferred.
 */
async function captureViaExport(inst: Instance, opts: RunOptions, turn: number): Promise<RunResult> {
  const st = inst.st;
  const name = st.sessionName;
  const logDir = join(TMUX_LOG_DIR, slug(st.agentName));
  mkdirSync(logDir, { recursive: true });
  const exportPath = join(logDir, `turn-${turn}-${Date.now()}.txt`);

  // Typing a path opens the TUI's path-autocomplete popup, which eats the
  // first Enter (selecting a suggestion instead of submitting) — so clear the
  // line, type the command, then submit with a deliberate second Enter after
  // the popup settles. An extra Enter on an empty prompt is a harmless no-op.
  await tmux(["send-keys", "-t", paneT(name), "C-u"]);
  await sleep(150);
  await tmux(["send-keys", "-t", paneT(name), "-l", "--", `/export ${exportPath}`]);
  await sleep(500);
  await tmux(["send-keys", "-t", paneT(name), "Enter"]);
  await sleep(400);
  await tmux(["send-keys", "-t", paneT(name), "Enter"]);

  let file: string | undefined;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    file = [exportPath, exportPath + ".txt", exportPath + ".md"].find((f) => existsSync(f));
    if (file) break;
  }
  if (!file) {
    log.warn("[tmux] export never appeared", { agent: st.agentName, turn });
    return {
      isError: true,
      text: `Turn ran in the persistent session, but its transcript could not be captured — view it with \`tmux attach -t ${name}\`.`,
    };
  }

  const reply = extractLatestReply(readFileSync(file, "utf8"));
  if (!reply) return { isError: false, text: "(the persistent session produced no text reply)" };
  opts.onText(reply);
  return { isError: false, text: reply };
}

/** Prune stale export logs older than `maxAgeMs` (default 72h) to bound disk. */
export function pruneTmuxLogs(maxAgeMs = 72 * 3600 * 1000): void {
  if (!existsSync(TMUX_LOG_DIR)) return;
  const cutoff = Date.now() - maxAgeMs;
  for (const agent of readdirSync(TMUX_LOG_DIR)) {
    const dir = join(TMUX_LOG_DIR, agent);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const m = /turn-\d+-(\d+)\./.exec(f);
      if (m && Number(m[1]) < cutoff) {
        try {
          unlinkSync(join(dir, f));
        } catch {
          /* ignore */
        }
      }
    }
  }
}
