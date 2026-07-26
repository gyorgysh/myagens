import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repoRoot } from "../config.js";
import { dataPath } from "../core/jsonStore.js";
import { log } from "../logger.js";

/**
 * Wire `cursor-agent` up as a MyAgens agent by writing a hook and an MCP server
 * into the session's own `.cursor/` directory.
 *
 * That location is not a choice. Cursor loads both files only from the PRIMARY
 * workspace directory, which is the directory we run the turn in; a MyAgens-owned
 * dir passed as an extra workspace root is ignored, and making our dir primary
 * would break every relative path the model uses. So the config lands in the
 * user's project, and everything below exists to make that safe:
 *
 * 1. **Merge, never clobber.** A pre-existing `hooks.json` / `mcp.json` is read
 *    first, our entries are added under our own keys, and the original text is
 *    restored byte for byte afterwards.
 * 2. **Restore in a finally**, never only on the happy path.
 * 3. **Survive a crash.** What was displaced is recorded in a marker under the
 *    data dir before anything is written, and `restoreCursorConfigs()` replays
 *    those markers at boot. Finding MyAgens hooks still wired into a project
 *    after a kill -9 is the outcome this prevents.
 * 4. **Refcount per directory.** Two agents can run cursor in one project at
 *    once; the last one out restores, not the first.
 * 5. `~/.cursor/` (the user's global, additive scope) is never touched.
 *
 * The files hold no secrets. The hook needs none: hooks inherit the CLI's
 * environment, so the per-turn bridge url and token reach it that way. The MCP
 * server does not — cursor spawns stdio MCP children WITHOUT its own
 * environment (measured; codex behaves the same way), so its coordinates have
 * to be named in `mcp.json`, which lives in the user's project. What goes in
 * there is therefore only the path of a 0600 handoff file under our data dir;
 * the file itself carries the url and token.
 */

/** Crash markers: one per project directory we have config installed in. */
const MARKER_DIR = dataPath("cursor-config");

/** Per-turn bridge credential files, kept out of the user's project. */
const BRIDGE_DIR = join(MARKER_DIR, "bridge");

const HOOK_SCRIPT = join(repoRoot, "scripts", "cli-bridge", "hook.mjs");
const MCP_BRIDGE_SCRIPT = join(repoRoot, "scripts", "cli-bridge", "mcp-bridge.mjs");

/** Our key in the project's `mcp.json`; also what a merge replaces. */
const SERVER_NAME = "myagens";

/**
 * Hook timeout. Must outlast an approval prompt (APPROVAL_TIMEOUT_MS, 5 min by
 * default) with room to spare, since the hook blocks on the user's answer.
 */
const HOOK_TIMEOUT_S = 900;

/** What a marker records so a later process can undo an interrupted run. */
interface Marker {
  cwd: string;
  /** Original file contents, or null when the file did not exist. */
  hooks: string | null;
  mcp: string | null;
}

/** Live installs in this process: directory -> refcount + originals. */
interface Install {
  refs: number;
  marker: Marker;
  markerFile: string;
}

const installs = new Map<string, Install>();

/**
 * Per-directory work queue. Acquire and release both read-modify-write two
 * files, and several agents can hit the same project at once, so they are
 * serialized rather than interleaved.
 */
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  // Keep the chain alive but never let a rejection escape into the next link.
  queues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

function markerFileFor(dir: string): string {
  return join(MARKER_DIR, `${createHash("sha256").update(dir).digest("hex").slice(0, 16)}.json`);
}

/** Command cursor runs for a hook, with the event passed as an argument. */
function hookCommand(event: "pre" | "post"): string {
  // cmd.exe mangles a command whose FIRST token is quoted, so on Windows the
  // interpreter is named plainly (node ships on PATH there) and only the script
  // path — the one that can contain spaces mid-command — is quoted.
  const node = process.platform === "win32" ? "node" : `"${process.execPath}"`;
  return `${node} "${HOOK_SCRIPT}" cursor ${event}`;
}

/** Parse JSON, or return an empty object for missing/unreadable/invalid input.
 *  The raw text is kept separately for restore, so a broken user file is only
 *  ever set aside for the duration of the run, never rewritten. */
function parseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Read a file, or null when it is absent. */
async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Our two hook entries merged into whatever the project already declared.
 *  Cursor's native form is flat: each event maps straight to a list of hook
 *  objects, with none of Claude Code's `{matcher, hooks:[…]}` nesting. */
function mergeHooks(base: Record<string, unknown>): string {
  const hooks = { ...(base.hooks as Record<string, unknown> | undefined) };
  const append = (event: string, entry: unknown) => {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...existing, entry];
  };
  append("preToolUse", { type: "command", command: hookCommand("pre"), timeout: HOOK_TIMEOUT_S });
  append("postToolUse", { type: "command", command: hookCommand("post"), timeout: 30 });
  return `${JSON.stringify({ ...base, version: 1, hooks }, null, 2)}\n`;
}

/** Our MCP server merged into whatever the project already declared. A server
 *  the user happens to have called "myagens" is replaced for the run and comes
 *  back on restore. `bridgeFile` names the turn's credentials; nothing secret
 *  is written into the project itself. */
function mergeMcp(base: Record<string, unknown>, bridgeFile: string): string {
  const servers = { ...(base.mcpServers as Record<string, unknown> | undefined) };
  servers[SERVER_NAME] = {
    command: process.execPath,
    args: [MCP_BRIDGE_SCRIPT],
    env: { MYAGENS_BRIDGE_FILE: bridgeFile },
  };
  return `${JSON.stringify({ ...base, mcpServers: servers }, null, 2)}\n`;
}

