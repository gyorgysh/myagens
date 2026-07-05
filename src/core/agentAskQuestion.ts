import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { askQueue } from "./askQueue.js";
import { parseAskInput, type AskQuestion } from "./askInput.js";

/** State for a single question currently awaiting the President's answer. */
interface PendingQuestion {
  question: AskQuestion;
  resolve: (answer: string) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Renders the built-in AskUserQuestion tool for panel-only interactive chats
 * (per-agent chat, see agentChat.ts) that have no Telegram chat to post
 * buttons into. Mirrors telegram/askQuestion.ts's AskQuestionManager, but the
 * only surface that can answer is the panel: the question is mirrored into the
 * shared `askQueue` (the same one Telegram's inline buttons and the panel's
 * Chat AsksBar use), tagged with the asking agent's id so it renders in that
 * agent's own Command Center pane, and resolves through the existing
 * `/api/asks/resolve` endpoint. Falls back to the first option after a
 * timeout so a turn can never wedge forever.
 */
export class AgentAskManager {
  private pending = new Map<string, PendingQuestion>();

  constructor() {
    askQueue.attach((id, answer) => this.resolveFromPanel(id, answer));
  }

  /**
   * Ask all questions in an AskUserQuestion tool input and return a formatted
   * answer string suitable for handing back to the model as the tool result.
   * `agentId` scopes the question to that agent's own chat pane.
   */
  async ask(agentId: string, input: unknown): Promise<string> {
    const questions = parseAskInput(input);
    if (questions.length === 0) {
      return "The user was not shown any question (the tool input had no questions).";
    }
    const parts: string[] = [];
    for (const q of questions) {
      const answer = await this.askOne(agentId, q);
      parts.push(`Q: ${q.question}\nA: ${answer}`);
    }
    return `The user answered:\n\n${parts.join("\n\n")}`;
  }

  /** Mirror one question into the panel's ask queue and await its resolution. */
  private askOne(agentId: string, question: AskQuestion): Promise<string> {
    return new Promise<string>((resolve) => {
      const id = randomBytes(4).toString("hex");
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        askQueue.remove(id);
        const fallback = question.options[0]?.label ?? "No answer given";
        resolve(`${fallback} (no reply, defaulted on timeout)`);
      }, config.APPROVAL_TIMEOUT_MS);
      timeout.unref?.();

      this.pending.set(id, { question, resolve, timeout });

      // No real Telegram chat backs a panel agent chat, so there's no
      // meaningful chatId to scope this to; 0 marks it as panel-only context
      // (mirrors the `primaryChatId: 0` convention used elsewhere for
      // President-driven panel turns). agentId is what actually scopes it to
      // the right chat pane.
      askQueue.add({
        id,
        chatId: 0,
        agentId,
        header: question.header,
        question: question.question,
        multiSelect: question.multiSelect,
        options: question.options.map((o) => ({ label: o.label, description: o.description })),
        ts: Date.now(),
      });
    });
  }

  /**
   * Resolve a pending question from the panel. `optionIndices` answers by
   * tapping option buttons; `text` answers the "Other" free-text path. Returns
   * true if a matching pending question was found and resolved.
   */
  private resolveFromPanel(id: string, answer: { optionIndices?: number[]; text?: string }): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    const { question } = entry;
    const text = answer.text?.trim();
    if (text) {
      this.finalize(id, text);
      return true;
    }
    const idxs = (answer.optionIndices ?? []).filter((i) => question.options[i]);
    if (idxs.length === 0) return false;
    if (!question.multiSelect) {
      this.finalize(id, question.options[idxs[0]].label);
      return true;
    }
    const labels = [...new Set(idxs)].sort((a, b) => a - b).map((i) => question.options[i].label);
    this.finalize(id, labels.join(", "));
    return true;
  }

  private finalize(id: string, answer: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timeout);
    this.pending.delete(id);
    askQueue.remove(id);
    entry.resolve(answer);
  }
}

export const agentAsks = new AgentAskManager();
