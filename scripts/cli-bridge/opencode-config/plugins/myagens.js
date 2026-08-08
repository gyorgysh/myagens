// OpenCode plugin that gates the CLI's own tools through the MyAgens bridge.
//
// Loaded from OPENCODE_CONFIG_DIR (src/opencode/launch.ts points OpenCode at
// this directory). OpenCode has no shell-command PreToolUse hook like codex
// or cursor: plugins run in-process and use tool.execute.before / after.
// Throwing from before denies the call; mutating output.args rewrites it.
//
// Bridge coordinates arrive in the environment of the opencode process
// (MYAGENS_BRIDGE_URL / MYAGENS_BRIDGE_TOKEN). With no bridge this plugin is a
// no-op so a bare `opencode` run is unaffected. Fails closed on purpose: if
// the bot cannot be reached while a run is in flight, the tool is denied
// rather than quietly run unsupervised.

/** @param {string} detail */
function denyMessage(detail) {
  return (
    `MyAgens could not confirm this tool call (${detail}), so it was blocked. ` +
    "Do not retry it; tell the user the approval channel is unavailable."
  );
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} body
 */
async function callBridge(path, body) {
  const url = process.env.MYAGENS_BRIDGE_URL;
  const token = process.env.MYAGENS_BRIDGE_TOKEN;
  if (!url || !token) return null;
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export default async function MyAgensPlugin() {
  return {
    "tool.execute.before": async (input, output) => {
      // No bridge: not our run. Leave OpenCode's own permission handling alone.
      if (!process.env.MYAGENS_BRIDGE_URL || !process.env.MYAGENS_BRIDGE_TOKEN) return;

      let decision;
      try {
        decision = await callBridge("/hook/pre", {
          tool: input?.tool ?? "",
          args: output?.args ?? {},
          stepIdx: input?.callID,
        });
      } catch (err) {
        throw new Error(denyMessage(err?.message ?? String(err)));
      }

      if (decision?.decision === "deny") {
        throw new Error(decision.reason || "Denied by MyAgens.");
      }
      // An approved-with-edits command is pushed back by mutating args in place.
      if (decision?.overwrite && output?.args && typeof output.args === "object") {
        Object.assign(output.args, decision.overwrite);
      }
    },

    // Outcomes for OpenCode's own tools arrive on the `--format json` stream
    // (tool_use with status completed/error). Reporting them here too would
    // double-count, so PostToolUse is intentionally empty. MCP calls are
    // answered by the bridge itself.
    "tool.execute.after": async () => {},
  };
}