/** Write this turn's bridge coordinates where only our MCP child can read them. */
async function writeBridgeFile(url: string, token: string): Promise<string> {
  const file = join(BRIDGE_DIR, `${randomUUID()}.json`);
  await mkdir(BRIDGE_DIR, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ url, token }), { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

/** Put a file back exactly as it was, or remove it when it was not there. */
async function restoreFile(file: string, original: string | null): Promise<void> {
  if (original === null) await rm(file, { force: true });
  else await writeFile(file, original, "utf8");
}

/** Restore both files, then drop a `.cursor` directory we created ourselves.
 *  `rmdir` on a directory holding anything else fails, which is the point. */
async function restoreProject(cwd: string, marker: Marker): Promise<void> {
  const dotCursor = join(cwd, ".cursor");
  await restoreFile(join(dotCursor, "hooks.json"), marker.hooks ?? null);
  await restoreFile(join(dotCursor, "mcp.json"), marker.mcp ?? null);
  if (marker.hooks == null && marker.mcp == null) {
    await rmdir(dotCursor).catch(() => {});
  }
}

/** An installed config; `dispose()` must run in the caller's finally. */
export interface CursorConfigHandle {
  dispose(): Promise<void>;
}

let warned = false;

function warnOnce(message: string, meta: Record<string, unknown>): null {
  if (!warned) {
    warned = true;
    log.warn(message, meta);
  }
  return null;
}

/**
 * Install the hook + MCP config in `cwd` for one turn, or return null when it
 * can't be done — in which case the caller must fall back to a plain cursor run
 * (no MyAgens tools, no approval gate), since the gate is only real while these
 * files are.
 */
export async function installCursorConfig(
  cwd: string,
  bridge: { url: string; token: string },
): Promise<CursorConfigHandle | null> {
  if (!existsSync(HOOK_SCRIPT) || !existsSync(MCP_BRIDGE_SCRIPT)) {
    return warnOnce("cursor backend: helper scripts missing — running without MyAgens tools or approvals", {
      expected: HOOK_SCRIPT,
    });
  }

  const dir = resolve(cwd);

  return serialize(dir, async () => {
    const dotCursor = join(dir, ".cursor");
    const hooksFile = join(dotCursor, "hooks.json");
    const mcpFile = join(dotCursor, "mcp.json");
    let bridgeFile: string | undefined;
    try {
      // Whatever the project itself declares, captured once per install: a
      // second agent joining an existing install must merge over the user's
      // original files, not over ours.
      const live = installs.get(dir);
      const marker: Marker = live?.marker ?? {
        cwd: dir,
        hooks: await readOrNull(hooksFile),
        mcp: await readOrNull(mcpFile),
      };
      const markerFile = markerFileFor(dir);
      // The marker is written BEFORE the config, so a crash between the two
      // leaves a marker describing files we never touched (restoring them is a
      // no-op) rather than config with nothing recording what it displaced.
      await mkdir(MARKER_DIR, { recursive: true, mode: 0o700 });
      await writeFile(markerFile, `${JSON.stringify(marker, null, 2)}\n`, "utf8");

      bridgeFile = await writeBridgeFile(bridge.url, bridge.token);
      await mkdir(dotCursor, { recursive: true });
      // Rewritten on every acquire, not just the first: `mcp.json` names this
      // turn's handoff file. Cursor reads it once at startup, so a turn that is
      // already running is unaffected by a later turn's rewrite.
      await writeFile(hooksFile, mergeHooks(parseObject(marker.hooks)), "utf8");
      await writeFile(mcpFile, mergeMcp(parseObject(marker.mcp), bridgeFile), "utf8");

      installs.set(dir, { refs: (live?.refs ?? 0) + 1, marker, markerFile });
      const file = bridgeFile;
      return { dispose: () => release(dir, file) };
    } catch (err) {
      // Undo whatever landed before the failure, so a half-installed config
      // can't outlive a turn that never ran.
      if (bridgeFile) await rm(bridgeFile, { force: true }).catch(() => {});
      if (!installs.has(dir)) await rm(markerFileFor(dir), { force: true }).catch(() => {});
      return warnOnce("cursor backend: could not write the project config — running without MyAgens tools", {
        dir: dotCursor,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/** Drop one reference; the last one out restores the project's own files. */
function release(dir: string, bridgeFile: string): Promise<void> {
  return serialize(dir, async () => {
    await rm(bridgeFile, { force: true }).catch(() => {});
    const live = installs.get(dir);
    if (!live) return;
    live.refs -= 1;
    if (live.refs > 0) return;
    installs.delete(dir);
    try {
      await restoreProject(dir, live.marker);
      await rm(live.markerFile, { force: true });
    } catch (err) {
      // The marker deliberately stays behind on failure: boot will retry it.
      log.warn("cursor backend: could not restore the project config", {
        dir,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Replay any markers a previous process left behind (a crash or a kill -9
 * mid-turn), so a project never keeps MyAgens hooks wired in after the run that
 * installed them is gone. Safe to call at boot before any turn starts.
 */
export async function restoreCursorConfigs(): Promise<void> {
  let files: string[];
  try {
    files = await readdir(MARKER_DIR);
  } catch {
    return; // nothing was ever installed
  }
  // Credential files from turns that never got to delete their own.
  await rm(BRIDGE_DIR, { recursive: true, force: true }).catch(() => {});
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    const file = join(MARKER_DIR, name);
    try {
      const marker = JSON.parse(await readFile(file, "utf8")) as Marker;
      if (!marker?.cwd || typeof marker.cwd !== "string") {
        await rm(file, { force: true });
        continue;
      }
      await restoreProject(marker.cwd, marker);
      await rm(file, { force: true });
      log.info("cursor backend: restored a project config left behind by an interrupted run", {
        dir: marker.cwd,
      });
    } catch (err) {
      log.warn("cursor backend: could not replay a leftover config marker", {
        file: name,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
