/**
 * AgentChat — interactive panel chat with a specific worker / Lead.
 *
 * The main panel Chat (see chat.ts / chatBridge.ts) mirrors the President's
 * Telegram conversation with Atlas. This module adds a separate, panel-only
 * interactive chat with any individual worker (specialist, Lead, or Assistant)
 * so the President can talk to a single agent in its own persona, cwd, model,
 * provider and domain context, with a resumable session per agent.
 *
 * Each agent gets its own in-memory session (resume token + transcript). Turns
 * run with `bypassPermissions` (this is the President driving from the trusted
 * panel) and stream live to all panel clients over the hub using `agentchat`
 * frames, keyed by `agentId` so the UI can route them to the right tab.
 */

import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { runTurn } from "../claude/runner.js";
import { workers, type Worker } from "./workers.js";
import { getSkill, recordSkillUse } from "./skills.js";
import { getProvider } from "./providers.js";
import { resolveSecret } from "./vault.js";
import { getLeadProtocol } from "../prompt.js";
import { memoryMcp } from "../mcp/memory.js";
import { createTasksMcp } from "../mcp/tasks.js";
import { skillsMcp } from "../mcp/skills.js";
import { createCrewMcp } from "../mcp/crew.js";
import { audit } from "./audit.js";
import { log, preview } from "../logger.js";

export interface AgentChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  error?: boolean;
  costUsd?: number;
}

type Broadcaster = (msg: unknown) => void;

const HISTORY_CAP = 200;

/** Per-agent in-memory chat state. */
interface AgentSession {
  /** Claude resume token, carried turn to turn for continuity. */
  resume?: string;
  /** Working directory override (defaults to the worker's cwd). */
  cwd?: string;
  messages: AgentChatMessage[];
  busy: boolean;
  abort?: AbortController;
}

export class AgentChatManager {
  private broadcast: Broadcaster = () => {};
  private sessions = new Map<string, AgentSession>();

  start(broadcast: Broadcaster): void {
    this.broadcast = broadcast;
  }

  isEnabled(): boolean {
    return config.PANEL_CHAT_ENABLED;
  }

  private session(agentId: string): AgentSession {
    let s = this.sessions.get(agentId);
    if (!s) {
      s = { messages: [], busy: false };
      this.sessions.set(agentId, s);
    }
    return s;
  }

  /** Panel-facing snapshot for one agent. */
  view(agentId: string) {
    const w = workers.get(agentId);
    if (!w) return undefined;
    const s = this.session(agentId);
    return {
      agentId,
      name: w.name,
      cwd: s.cwd ?? w.cwd,
      messages: s.messages,
      busy: s.busy,
      hasContext: Boolean(s.resume),
    };
  }

  setCwd(agentId: string, cwd: string): void {
    const w = workers.get(agentId);
    if (!w) return;
    const s = this.session(agentId);
    s.cwd = cwd.trim() || w.cwd;
  }

  /** Drop the resume token + transcript so the next turn starts fresh. */
  clear(agentId: string): void {
    const s = this.session(agentId);
    s.abort?.abort();
    s.resume = undefined;
    s.messages = [];
    this.broadcast({ type: "agentchat", event: "cleared", agentId });
    audit("agentchat.clear", { agentId });
  }

  stop(agentId: string): void {
    this.sessions.get(agentId)?.abort?.abort();
  }

