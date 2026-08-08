import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { repoRoot } from "../config.js";
import { dataPath } from "../core/jsonStore.js";
import { log } from "../logger.js";

/**
 * Build the env + inline config that turns a bare `opencode` run into a
 * MyAgens run.
 *
 * OpenCode discovers MCP servers and plugins from config, not from CLI flags.
 * Writing into the user's `~/.config/opencode/` or the project `opencode.json`
 * would follow them into their own sessions, so we stay out of both:
 *
 * - **MCP** is injected per turn via `OPENCODE_CONFIG_CONTENT` (highest-priority
 *   standard override short of managed settings), naming a 0600 handoff file
 *   for the bridge coordinates rather than putting the token in argv/`ps`.
 * - **Approvals** come from a plugin under `OPENCODE_CONFIG_DIR`, which points
 *   at the static tree in `scripts/cli-bridge/opencode-config/` (plugin files
 *   only: no secrets, no per-turn state). OpenCode has no shell-command
 *   PreToolUse hook like codex/cursor. Plugins run in-process and gate via
 *   `tool.execute.before` (throw = deny).
 *
 * Without either helper the turn falls back to plain opencode (no MyAgens
 * tools, no approval gate).
 */

/** Per-turn bridge credential files. */
const BRIDGE_DIR = dataPath("opencode-bridge");

export const MCP_BRIDGE_SCRIPT = join(repoRoot, "scripts", "cli-bridge", "mcp-bridge.mjs");

/** Static config dir that holds our plugin (OPENCODE_CONFIG_DIR). */
export const OPENCODE_CONFIG_DIR = join(repoRoot, "scripts", "cli-bridge", "opencode-config");

const PLUGIN_FILE = join(OPENCODE_CONFIG_DIR, "plugins", "myagens.js");

/** What an opencode invocation needs to run as a MyAgens agent. */
export interface OpencodeLaunch {
  /** Env vars to merge onto the child (OPENCODE_* + bridge coordinates). */
  env: Record<string, string>;
  /** Path of the turn's bridge credential file (deleted when the turn ends). */
  bridgeFile: string;
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
 * Write this turn's bridge coordinates where only our MCP child can read them.
 * The plugin inherits the CLI's env and does not need the file.
 */
async function writeBridgeFile(url: string, token: string): Promise<string | null> {
  const file = join(BRIDGE_DIR, `${randomUUID()}.json`);
  try {
    await mkdir(BRIDGE_DIR, { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ url, token }), { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);
    return file;
  } catch (err) {
    log.warn("opencode backend: could not write the bridge credential file", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Produce the launch env for one turn, or null when the helpers are missing —
 * in which case the caller must fall back to a plain opencode run.
 */
export async function opencodeLaunch(bridge: {
  url: string;
  token: string;
}): Promise<OpencodeLaunch | null> {
  if (!existsSync(MCP_BRIDGE_SCRIPT) || !existsSync(PLUGIN_FILE)) {
    return warnOnce("opencode backend: helper scripts missing — running without MyAgens tools or approvals", {
      expected: PLUGIN_FILE,
    });
  }

  const bridgeFile = await writeBridgeFile(bridge.url, bridge.token);
  if (!bridgeFile) {
    return warnOnce("opencode backend: no bridge file — running without MyAgens tools or approvals", {});
  }

  // Inline config is merged after project config, so our MCP server wins for
  // this process without touching the user's files. `permission: {"*":"allow"}`
  // is deliberate: OpenCode's headless `run` auto-rejects "ask" permissions
  // (and `--auto` would approve them without our gate). The plugin is the real
  // gate. MCP tool-list timeout has to clear a cold tools/list; tool calls that
  // wait on Approve/Deny are gated inside our bridge, not by this number.
  const configContent = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    permission: { "*": "allow" },
    mcp: {
      myagens: {
        type: "local",
        command: [process.execPath, MCP_BRIDGE_SCRIPT],
        enabled: true,
        // OpenCode may not pass its own env to MCP children, so the coordinates
        // travel in an explicit environment map — the file path, never the token.
        environment: { MYAGENS_BRIDGE_FILE: bridgeFile },
        timeout: 30_000,
      },
    },
  });

  return {
    bridgeFile,
    env: {
      OPENCODE_CONFIG_DIR,
      OPENCODE_CONFIG_CONTENT: configContent,
      // The plugin reads these from the CLI process env (in-process, not a child).
      MYAGENS_BRIDGE_URL: bridge.url,
      MYAGENS_BRIDGE_TOKEN: bridge.token,
    },
  };
}
