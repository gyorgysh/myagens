import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { PermissionResult, RunOptions } from "../claude/runner.js";
import { log } from "../logger.js";

/**
 * Loopback control plane that gives a CLI subprocess (agy, and any future CLI
 * backend that borrows this) the two things such a CLI has no flag for: our
 * in-process MCP tools, and a say in whether a tool may run.
 *
 * Two helper processes call in here (see scripts/cli-bridge/):
 * - `mcp-bridge.mjs` is registered as a stdio MCP server in the per-run
 *   customization root, so the CLI discovers it like any other MCP server.
 *   It forwards `tools/list` / `tools/call` to `/tools/*` below, which proxies
 *   them to the SDK MCP servers this turn was given (memory, tasks, crew,
 *   connectors, …) — the same objects the Claude backend passes to the SDK.
 * - `hook.mjs` is registered as a PreToolUse/PostToolUse hook, so the CLI's
 *   OWN tools (run_command, write_file, …) reach `/hook/*` before they run.
 *   That is where tool status and Approve/Deny come from for that backend.
 *
 * Both helpers learn where to call and who they are from two env vars we set
 * on the CLI spawn (`MYAGENS_BRIDGE_URL` / `MYAGENS_BRIDGE_TOKEN`); the token
 * is per turn, so a request can only ever reach the run that started it. The
 * server binds 127.0.0.1 on an ephemeral port and stays up for the process
 * lifetime once started — with no live sessions every request is a 401.
 */

/** What one in-flight CLI turn exposes to its helper processes. */
export interface CliRunSpec {
  mcpServers: RunOptions["mcpServers"];
  permissionMode: RunOptions["permissionMode"];
  canUseTool: RunOptions["canUseTool"];
  onToolUse: RunOptions["onToolUse"];
  onToolResult?: RunOptions["onToolResult"];
  /** Translate this backend's own tool call into the canonical vocabulary. */
  mapTool: (tool: string, args: Record<string, unknown>) => MappedTool | null;
  /** Short label used only in log messages, e.g. "agy". */
  backend: string;
  /**
   * Set when the backend reports the outcome of its OWN tools from its event
   * stream (cursor does; a denied call still shows up there as a failure). The
   * bridge then stays quiet about those outcomes, including a deny, so one
   * refused call is not counted as two failures. MCP calls are unaffected: they
   * are answered here and nowhere else.
   */
  toolResultsFromStream?: boolean;
}

/** Handle for a registered turn; `dispose()` must run in the caller's finally. */
export interface CliRunHandle {
  url: string;
  token: string;
  /** Tool calls seen this turn (MCP + the CLI's own), for RunResult.toolCalls. */
  toolCalls: Array<{ name: string; input: unknown }>;
  dispose(): void;
}

/** A mapped call: what to show/gate it as, plus how to push an edited input back. */
export interface MappedTool {
  /** Canonical tool name (`Bash`, `Read`, …) used for status and permissions. */
  name: string;
  /** Canonical input, shaped like the Claude tool's input. */
  input: Record<string, unknown>;
  /** Convert an approved-with-edits canonical input back to the CLI's own args. */
  toCliArgs?: (input: Record<string, unknown>) => Record<string, unknown> | undefined;
}

/** Result shape of an MCP `tools/call`, as the helper forwards it verbatim. */
interface CallToolResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}

/** A tool as advertised to the CLI, named exactly like the Claude backend
 *  names it (`mcp__<server>__<tool>`) so AUTO_ALLOWED_TOOLS and the user's saved
 *  "always allow" presets mean the same thing on both backends. */
interface BridgedTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

const HOST = "127.0.0.1";
/** Request body cap — a tool result can be large, but not unbounded. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Hard ceiling on one in-process MCP tool call, so a wedged handler can't hang the turn. */
const CALL_TIMEOUT_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// In-memory JSON-RPC link to one SDK MCP server
// ---------------------------------------------------------------------------

