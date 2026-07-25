// PreToolUse / PostToolUse hook for CLI-driven agent backends (agy today,
// codex/cursor once they adopt the shared bridge).
//
// Registered in the per-run customization root written by the backend's own
// customization module (e.g. src/agy/customization.ts). The CLI runs this
// once per tool step, hands it the step as JSON on stdin, and reads its
// decision as JSON on stdout. It forwards both to the bot process
// (src/core/cliBridge.ts), which is what gives that backend live "🔧 tool"
// status and real Approve/Deny buttons for the CLI's own tools (run_command,
// write_file, …) — none of these CLIs streams tool events of its own.
//
// Invoked as `node hook.mjs <flavor> <pre|post>`. `flavor` picks the payload
// shape below (only "agy" exists so far); the FLAVORS map is the only thing a
// future CLI needs to extend.
//
// Fails closed on purpose: if the bot cannot be reached while a run is in
// flight, the tool is denied rather than quietly run unsupervised. With no
// bridge configured at all it stays out of the way and returns no decision.

import { readFileSync } from "node:fs";

const URL_BASE = process.env.MYAGENS_BRIDGE_URL;
const TOKEN = process.env.MYAGENS_BRIDGE_TOKEN;

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

/** Reason text for the fail-closed deny path, shared across flavors and failure kinds. */
function denyReason(detail) {
  return (
    `MyAgens could not confirm this tool call (${detail}), so it was blocked. ` +
    "Do not retry it; tell the user the approval channel is unavailable."
  );
}

/**
 * Per-CLI translation between that CLI's own hook payload and the bridge's
 * wire format. Each flavor supplies:
 * - `decode(payload)` — pull `{tool, args, stepIdx}` out of the PreToolUse body.
 * - `decodePost(payload)` — pull `{stepIdx, error}` out of the PostToolUse body.
 * - `encodeAllow(decision)` — turn the bridge's `/hook/pre` response into what
 *   this CLI expects on stdout for a successful round trip.
 * - `encodeDeny(reason)` — the fail-closed stdout shape for this CLI.
 */
const FLAVORS = {
  agy: {
    decode(payload) {
      return {
        tool: payload.toolCall?.name ?? "",
        args: payload.toolCall?.args ?? {},
        stepIdx: payload.stepIdx,
      };
    },
    decodePost(payload) {
      return { stepIdx: payload.stepIdx, error: payload.error };
    },
    encodeAllow(decision) {
      return decision;
    },
    encodeDeny(reason) {
      return { decision: "deny", reason };
    },
  },
};

const flavorName = process.argv[2];
// Which event this is comes from argv, not from the payload: these CLIs send
// the tool call in the PostToolUse body too, so sniffing the payload would run
// the whole pre-flight (status line, approval prompt) a second time per tool.
const isPre = process.argv[3] !== "post";

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  payload = {};
}

// No bridge: not our run. An empty object is "no opinion", so the CLI's own
// permission handling applies unchanged.
if (!URL_BASE || !TOKEN) out({});

const flavor = FLAVORS[flavorName];
if (!flavor) {
  // An unknown flavor fails exactly like an unreachable bridge: deny on the
  // pre event so nothing runs unsupervised, stay quiet on the post event
  // since there is nothing to report back.
  //
  // The deny below is in agy's shape, because with no flavor there is no way to
  // know the caller's. A CLI whose deny shape differs would read it as "no
  // opinion" and run the tool. That only happens if a backend passes a flavor
  // name that isn't in FLAVORS, so when adding one, check that the registered
  // name matches on both sides.
  if (!isPre) out({});
  out({ decision: "deny", reason: denyReason(`unknown hook flavor "${flavorName}"`) });
}

const path = isPre ? "/hook/pre" : "/hook/post";
const body = isPre ? flavor.decode(payload) : flavor.decodePost(payload);

try {
  const res = await fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const decision = await res.json();
  out(isPre ? flavor.encodeAllow(decision) : {});
} catch (err) {
  if (!isPre) out({});
  out(flavor.encodeDeny(denyReason(err?.message ?? err)));
}
