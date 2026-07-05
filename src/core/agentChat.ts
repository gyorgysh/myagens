/**
 * AgentChat — interactive panel chat with a specific worker / Lead.
 *
 * The main panel Chat (see chat.ts / chatBridge.ts) mirrors the President's
 * Telegram conversation with Atlas. This module adds a separate, panel-only
 * interactive chat with any individual worker (specialist, Lead, or Assistant)
 * so the President can talk to a single agent in its own persona, cwd, model,
 * provider and domain context, with a resumable session per agent.
 *
 * Each agent gets its own session (resume token + transcript). The resume token
 * is persisted to disk per-agent (agentChat.json) so a Lead conversation
 * survives a restart, mirroring how the main Telegram session stores its
 * sessionId in state.json. The transcript stays in-memory (cheap to lose, and
 * the resumed Claude context carries the real continuity). Turns run with
 * `bypassPermissions` (this is the President driving from the trusted panel) and
 * stream live to all panel clients over the hub using `agentchat` frames, keyed
 * by `agentId` so the UI can route them to the right tab.
 */

import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { PLANNING_PREAMBLE, isPlanningPrompt, stripPlanningPreamble } from "./planningMode.js";

import { isStaleSession, type ImageInput } from "../claude/runner.js";
import { getBackend } from "./backends.js";
import { agentUsage } from "./agentUsage.js";
import { workers, type Worker } from "./workers.js";
import { resolveAvatarSlug } from "./avatar.js";
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
import { toolDiffMeta } from "../telegram/formatting.js";
import { agentAsks } from "./agentAskQuestion.js";

export interface AgentChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  error?: boolean;
  costUsd?: number;
  /** True when this user message was sent in planning mode (preamble stripped). */
  planning?: boolean;
}

type Broadcaster = (msg: unknown) => void;

const HISTORY_CAP = 200;