/**
 * Speaks MCP to one `createSdkMcpServer()` instance over a pair of in-memory
 * pipes. The instance is a real `McpServer` from the Agent SDK's bundled MCP
 * library, and `connect()` only duck-types its transport, so this avoids
 * depending on the MCP SDK directly — and gets proper JSON Schema for each tool
 * out of the server itself rather than re-deriving it from the Zod shapes.
 */
class SdkServerLink {
  private nextId = 1;
  private pending = new Map<number, (msg: Record<string, unknown>) => void>();
  private toServer?: (msg: unknown) => void;
  private closeServer?: () => void;
  private ready = false;
  private readying?: Promise<void>;

  constructor(private instance: { connect(t: unknown): Promise<void>; close?(): Promise<void> }) {}

  /** Connect + handshake once, even if several calls arrive together. */
  private ensureReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (!this.readying) {
      this.readying = this.connect().catch((err) => {
        this.readying = undefined; // let a later call retry
        throw err;
      });
    }
    return this.readying;
  }

  private async connect(): Promise<void> {
    const link = this;
    const transport = {
      // The SDK server calls these; `send` hands a message back to us.
      async start() {},
      async send(msg: unknown) {
        const m = msg as Record<string, unknown>;
        const id = typeof m.id === "number" ? m.id : undefined;
        if (id !== undefined) {
          const resolve = link.pending.get(id);
          if (resolve) {
            link.pending.delete(id);
            resolve(m);
          }
        }
        // Server-initiated notifications (tool list changed, logging) are ignored.
      },
      async close() {
        link.closeServer?.();
      },
      setProtocolVersion() {},
      onmessage: undefined as ((m: unknown) => void) | undefined,
      onclose: undefined as (() => void) | undefined,
      onerror: undefined as ((e: Error) => void) | undefined,
    };
    await this.instance.connect(transport);
    this.toServer = (msg) => transport.onmessage?.(msg);
    this.closeServer = () => transport.onclose?.();

    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "myagens-cli-bridge", version: "1.0.0" },
    });
    this.notify("notifications/initialized");
    this.ready = true;
  }

  private notify(method: string, params?: unknown): void {
    this.toServer?.({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  private request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        const err = msg.error as { message?: string } | undefined;
        if (err) reject(new Error(err.message || `MCP ${method} failed`));
        else resolve((msg.result ?? {}) as Record<string, unknown>);
      });
      this.toServer?.({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    await this.ensureReady();
    const res = await this.request("tools/list", {});
    const tools = res.tools;
    return Array.isArray(tools) ? tools : [];
  }

  async callTool(name: string, args: unknown): Promise<CallToolResult> {
    await this.ensureReady();
    const res = await this.request("tools/call", { name, arguments: args ?? {} });
    return res as unknown as CallToolResult;
  }

  async close(): Promise<void> {
    if (!this.ready) return;
    this.ready = false;
    this.readying = undefined;
    try {
      await this.instance.close?.();
    } catch {
      // A server that objects to being closed must not fail the turn.
    }
  }
}

// ---------------------------------------------------------------------------
// Per-turn session
// ---------------------------------------------------------------------------

class BridgeSession {
  readonly toolCalls: Array<{ name: string; input: unknown }> = [];
  /** Server name -> link, for the SDK MCP servers this turn was given. */
  private links = new Map<string, SdkServerLink>();
  /** Advertised tool name -> where to route it. */
  private routes = new Map<string, { server: string; tool: string }>();
  private tools?: BridgedTool[];
  private listing?: Promise<BridgedTool[]>;
  /**
   * Step key -> canonical tool name, so a PostToolUse result knows what failed.
   * The key is whatever the CLI uses to tie its two hook events together: a
   * numeric step index for agy, a string `tool_use_id` for codex and cursor.
   */
  private steps = new Map<string | number, string>();

  constructor(readonly spec: CliRunSpec) {
    for (const [name, server] of Object.entries(spec.mcpServers ?? {})) {
      // Only in-process SDK servers can be proxied. External stdio/SSE/HTTP
      // connectors (Unreal, Unity, Browser Sketchpad) are configured as real
      // subprocesses/endpoints for the Claude backend and are left out here.
      const instance = (server as { type?: string; instance?: unknown })?.instance;
      if (!instance) {
        log.debug(`${spec.backend} bridge: skipping non-SDK MCP server`, { server: name });
        continue;
      }
      this.links.set(name, new SdkServerLink(instance as never));
    }
  }

  /** Collect every SDK server's tools once, even under concurrent requests. */
  listTools(): Promise<BridgedTool[]> {
    if (this.tools) return Promise.resolve(this.tools);
    this.listing ??= this.collectTools();
    return this.listing;
  }

  private async collectTools(): Promise<BridgedTool[]> {
    const out: BridgedTool[] = [];
    for (const [server, link] of this.links) {
      let tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
      try {
        tools = await link.listTools();
      } catch (err) {
        log.warn(`${this.spec.backend} bridge: could not list tools of an MCP server`, {
          server,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      for (const t of tools) {
        const name = `mcp__${server}__${t.name}`;
        this.routes.set(name, { server, tool: t.name });
        out.push({
          name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        });
      }
    }
    this.tools = out;
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.tools) await this.listTools();
    const route = this.routes.get(name);
    if (!route) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    this.spec.onToolUse(name, args);
    this.toolCalls.push({ name, input: args });

    let input = args;
    if (this.spec.permissionMode !== "bypassPermissions") {
      let decision: PermissionResult;
      try {
        decision = await this.spec.canUseTool(name, args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Permission check failed: ${msg}` }], isError: true };
      }
      if (decision.behavior === "deny") {
        this.spec.onToolResult?.(true);
        // Surfaced to the model as a failed tool call, the same way a denied
        // tool reads on the Claude backend.
        return { content: [{ type: "text", text: decision.message }], isError: true };
      }
      input = decision.updatedInput ?? args;
    }

    const link = this.links.get(route.server);
    if (!link) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    try {
      const result = await link.callTool(route.tool, input);
      this.spec.onToolResult?.(Boolean(result?.isError));
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`${this.spec.backend} bridge: MCP tool call failed`, { tool: name, err: msg });
      this.spec.onToolResult?.(true);
      return { content: [{ type: "text", text: `Tool call failed: ${msg}` }], isError: true };
    }
  }

  /** PreToolUse: one of the CLI's own tools is about to run. */
  async preToolUse(
    tool: string,
    args: Record<string, unknown>,
    stepIdx: string | number | undefined,
  ): Promise<{ decision: "allow" | "deny"; reason?: string; overwrite?: Record<string, unknown> }> {
    // MCP calls are gated at the tool call itself (above), where the real tool
    // name and arguments are known — gating them here too (as the opaque
    // `call_mcp_tool` wrapper agy sends, or the `mcp__server__tool` step codex
    // and cursor send) would prompt the user twice for one call.
    const mapped = this.spec.mapTool(tool, args);
    if (!mapped) {
      // Most unmapped steps are internal bookkeeping, but this is also how a
      // renamed or newly added CLI tool would show up, so leave a trail.
      if (tool !== "call_mcp_tool" && !tool.startsWith("mcp__")) {
        log.debug(`${this.spec.backend} bridge: unmapped tool step`, { tool });
      }
      return { decision: "allow" };
    }

    this.spec.onToolUse(mapped.name, mapped.input);
    this.toolCalls.push({ name: mapped.name, input: mapped.input });
    if (stepIdx !== undefined) this.steps.set(stepIdx, mapped.name);

    if (this.spec.permissionMode === "bypassPermissions") return { decision: "allow" };

    let decision: PermissionResult;
    try {
      decision = await this.spec.canUseTool(mapped.name, mapped.input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { decision: "deny", reason: `Permission check failed: ${msg}` };
    }
    if (decision.behavior === "deny") {
      // The refusal IS this call's result; drop the step so the PostToolUse
      // hook the CLI still fires for it doesn't report a second, clean one.
      if (stepIdx !== undefined) this.steps.delete(stepIdx);
      if (!this.spec.toolResultsFromStream) this.spec.onToolResult?.(true);
      return { decision: "deny", reason: decision.message };
    }
    // An approved-with-edits result (e.g. a rewritten Bash command) is pushed
    // back into the real call through the hook's `overwrite` field.
    const overwrite = mapped.toCliArgs?.(decision.updatedInput ?? mapped.input);
    return overwrite ? { decision: "allow", overwrite } : { decision: "allow" };
  }

  /** PostToolUse: report success/failure so auto_until_error autonomy can escalate. */
  postToolUse(stepIdx: string | number | undefined, error: string | undefined): void {
    if (stepIdx !== undefined && !this.steps.has(stepIdx)) return; // a step we never announced
    if (stepIdx !== undefined) this.steps.delete(stepIdx);
    this.spec.onToolResult?.(Boolean(error));
  }

  async close(): Promise<void> {
    for (const link of this.links.values()) await link.close();
    this.links.clear();
    this.routes.clear();
  }
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

const sessions = new Map<string, BridgeSession>();
let starting: Promise<string> | undefined;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** A step key as sent by a hook: a numeric index (agy) or a tool_use_id string. */
function stepKey(value: unknown): string | number | undefined {
  if (typeof value === "number") return value;
  return typeof value === "string" && value ? value : undefined;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });

  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const session = token ? sessions.get(token) : undefined;
  if (!session) return send(res, 401, { error: "unknown or expired run" });

  let payload: Record<string, unknown>;
  try {
    const raw = await readBody(req);
    payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch (err) {
    return send(res, 400, { error: err instanceof Error ? err.message : "bad request" });
  }

  const path = (req.url ?? "").split("?")[0];
  try {
    if (path === "/tools/list") {
      return send(res, 200, { tools: await session.listTools() });
    }
    if (path === "/tools/call") {
      const name = typeof payload.name === "string" ? payload.name : "";
      const args = (payload.arguments ?? {}) as Record<string, unknown>;
      return send(res, 200, { result: await session.callTool(name, args) });
    }
    if (path === "/hook/pre") {
      const tool = typeof payload.tool === "string" ? payload.tool : "";
      const args = (payload.args ?? {}) as Record<string, unknown>;
      return send(res, 200, await session.preToolUse(tool, args, stepKey(payload.stepIdx)));
    }
    if (path === "/hook/post") {
      const stepIdx = stepKey(payload.stepIdx);
      const error = typeof payload.error === "string" && payload.error ? payload.error : undefined;
      session.postToolUse(stepIdx, error);
      return send(res, 200, {});
    }
    return send(res, 404, { error: "no such endpoint" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("cli bridge request failed", { path, err: msg });
    return send(res, 500, { error: msg });
  }
}

/** Start the loopback server once, returning its base URL. */
function ensureServer(): Promise<string> {
  if (starting) return starting;
  starting = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      void handle(req, res).catch(() => {
        try {
          send(res, 500, { error: "internal error" });
        } catch {
          // Response already sent or socket gone.
        }
      });
    });
    server.on("error", (err) => {
      starting = undefined;
      reject(err);
    });
    server.listen(0, HOST, () => {
      const addr = server.address() as AddressInfo;
      log.debug("cli bridge listening", { port: addr.port });
      resolve(`http://${HOST}:${addr.port}`);
    });
    server.unref();
  });
  return starting;
}

/**
 * Register one CLI turn and return the env values its helper processes need.
 * Always pair with `dispose()` in a finally: the token is what keeps the run's
 * MCP tools and approval callbacks reachable, and it must not outlive the turn.
 */
export async function registerCliRun(spec: CliRunSpec): Promise<CliRunHandle> {
  const url = await ensureServer();
  const token = randomBytes(24).toString("hex");
  const session = new BridgeSession(spec);
  sessions.set(token, session);
  return {
    url,
    token,
    toolCalls: session.toolCalls,
    dispose: () => {
      sessions.delete(token);
      void session.close();
    },
  };
}
