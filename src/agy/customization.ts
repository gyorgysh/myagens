import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { repoRoot } from "../config.js";
import { dataPath } from "../core/jsonStore.js";
import { log } from "../logger.js";

/**
 * Write the Antigravity customization root that turns a bare `agy` run into a
 * MyAgens run.
 *
 * `agy` has no per-invocation flag for MCP servers or hooks: it discovers them
 * from customization roots. It does, however, scan every workspace directory it
 * is given — so instead of touching `~/.gemini/config` (which would follow the
 * user into their own agy sessions) we keep a root of our own under the data
 * dir and pass it as an extra `--add-dir`. Nothing outside our runs ever loads
 * it.
 *
 * The plugin holds two entries, both pointing at scripts/agy/ helpers that call
 * back into the running bot (src/agy/bridge.ts):
 * - `mcp_config.json` — republishes our in-process MCP tools (memory, kanban,
 *   crew, connectors, send_file, …).
 * - `hooks.json` — PreToolUse/PostToolUse, which is where tool status and
 *   Approve/Deny for Antigravity's own tools come from.
 *
 * The files are static (the per-turn token travels in the environment), so this
 * is idempotent and rewrites only when the content actually changes.
 */

/** Where the customization root lives; passed to agy as an extra workspace dir. */
export const AGY_ROOT_DIR = dataPath("agy-customizations");

const PLUGIN_DIR = join(AGY_ROOT_DIR, ".agents", "plugins", "myagens");
const BRIDGE_SCRIPT = join(repoRoot, "scripts", "agy", "mcp-bridge.mjs");
const HOOK_SCRIPT = join(repoRoot, "scripts", "agy", "hook.mjs");

/**
 * Hook timeout. Must outlast an approval prompt (APPROVAL_TIMEOUT_MS, 5 min by
 * default) with room to spare, since the hook blocks on the user's answer.
 */
const HOOK_TIMEOUT_S = 900;

/**
 * Shell command Antigravity runs for a hook (via `sh -c`, or `cmd /c` on
 * Windows). The event is passed as an argument because the PostToolUse payload
 * repeats the tool call, so the hook can't tell the two apart from the payload.
 */
function hookCommand(event: "pre" | "post"): string {
  // cmd.exe mangles a command whose FIRST token is quoted, so on Windows the
  // interpreter is named plainly (node ships on PATH there) and only the script
  // path — the one that can contain spaces mid-command — is quoted.
  const node = process.platform === "win32" ? "node" : `"${process.execPath}"`;
  return `${node} "${HOOK_SCRIPT}" ${event}`;
}

function pluginFiles(): Record<string, unknown> {
  return {
    "plugin.json": { name: "myagens" },
    "mcp_config.json": {
      mcpServers: {
        myagens: { command: process.execPath, args: [BRIDGE_SCRIPT] },
      },
    },
    "hooks.json": {
      myagens: {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: hookCommand("pre"), timeout: HOOK_TIMEOUT_S }] },
        ],
        PostToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: hookCommand("post"), timeout: 30 }] },
        ],
      },
    },
  };
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

let warned = false;

/**
 * Ensure the customization root exists and return it, or null when it can't be
 * built — in which case the caller must fall back to a plain agy run (no MCP
 * tools, no approval gate), since the gate is only real while these files are.
 */
export async function ensureAgyCustomization(): Promise<string | null> {
  if (!existsSync(BRIDGE_SCRIPT) || !existsSync(HOOK_SCRIPT)) {
    if (!warned) {
      warned = true;
      log.warn("agy backend: helper scripts missing — running without MyAgens tools or approvals", {
        expected: BRIDGE_SCRIPT,
      });
    }
    return null;
  }
  try {
    for (const [name, body] of Object.entries(pluginFiles())) {
      await writeIfChanged(join(PLUGIN_DIR, name), `${JSON.stringify(body, null, 2)}\n`);
    }
    return AGY_ROOT_DIR;
  } catch (err) {
    if (!warned) {
      warned = true;
      log.warn("agy backend: could not write the customization root", {
        dir: PLUGIN_DIR,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}
