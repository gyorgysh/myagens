import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { repoRoot } from "../config.js";
import { dataPath } from "../core/jsonStore.js";
import { log } from "../logger.js";

/**
 * Build the private `CODEX_HOME` that turns a bare `codex` run into a MyAgens
 * run.
 *
 * Codex reads hooks from exactly one place: the FILE `$CODEX_HOME/hooks.json`.
 * There is no flag and no `-c` key that carries a hook definition (`-c
 * hooks.PreToolUse=[…]` parses fine and is then silently ignored). Writing into
 * the user's own `~/.codex/hooks.json` is not an option — our hook would then
 * fire during their own codex sessions — so we point `CODEX_HOME` at a
 * directory of our own that holds exactly two things:
 * - `auth.json`, a symlink to the real one, so the user's login still works and
 *   a token refresh writes through to the file they already have;
 * - `hooks.json`, ours, wiring PreToolUse/PostToolUse to the shared bridge hook.
 *
 * MCP registration needs no file: `-c mcp_servers.…` works per invocation
 * (see src/codex/runner.ts).
 *
 * **The hook is worthless without `--dangerously-bypass-hook-trust`.** Codex
 * gates every hook on a sha256 trust record in `config.toml` and *silently
 * skips* an untrusted one, with no warning and no event: the tool then runs
 * ungated. That is a fail-open default, so the flag and this home are passed
 * together or not at all — `codexLaunch()` below is the only thing that
 * produces either, and it produces both.
 *
 * Known trade-off: the user's own `~/.codex/config.toml` (model, provider,
 * their MCP servers, approval defaults) does NOT apply to our runs. That is
 * deliberate isolation rather than an oversight — their config also carries
 * their hook trust records — and the model is set from MyAgens instead.
 * Session transcripts also live here, so a codex thread id stored before this
 * existed cannot be resumed; the runner falls back to a fresh thread.
 */

/** Our private codex home; only ever written by MyAgens (and by codex itself,
 *  which keeps its session transcripts and project-trust records in there). */
export const CODEX_HOME_DIR = dataPath("codex-home");

/** The flag without which codex silently skips our hook. Never pass the private
 *  home without it: see the fail-open warning above. */
export const HOOK_TRUST_FLAG = "--dangerously-bypass-hook-trust";

/** Per-turn bridge credential files, kept out of argv (see writeBridgeFile). */
const BRIDGE_DIR = join(CODEX_HOME_DIR, "bridge");

const HOOK_SCRIPT = join(repoRoot, "scripts", "cli-bridge", "hook.mjs");
export const MCP_BRIDGE_SCRIPT = join(repoRoot, "scripts", "cli-bridge", "mcp-bridge.mjs");

/**
 * Hook timeout. Must outlast an approval prompt (APPROVAL_TIMEOUT_MS, 5 min by
 * default) with room to spare, since the hook blocks on the user's answer.
 */
const HOOK_TIMEOUT_S = 900;

/** The real codex home, honouring a CODEX_HOME the user set for themselves. */
function realCodexHome(): string {
  const fromEnv = process.env.CODEX_HOME;
  return fromEnv && fromEnv !== CODEX_HOME_DIR ? fromEnv : join(homedir(), ".codex");
}

/** Shell command codex runs for a hook, with the event passed as an argument. */
function hookCommand(event: "pre" | "post"): string {
  // cmd.exe mangles a command whose FIRST token is quoted, so on Windows the
  // interpreter is named plainly (node ships on PATH there) and only the script
  // path — the one that can contain spaces mid-command — is quoted.
  const node = process.platform === "win32" ? "node" : `"${process.execPath}"`;
  return `${node} "${HOOK_SCRIPT}" codex ${event}`;
}

function hooksFile(): string {
  return `${JSON.stringify(
    {
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: hookCommand("pre"), timeout: HOOK_TIMEOUT_S }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: hookCommand("post"), timeout: 30 }] }],
      },
    },
    null,
    2,
  )}\n`;
}

/** Write `file` only when its content differs, so repeated turns don't churn. */
async function writeIfChanged(file: string, content: string): Promise<void> {
  try {
    if ((await readFile(file, "utf8")) === content) return;
  } catch {
    // Missing or unreadable — fall through and write it.
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

/**
 * Point `auth.json` at the real one. Re-checked every run rather than once at
 * boot: a `codex login` that unlinks and recreates the file leaves our link
 * dangling, and only a fresh check notices.
 */
async function linkAuth(link: string, target: string): Promise<void> {
  try {
    const st = await lstat(link);
    if (st.isSymbolicLink() && (await readlink(link)) === target && existsSync(link)) return;
    await rm(link, { force: true });
  } catch {
    // Not there yet.
  }
  await symlink(target, link);
}

/** What a codex invocation needs to run as a MyAgens agent. */
export interface CodexLaunch {
  /** Value for the child's CODEX_HOME. */
  home: string;
  /** Flags that MUST accompany that home (the hook-trust bypass, see above). */
  args: string[];
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
 * Ensure the private home exists and return it together with the flags it must
 * be paired with, or null when it can't be built — in which case the caller
 * must fall back to a plain codex run (no MyAgens tools, no approval gate),
 * since the gate is only real while these files are.
 */
export async function codexLaunch(): Promise<CodexLaunch | null> {
  if (!existsSync(HOOK_SCRIPT) || !existsSync(MCP_BRIDGE_SCRIPT)) {
    return warnOnce("codex backend: helper scripts missing — running without MyAgens tools or approvals", {
      expected: HOOK_SCRIPT,
    });
  }

  const auth = join(realCodexHome(), "auth.json");
  if (!existsSync(auth)) {
    // Nothing to link to. Running with our home anyway would strip the user's
    // login, so hand the turn back to their own codex home unchanged.
    return warnOnce("codex backend: no codex login found — running without MyAgens tools or approvals", {
      expected: auth,
    });
  }

  try {
    await mkdir(CODEX_HOME_DIR, { recursive: true, mode: 0o700 });
    await linkAuth(join(CODEX_HOME_DIR, "auth.json"), auth);
    await writeIfChanged(join(CODEX_HOME_DIR, "hooks.json"), hooksFile());
  } catch (err) {
    return warnOnce("codex backend: could not build the private CODEX_HOME", {
      dir: CODEX_HOME_DIR,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    home: CODEX_HOME_DIR,
    // Without this codex silently skips our (untrusted) hook and every tool
    // runs ungated. It is safe here precisely because the home it applies to is
    // entirely ours: the only hook in it is the one we just wrote.
    args: [HOOK_TRUST_FLAG],
  };
}

/**
 * Hand the turn's bridge coordinates to the MCP server through a file rather
 * than argv.
 *
 * Codex does not pass its own environment to stdio MCP children (measured), so
 * unlike agy the token cannot simply ride along in the env — it has to be named
 * in `-c mcp_servers.myagens.env={…}`, which puts it in the command line where
 * any local user can read it out of `ps`. So argv carries only this file's
 * path, and the file (0600, deleted when the turn ends) carries the secret.
 * The hook does not need it: hooks DO inherit the parent env.
 */
export async function writeBridgeFile(url: string, token: string): Promise<string | null> {
  const file = join(BRIDGE_DIR, `${randomUUID()}.json`);
  try {
    await mkdir(BRIDGE_DIR, { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ url, token }), { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);
    return file;
  } catch (err) {
    log.warn("codex backend: could not write the bridge credential file", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
