// PreToolUse / PostToolUse hook for Antigravity runs driven by MyAgens.
//
// Registered in the per-run customization root written by
// src/agy/customization.ts. Antigravity runs it once per tool step, hands it the
// step as JSON on stdin, and reads its decision as JSON on stdout. It forwards
// both to the bot process (src/agy/bridge.ts), which is what gives this backend
// live "🔧 tool" status and real Approve/Deny buttons for Antigravity's own
// tools (run_command, write_file, …) — the CLI streams no tool events of its own.
//
// Fails closed on purpose: if the bot cannot be reached while a run is in
// flight, the tool is denied rather than quietly run unsupervised. With no
// bridge configured at all it stays out of the way and returns no decision.

import { readFileSync } from "node:fs";

const URL_BASE = process.env.MYAGENS_AGY_BRIDGE_URL;
const TOKEN = process.env.MYAGENS_AGY_BRIDGE_TOKEN;

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  payload = {};
}

// No bridge: not our run. An empty object is "no opinion", so Antigravity's own
// permission handling applies unchanged.
if (!URL_BASE || !TOKEN) out({});

// Which event this is comes from argv, not from the payload: Antigravity sends
// the tool call in the PostToolUse body too, so sniffing the payload would run
// the whole pre-flight (status line, approval prompt) a second time per tool.
const isPre = process.argv[2] !== "post";
const path = isPre ? "/hook/pre" : "/hook/post";
const body = isPre
  ? { tool: payload.toolCall?.name ?? "", args: payload.toolCall?.args ?? {}, stepIdx: payload.stepIdx }
  : { stepIdx: payload.stepIdx, error: payload.error };

try {
  const res = await fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const decision = await res.json();
  out(isPre ? decision : {});
} catch (err) {
  if (!isPre) out({});
  out({
    decision: "deny",
    reason:
      `MyAgens could not confirm this tool call (${err?.message ?? err}), so it was blocked. ` +
      "Do not retry it; tell the user the approval channel is unavailable.",
  });
}