/** On-disk store: just the per-agent resume token, so chats survive restarts. */
const RESUME_FILE = "agentChat.json";
interface ResumeFile {
  version: 1;
  /** agentId → Claude resume token. */
  resume: Record<string, string>;
}

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
  /** Persisted agentId → resume token, loaded once at construction. */
  private persistedResume: Record<string, string>;

  constructor() {
    this.persistedResume = loadJson<ResumeFile>(RESUME_FILE, { version: 1, resume: {} }).resume ?? {};
  }

  start(broadcast: Broadcaster): void {
    this.broadcast = broadcast;
  }

  isEnabled(): boolean {
    return config.PANEL_CHAT_ENABLED;
  }

  private session(agentId: string): AgentSession {
    let s = this.sessions.get(agentId);
    if (!s) {
      // Rehydrate the Claude resume token from disk so a chat continues its
      // conversation after a restart (the transcript itself starts empty).
      s = { messages: [], busy: false, resume: this.persistedResume[agentId] };
      this.sessions.set(agentId, s);
    }
    return s;
  }

  /** Persist all live agents' resume tokens to disk (owner-only via jsonStore). */
  private saveResume(): void {
    const resume: Record<string, string> = { ...this.persistedResume };
    for (const [agentId, s] of this.sessions) {
      if (s.resume) resume[agentId] = s.resume;
      else delete resume[agentId];
    }
    this.persistedResume = resume;
    saveJson<ResumeFile>(RESUME_FILE, { version: 1, resume });
  }

  /** Panel-facing snapshot for one agent. */
  view(agentId: string) {
    const w = workers.get(agentId);
    if (!w) return undefined;
    const s = this.session(agentId);
    return {
      agentId,
      name: w.name,
      // Avatar slug for the chat bubbles: the worker's explicit avatar, else the
      // same deterministic default the panel derives from the worker id.
      avatar: resolveAvatarSlug(w.id, w.avatar),
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
    this.saveResume();
    this.broadcast({ type: "agentchat", event: "cleared", agentId });
    audit("agentchat.clear", { agentId });
  }

  stop(agentId: string): void {
    this.sessions.get(agentId)?.abort?.abort();
  }

  /** Send a user message to an agent — drives a single resumable turn.
   *  Optional images ride along as inline vision input for this turn. */
  send(agentId: string, text: string, planning = false, images?: ImageInput[]): { ok: boolean; error?: string } {
    if (!this.isEnabled()) return { ok: false, error: "disabled" };
    const trimmed = text.trim();
    // An image-only message is allowed; otherwise require some text.
    if (!trimmed && !(images && images.length)) return { ok: false, error: "empty" };
    const w = workers.get(agentId);
    if (!w) return { ok: false, error: "no-agent" };
    const s = this.session(agentId);
    if (s.busy) return { ok: false, error: "busy" };
    const prompt = planning ? PLANNING_PREAMBLE + trimmed : trimmed;
    void this.runTurnFor(w, s, prompt, images);
    audit("agentchat.send", { agentId, chars: trimmed.length, planning, images: images?.length ?? 0 });
    return { ok: true };
  }

  private append(s: AgentSession, m: AgentChatMessage): void {
    s.messages.push(m);
    if (s.messages.length > HISTORY_CAP) s.messages = s.messages.slice(-HISTORY_CAP);
  }

  private async runTurnFor(w: Worker, s: AgentSession, text: string, images?: ImageInput[]): Promise<void> {
    const agentId = w.id;
    s.busy = true;
    this.broadcast({ type: "agentchat", event: "busy", agentId, busy: true });
    let retrying = false;

    const planning = isPlanningPrompt(text);
    const display = planning ? stripPlanningPreamble(text) : text;
    const userMsg: AgentChatMessage = { id: rid(), role: "user", text: display, ts: Date.now(), planning: planning || undefined };
    this.append(s, userMsg);
    this.broadcast({ type: "agentchat", event: "user", agentId, message: userMsg });

    const streamId = rid();
    this.broadcast({ type: "agentchat", event: "start", agentId, id: streamId });

    // Compose this agent's context, mirroring how workers.execute builds it so a
    // chat turn behaves like the agent's autonomous runs (persona, domain, etc).
    const skill = w.skillId ? getSkill(w.skillId) : undefined;
    if (skill && w.skillId) recordSkillUse(w.skillId);
    // Lead workers identify as themselves (not Atlas). The protocol block is
    // passed as workerIdentity so it replaces the Atlas personality, not appends.
    const protocol = w.role === "lead" ? getLeadProtocol(w.name, w.portfolio) : undefined;
    const append = [skill?.prompt, w.systemPrompt].filter(Boolean).join("\n\n") || undefined;
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
      // President drives from the trusted panel (bypassPermissions), so caller
      // autonomy is full; but a planning turn still routes delegations to the inbox.
      callerPlanning: isPlanningPrompt(text),
    });

    const abort = new AbortController();
    s.abort = abort;
    let output = "";
    try {
      const res = await getBackend(w.backendId).runTurn({
        prompt: text,
        images,
        cwd: s.cwd || w.cwd || config.WORKDIR,
        model: w.model,
        env,
        resume: s.resume,
        systemPromptAppend: append,
        workerIdentity: protocol,
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
        canUseTool: async (name, input) => {
          if (name === "AskUserQuestion") {
            const answer = await agentAsks.ask(w.name, input);
            return { behavior: "deny", message: answer };
          }
          return { behavior: "allow", updatedInput: input };
        },
        onText: (delta) => {
          output += delta;
          this.broadcast({ type: "agentchat", event: "delta", agentId, id: streamId, delta });
        },
        onToolUse: (name, input) => {
          const arg = preview(typeof input === "string" ? input : JSON.stringify(input), 200);
          const diff = toolDiffMeta(name, input);
          log.info("Tool use", { chatId: 0, tool: name, arg, agentChat: w.name, agentId: w.id, ...(diff ?? {}) });
          this.broadcast({ type: "agentchat", event: "tool", agentId, id: streamId, tool: name, arg, ...(diff ?? {}) });
        },
        onSessionId: (id) => {
          if (id && id !== s.resume) {
            s.resume = id;
            this.saveResume();
          }
        },
      });
      const turnUsage = {
        costUsd: res.costUsd ?? 0,
        durationMs: res.durationMs ?? 0,
        inputTokens: res.tokens?.inputTokens ?? 0,
        outputTokens: res.tokens?.outputTokens ?? 0,
        cacheReadTokens: res.tokens?.cacheReadTokens ?? 0,
        cacheWriteTokens: res.tokens?.cacheWriteTokens ?? 0,
      };
      agentUsage.record(w.name, "agentchat", turnUsage);
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
      if (!stopped && isStaleSession(err) && s.resume) {
        // The stored resume token is no longer valid. Drop it and silently retry
        // the same prompt as a fresh session so the user doesn't have to resend.
        log.warn("Agent chat stale session — clearing resume token and retrying fresh", { agentId });
        s.resume = undefined;
        this.saveResume();
        retrying = true;
        this.broadcast({ type: "agentchat", event: "notice", agentId, text: "Session expired — starting fresh conversation." });
        void this.runTurnFor(w, s, text, images);
        return;
      }
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
      if (!retrying) {
        s.busy = false;
        s.abort = undefined;
        this.broadcast({ type: "agentchat", event: "busy", agentId, busy: false });
      }
    }
  }
}

function rid(): string {
  return randomBytes(4).toString("hex");
}

export const agentChat = new AgentChatManager();
