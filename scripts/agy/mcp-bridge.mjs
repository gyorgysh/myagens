// stdio MCP server that republishes MyAgens' in-process tools to Antigravity.
//
// Registered as an MCP server in the per-run customization root written by
// src/agy/customization.ts, so `agy` discovers and spawns it like any other MCP
// server. It owns no tools itself: every tools/list and tools/call is forwarded
// to the bot process over loopback (src/agy/bridge.ts), which is where the real
// handlers, the approval flow, and the live tool status live.
//
// The turn's endpoint and token arrive as env vars on the agy spawn. Without
// them (someone ran this by hand) it starts cleanly and advertises no tools.
//
// Plain Node, no build step and no dependencies: it runs from the repo in both
// dev and production, where the compiled bot lives in dist/ but this does not.

import { createInterface } from "node:readline";

const URL_BASE = process.env.MYAGENS_AGY_BRIDGE_URL;
const TOKEN = process.env.MYAGENS_AGY_BRIDGE_TOKEN;

/** Latest MCP revision we know; the client's own version wins when it sends one. */
const FALLBACK_PROTOCOL = "2025-06-18";

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
  if (id !== undefined && id !== null) write({ jsonrpc: "2.0", id, result });
}

/** POST to the bot. Rejects on transport failure or a non-2xx reply. */
async function callBot(path, body) {
  if (!URL_BASE || !TOKEN) throw new Error("MyAgens bridge is not configured for this process");
  const res = await fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MyAgens bridge returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
  }
  return res.json();
}

async function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion || FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "myagens", version: "1.0.0" },
      });

    case "tools/list": {
      if (!URL_BASE || !TOKEN) return reply(id, { tools: [] });
      try {
        const { tools } = await callBot("/tools/list", {});
        return reply(id, { tools: Array.isArray(tools) ? tools : [] });
      } catch (err) {
        // An unreachable bot must not take the whole agy session down: report an
        // empty tool set and let the run continue with Antigravity's own tools.
        process.stderr.write(`myagens: tools/list failed: ${err?.message ?? err}\n`);
        return reply(id, { tools: [] });
      }
    }

    case "tools/call": {
      try {
        const { result } = await callBot("/tools/call", {
          name: params?.name,
          arguments: params?.arguments ?? {},
        });
        return reply(id, result);
      } catch (err) {
        return reply(id, {
          content: [{ type: "text", text: `MyAgens tool call failed: ${err?.message ?? err}` }],
          isError: true,
        });
      }
    }

    case "resources/list":
      return reply(id, { resources: [] });
    case "prompts/list":
      return reply(id, { prompts: [] });
    case "ping":
      return reply(id, {});

    default:
      // Notifications carry no id and need no answer; anything else gets an
      // empty result rather than an error, so an unknown handshake extension
      // (Antigravity opens with its own `server/discover`) can't wedge startup.
      return reply(id, {});
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  void handle(msg).catch((err) => {
    if (msg?.id !== undefined && msg?.id !== null) {
      write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(err?.message ?? err) } });
    }
  });
});
rl.on("close", () => process.exit(0));
