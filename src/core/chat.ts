import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { runTurn, AUTO_ALLOWED_TOOLS, type PermissionResult } from "../claude/runner.js";
import { memoryMcp } from "../mcp/memory.js";
import { tasksMcp } from "../mcp/tasks.js";
import { resolveMainRun } from "./mainSettings.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";
import { log } from "../logger.js";

const FILE = "chat.json";
const HISTORY_CAP = 200;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  error?: boolean;
  costUsd?: number;
}

interface ChatFile {
  version: 1;
  sessionId?: string;
  cwd?: string;
  /** User-chosen auto (bypass) mode. Only honoured when PANEL_CHAT_BYPASS. */
  auto?: boolean;
  messages: ChatMessage[];
}

interface Pending {
  tool: string;
  resolve: (r: PermissionResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Broadcaster = (msg: unknown) => void;

/**
 * A single, persistent Claude session driven from the panel chat view — its own
 * resume token + cwd, separate from any Telegram chat. Default permission model
 * is safe: read-only tools auto-run, anything risky is held behind an in-panel
 * approve/deny prompt. "auto" (bypassPermissions) is only reachable when
 * PANEL_CHAT_BYPASS is set in the env.
 */
export class ChatManager {
  private state = loadJson<ChatFile>(FILE, { version: 1, messages: [] });
  private busy = false;
  private abort?: AbortController;
  private pending = new Map<string, Pending>();
  private broadcast: Broadcaster = () => {};

  start(broadcast: Broadcaster): void {
    this.broadcast = broadcast;
  }

  isEnabled(): boolean {
    return config.PANEL_CHAT_ENABLED;
  }

  private get bypassAllowed(): boolean {
    return config.PANEL_CHAT_BYPASS;
  }

  private get autoActive(): boolean {
    return this.bypassAllowed && Boolean(this.state.auto);
  }

  /** Panel-facing snapshot. */
  view() {
    return {
      enabled: this.isEnabled(),
      messages: this.state.messages,
      cwd: this.state.cwd ?? config.WORKDIR,
      busy: this.busy,
      bypassAllowed: this.bypassAllowed,
      auto: this.autoActive,
      hasContext: Boolean(this.state.sessionId),
    };
  }

  setCwd(cwd: string): void {
    this.state.cwd = cwd.trim() || undefined;
    this.persist();
  }

  /** Toggle auto/bypass mode. Forced off unless the env unlocks it. */
  setAuto(auto: boolean): void {
    this.state.auto = this.bypassAllowed ? auto : false;
    this.persist();
  }

  /** Start a fresh conversation (drop resume token + history). */
  clear(): void {
    this.abort?.abort();
    this.state.sessionId = undefined;
    this.state.messages = [];
    this.persist();
    audit("chat.clear", {});
    this.broadcast({ type: "chat", event: "cleared" });
  }

  stop(): void {
    this.abort?.abort();
  }

  resolveApproval(id: string, allow: boolean): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(
      allow
        ? { behavior: "allow", updatedInput: {} }
        : { behavior: "deny", message: "Denied in panel" },
    );
    this.broadcast({ type: "chat", event: "approval-resolved", approvalId: id, allow });
    return true;
  }

  /** Send a user message and stream the assistant turn. */
  send(text: string): { ok: boolean; error?: string } {
    if (!this.isEnabled()) return { ok: false, error: "disabled" };
    if (this.busy) return { ok: false, error: "busy" };
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "empty" };

    const userMsg: ChatMessage = {
      id: randomBytes(4).toString("hex"),
      role: "user",
      text: trimmed,
      ts: Date.now(),
    };
    this.append(userMsg);
    audit("chat.send", { chars: trimmed.length, auto: this.autoActive });
    this.broadcast({ type: "chat", event: "user", message: userMsg });

    this.busy = true;
    this.abort = new AbortController();
    this.broadcast({ type: "chat", event: "busy", busy: true });
    void this.run(trimmed, this.abort);
    return { ok: true };
  }

  private async run(prompt: string, abort: AbortController): Promise<void> {
    const id = randomBytes(4).toString("hex");
    const assistant: ChatMessage = { id, role: "assistant", text: "", ts: Date.now() };
    this.broadcast({ type: "chat", event: "start", id });
    const { model, env } = resolveMainRun();

    try {
      const res = await runTurn({
        prompt,
        cwd: this.state.cwd ?? config.WORKDIR,
        resume: this.state.sessionId,
        model,
        env,
        permissionMode: this.autoActive ? "bypassPermissions" : "default",
        abortController: abort,
        mcpServers: { memory: memoryMcp, tasks: tasksMcp },
        canUseTool: (name, input) => this.canUseTool(name, input, abort),
        onText: (delta) => {
          assistant.text += delta;
          this.broadcast({ type: "chat", event: "delta", id, delta });
        },
        onToolUse: (name, input) => {
          this.broadcast({ type: "chat", event: "tool", id, tool: name, arg: summarize(input) });
        },
        onSessionId: (sid) => {
          this.state.sessionId = sid;
        },
      });
      assistant.error = res.isError;
      assistant.costUsd = res.costUsd;
      if (res.isError && res.text) assistant.text ||= res.text;
    } catch (err) {
      assistant.error = true;
      if (!abort.signal.aborted) {
        assistant.text ||= err instanceof Error ? err.message : String(err);
        log.error("Panel chat turn failed", { error: assistant.text });
      } else {
        assistant.text ||= "Stopped.";
      }
    } finally {
      // Reject any approvals left dangling by an aborted/finished turn.
      for (const [pid] of this.pending) this.resolveApproval(pid, false);
      assistant.ts = Date.now();
      this.append(assistant);
      this.busy = false;
      this.abort = undefined;
      this.persist();
      this.broadcast({ type: "chat", event: "end", message: assistant });
      this.broadcast({ type: "chat", event: "busy", busy: false });
    }
  }

  private canUseTool(
    name: string,
    input: Record<string, unknown>,
    abort: AbortController,
  ): Promise<PermissionResult> {
    if (AUTO_ALLOWED_TOOLS.has(name) || this.autoActive) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    const approvalId = randomBytes(4).toString("hex");
    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approvalId);
        this.broadcast({ type: "chat", event: "approval-resolved", approvalId, allow: false });
        resolve({ behavior: "deny", message: "Approval timed out" });
      }, config.APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      // Resolve with the model's input on allow (we send {} from the button).
      const wrapped = (r: PermissionResult): void =>
        resolve(r.behavior === "allow" ? { behavior: "allow", updatedInput: input } : r);
      this.pending.set(approvalId, { tool: name, resolve: wrapped, timer });
      abort.signal.addEventListener("abort", () => {
        if (this.pending.delete(approvalId)) {
          clearTimeout(timer);
          resolve({ behavior: "deny", message: "Aborted" });
        }
      });
      this.broadcast({
        type: "chat",
        event: "approval",
        approvalId,
        tool: name,
        arg: summarize(input),
      });
    });
  }

  private append(m: ChatMessage): void {
    this.state.messages.push(m);
    if (this.state.messages.length > HISTORY_CAP) {
      this.state.messages = this.state.messages.slice(-HISTORY_CAP);
    }
  }

  private persist(): void {
    saveJson<ChatFile>(FILE, this.state);
  }
}

function summarize(input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  return String(o.command ?? o.file_path ?? o.pattern ?? o.path ?? o.url ?? "").slice(0, 120);
}

export const chat = new ChatManager();