  /** Send a user message to an agent — drives a single resumable turn. */
  send(agentId: string, text: string): { ok: boolean; error?: string } {
    if (!this.isEnabled()) return { ok: false, error: "disabled" };
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "empty" };
    const w = workers.get(agentId);
    if (!w) return { ok: false, error: "no-agent" };
    const s = this.session(agentId);
    if (s.busy) return { ok: false, error: "busy" };
    void this.runTurnFor(w, s, trimmed);
    audit("agentchat.send", { agentId, chars: trimmed.length });
    return { ok: true };
  }

  private append(s: AgentSession, m: AgentChatMessage): void {
    s.messages.push(m);
    if (s.messages.length > HISTORY_CAP) s.messages = s.messages.slice(-HISTORY_CAP);
  }

  private async runTurnFor(w: Worker, s: AgentSession, text: string): Promise<void> {
    const agentId = w.id;
    s.busy = true;
    this.broadcast({ type: "agentchat", event: "busy", agentId, busy: true });

    const userMsg: AgentChatMessage = { id: rid(), role: "user", text, ts: Date.now() };
    this.append(s, userMsg);
    this.broadcast({ type: "agentchat", event: "user", agentId, message: userMsg });

    const streamId = rid();
    this.broadcast({ type: "agentchat", event: "start", agentId, id: streamId });

    // Compose this agent's context, mirroring how workers.execute builds it so a
    // chat turn behaves like the agent's autonomous runs (persona, domain, etc).
    const skill = w.skillId ? getSkill(w.skillId) : undefined;
    if (skill && w.skillId) recordSkillUse(w.skillId);
    const protocol = w.role === "lead" ? getLeadProtocol(w.name, w.portfolio) : undefined;
    const append = [protocol, skill?.prompt, w.systemPrompt].filter(Boolean).join("\n\n") || undefined;
    const provider = w.providerId ? getProvider(w.providerId) : undefined;
    const env = provider
      ? {
          ANTHROPIC_BASE_URL: provider.baseUrl,
          ANTHROPIC_AUTH_TOKEN: resolveSecret(provider.authToken),
          ANTHROPIC_API_KEY: undefined,
        }
      : undefined;

    const crewMcp = createCrewMcp({
      notify: async () => {},
      primaryChatId: 0,
      fromAgentId: w.id,
    });

    const abort = new AbortController();
    s.abort = abort;
    let output = "";
    try {
      const res = await runTurn({
        prompt: text,
        cwd: s.cwd || w.cwd || config.WORKDIR,
        model: w.model,
        env,
        resume: s.resume,
        systemPromptAppend: append,
        persona: w.persona,
        language: w.language,
        // The President is driving from the trusted panel, so allow tools.
        permissionMode: "bypassPermissions",
        settingSources: ["user"],
        abortController: abort,
        mcpServers: {
          memory: memoryMcp,
          tasks: createTasksMcp({ createdBy: w.id }),
          skills: skillsMcp,
          crew: crewMcp,
        },
        canUseTool: async (_n, input) => ({ behavior: "allow", updatedInput: input }),
        onText: (delta) => {
          output += delta;
          this.broadcast({ type: "agentchat", event: "delta", agentId, id: streamId, delta });
        },
        onToolUse: (name, input) => {
          const arg = preview(typeof input === "string" ? input : JSON.stringify(input), 200);
          log.info("Tool use", { chatId: 0, tool: name, arg, agentChat: w.name, agentId: w.id });
          this.broadcast({ type: "agentchat", event: "tool", agentId, id: streamId, tool: name, arg });
        },
        onSessionId: (id) => {
          if (id) s.resume = id;
        },
      });
      const assistantMsg: AgentChatMessage = {
        id: streamId,
        role: "assistant",
        text: output || res.text || "",
        ts: Date.now(),
        error: res.isError,
        costUsd: res.costUsd,
      };
      this.append(s, assistantMsg);
      this.broadcast({ type: "agentchat", event: "end", agentId, message: assistantMsg });
    } catch (err) {
      const stopped = abort.signal.aborted;
      const assistantMsg: AgentChatMessage = {
        id: streamId,
        role: "assistant",
        text: stopped ? output : output || (err instanceof Error ? err.message : String(err)),
        ts: Date.now(),
        error: !stopped,
      };
      this.append(s, assistantMsg);
      this.broadcast({ type: "agentchat", event: "end", agentId, message: assistantMsg });
      if (!stopped) log.error("Agent chat turn failed", { agentId, error: assistantMsg.text.slice(0, 300) });
    } finally {
      s.busy = false;
      s.abort = undefined;
      this.broadcast({ type: "agentchat", event: "busy", agentId, busy: false });
    }
  }
}

function rid(): string {
  return randomBytes(4).toString("hex");
}

export const agentChat = new AgentChatManager();
