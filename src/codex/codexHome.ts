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
 * directory of our own that holds:
 * - `auth.json` — either a symlink to the user's ChatGPT login, or a private
 *   file holding an OpenAI API key for usage-based Platform billing (see
 *   `apiKey` on `codexLaunch`);
 * - `hooks.json`, ours, wiring PreToolUse/PostToolUse to the shared bridge hook;
 * - `config.toml` (API-key mode only) forcing `preferred_auth_method = "apikey"`
 *   so a ChatGPT login sitting on the host cannot steal the billing path.
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
  /**
   * Extra env for the child. When an API key is in play this carries
   * OPENAI_API_KEY / CODEX_API_KEY; when using ChatGPT login the runner clears
   * those vars so a host-level key cannot switch billing under us.
   */
  env?: Record<string, string | undefined>;
}

let warned = false;

function warnOnce(message: string, meta: Record<string, unknown>): null {
  if (!warned) {
    warned = true;
    log.warn(message, meta);
  }
  return null;
}

/** Private auth.json shape Codex accepts for usage-based API-key login. */
async function writeApiKeyAuth(file: string, apiKey: string): Promise<void> {
  const body = `${JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2)}\n`;
  await mkdir(dirname(file), { recursive: true });
  // Drop a leftover symlink to the user's ChatGPT auth first: writing through a
  // symlink would overwrite their real login file.
  try {
    const st = await lstat(file);
    if (st.isSymbolicLink()) await rm(file, { force: true });
  } catch {
    // Not there yet.
  }
  await writeFile(file, body, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

/** Force API-key auth for this private home (and nothing else). */
function apiKeyConfigToml(): string {
  return [
    "# Written by MyAgens for the codex-cli backend. Do not edit by hand.",
    'preferred_auth_method = "apikey"',
    'forced_login_method = "api"',
    "",
  ].join("\n");
}

/**
 * Ensure the private home exists and return it together with the flags it must
 * be paired with, or null when it can't be built — in which case the caller
 * must fall back to a plain codex run (no MyAgens tools, no approval gate),
 * since the gate is only real while these files are.
 *
 * Pass `apiKey` to bill OpenAI Platform usage instead of a ChatGPT
 * subscription. That path does not need `codex login` / `auth.json` on the
 * host. Without a key, the host's ChatGPT login is required (symlinked in).
 */
export async function codexLaunch(opts?: { apiKey?: string }): Promise<CodexLaunch | null> {
  if (!existsSync(HOOK_SCRIPT) || !existsSync(MCP_BRIDGE_SCRIPT)) {
    return warnOnce("codex backend: helper scripts missing — running without MyAgens tools or approvals", {
      expected: HOOK_SCRIPT,
    });
  }

  const apiKey = opts?.apiKey?.trim() || undefined;
  const userAuth = join(realCodexHome(), "auth.json");
  if (!apiKey && !existsSync(userAuth)) {
    // Nothing to authenticate with. Running with our home would leave codex
    // with no credentials, so hand the turn back to their own setup.
    return warnOnce(
      "codex backend: no API key and no codex login found — running without MyAgens tools or approvals",
      { expected: userAuth },
    );
  }

  try {
    await mkdir(CODEX_HOME_DIR, { recursive: true, mode: 0o700 });
    await writeIfChanged(join(CODEX_HOME_DIR, "hooks.json"), hooksFile());

    const privateAuth = join(CODEX_HOME_DIR, "auth.json");
    const privateConfig = join(CODEX_HOME_DIR, "config.toml");
    if (apiKey) {
      await writeApiKeyAuth(privateAuth, apiKey);
      await writeIfChanged(privateConfig, apiKeyConfigToml());
    } else {
      // ChatGPT subscription path: use the user's login, and drop any leftover
      // apikey config from a previous MyAgens-managed key so it cannot pin
      // preferred_auth_method and leave the linked tokens unused.
      await linkAuth(privateAuth, userAuth);
      await rm(privateConfig, { force: true }).catch(() => {});
    }
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
    // Explicit set or clear: a host OPENAI_API_KEY (e.g. for voice) must not
    // silently switch a ChatGPT-login run onto Platform billing, and our key
    // must win over whatever is already in the process env.
    env: apiKey
      ? { OPENAI_API_KEY: apiKey, CODEX_API_KEY: apiKey }
      : { OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined },
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
