import { randomBytes } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import { log } from "../logger.js";
import { askQueue } from "../core/askQueue.js";
import { parseAskInput, type AskQuestion } from "../core/askInput.js";
import { escapeSlackMrkdwn } from "./formatting.js";

/** State for a single question currently awaiting the user's answer. */
interface PendingQuestion {
  channel: string;
  ts: string;
  question: AskQuestion;
  /** Indices the user has toggled on (multiSelect); single-select resolves immediately. */
  selected: Set<number>;
  /** True once an "Other…" button armed free-text capture for this question. */
  awaitingText: boolean;
  resolve: (answer: string) => void;
  timeout: NodeJS.Timeout;
}

const ACTION_PREFIX = "askq";

/** Slack Block Kit button text cap (chars). Keep some headroom. */
const BTN_MAX = 70;

/**
 * Renders the built-in AskUserQuestion tool as Slack Block Kit buttons (with a
 * free-text "Other…" fallback) and bridges the user's answer back to the
 * blocking canUseTool flow. Mirrors telegram/askQuestion.ts's
 * AskQuestionManager: each pending question gets a random id embedded in the
 * button action_id and a promise that resolves on a matching block action (or
 * a typed reply, or a timeout).
 *
 * Questions in one tool call are asked sequentially (one message at a time) so
 * the button sets don't collide; the collected answers are formatted into a
 * single string that is returned to the model as the tool result.
 */
export class SlackAskQuestionManager {
  private pending = new Map<string, PendingQuestion>();

  constructor(private web: WebClient) {
    // Let the panel answer the same pending questions the Slack buttons settle.
    askQueue.attach((id, answer) => this.resolveFromPanel(id, answer));
  }

  /**
   * Ask all questions in an AskUserQuestion tool input and return a formatted
   * answer string suitable for handing back to the model as the tool result.
   */
  async ask(channel: string, input: unknown): Promise<string> {
    const questions = parseAskInput(input);
    if (questions.length === 0) {
      return "The user was not shown any question (the tool input had no questions).";
    }

    const parts: string[] = [];
    for (const q of questions) {
      const answer = await this.askOne(channel, q);
      parts.push(`Q: ${q.question}\nA: ${answer}`);
    }
    return `The user answered:\n\n${parts.join("\n\n")}`;
  }

  /** Render and await one question. */
  private askOne(channel: string, question: AskQuestion): Promise<string> {
    return new Promise<string>((resolve) => {
      void this.post(channel, question, resolve);
    });
  }

  private async post(channel: string, question: AskQuestion, resolve: (answer: string) => void): Promise<void> {
    const id = randomBytes(4).toString("hex");
    const selected = new Set<number>();

    let ts: string;
    try {
      const res = await this.web.chat.postMessage({
        channel,
        text: `Question: ${question.header}`,
        blocks: this.buildBlocks(id, question, selected),
      });
      if (!res.ts) throw new Error("no message ts returned");
      ts = res.ts;
    } catch (err) {
      // If the question can't even be posted, resolve with the default answer
      // rather than leaving the SDK turn blocked forever on the canUseTool
      // promise — that would wedge the session busy until the user noticed.
      log.warn("AskUserQuestion send failed (Slack) — using default", {
        channel,
        header: question.header,
        error: String(err),
      });
      const fallback = question.options[0]?.label ?? "(no answer)";
      resolve(`${fallback} (question could not be delivered)`);
      return;
    }

    const timeout = setTimeout(() => {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      askQueue.remove(id);
      const fallback = question.options[0]?.label ?? "(no answer)";
      log.warn("AskUserQuestion timed out (Slack) — using default", { channel, header: question.header });
      void this.web.chat
        .update({
          channel: entry.channel,
          ts: entry.ts,
          text: `Question: ${question.header}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `${renderQuestion(question)}\n\n_Timed out — defaulted to "${escapeSlackMrkdwn(fallback)}"._`,
              },
            },
          ],
        })
        .catch(() => {});
      entry.resolve(`${fallback} (no reply, defaulted on timeout)`);
    }, config.APPROVAL_TIMEOUT_MS || 300000);
    timeout.unref?.();

    this.pending.set(id, { channel, ts, question, selected, awaitingText: false, resolve, timeout });

    // Mirror the question into the panel so the President can answer it from
    // the browser too (the same promise the Slack buttons settle).
    askQueue.add({
      id,
      chatId: 0,
      agentId: "slack",
      header: question.header,
      question: question.question,
      multiSelect: question.multiSelect,
      options: question.options.map((o) => ({ label: o.label, description: o.description })),
      ts: Date.now(),
    });
  }

  /** Build the Block Kit message for a question (text section + option buttons). */
  private buildBlocks(id: string, question: AskQuestion, selected: Set<number>): any[] {
    const elements: any[] = question.options.map((opt, i) => ({
      type: "button",
      text: { type: "plain_text", text: btnLabel(`${question.multiSelect && selected.has(i) ? "✅ " : ""}${opt.label}`) },
      value: String(i),
      action_id: `${ACTION_PREFIX}_${id}_o_${i}`,
    }));
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Other…" },
      value: "other",
      action_id: `${ACTION_PREFIX}_${id}_other`,
    });
    if (question.multiSelect) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "Done" },
        style: "primary",
        value: "done",
        action_id: `${ACTION_PREFIX}_${id}_done`,
      });
    }

    return [
      { type: "section", text: { type: "mrkdwn", text: renderQuestion(question) } },
      { type: "actions", elements },
    ];
  }

  /** Returns true if the action_id is an ask-question button this manager owns. */
  isAskAction(actionId: string): boolean {
    return actionId.startsWith(`${ACTION_PREFIX}_`);
  }

  /** Handle a Block Kit button click for a pending question. */
  async handleAction(actionId: string): Promise<void> {
    const match = actionId.match(/^askq_([0-9a-f]+)_(o|other|done)(?:_(\d+))?$/);
    if (!match) return;
    const [, id, kind, idxStr] = match;
    const entry = this.pending.get(id);
    if (!entry) return;
    const { question } = entry;

    if (kind === "other") {
      entry.awaitingText = true;
      await this.web.chat.postMessage({ channel: entry.channel, text: "Type your answer:" }).catch(() => {});
      return;
    }

    if (kind === "o") {
      const idx = Number(idxStr);
      const opt = question.options[idx];
      if (!opt) return;
      if (question.multiSelect) {
        // Toggle and re-render; wait for Done to confirm.
        if (entry.selected.has(idx)) entry.selected.delete(idx);
        else entry.selected.add(idx);
        await this.web.chat
          .update({
            channel: entry.channel,
            ts: entry.ts,
            text: `Question: ${question.header}`,
            blocks: this.buildBlocks(id, question, entry.selected),
          })
          .catch(() => {});
        return;
      }
      // Single-select: resolve immediately.
      await this.finalize(id, opt.label);
      return;
    }

    if (kind === "done") {
      if (entry.selected.size === 0) return;
      const labels = [...entry.selected].sort((a, b) => a - b).map((i) => question.options[i].label);
      await this.finalize(id, labels.join(", "));
    }
  }

  /** Whether a pending question for this channel is armed for a free-text answer. */
  hasPendingText(channel: string): boolean {
    for (const e of this.pending.values()) {
      if (e.channel === channel && e.awaitingText) return true;
    }
    return false;
  }

  /** Whether any question for this channel is awaiting the user (button or text). */
  hasPending(channel: string): boolean {
    for (const e of this.pending.values()) {
      if (e.channel === channel) return true;
    }
    return false;
  }

  /**
   * Consume a typed free-text answer for the oldest text-armed question in a
   * channel. Returns true if one was found and resolved.
   */
  resolveText(channel: string, text: string): boolean {
    for (const [id, e] of this.pending) {
      if (e.channel === channel && e.awaitingText) {
        void this.finalize(id, text);
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve a pending question from the panel. `optionIndices` taps option
   * buttons by index (one for single-select, any number for multiSelect);
   * `text` answers the free-text "Other" path. Returns true if a matching
   * pending question was found and resolved. Mirrors the Slack button flow in
   * handleAction(), settling the same promise.
   */
  resolveFromPanel(id: string, answer: { optionIndices?: number[]; text?: string }): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    const { question } = entry;
    const text = answer.text?.trim();
    if (text) {
      void this.finalize(id, text);
      return true;
    }
    const idxs = (answer.optionIndices ?? []).filter((i) => question.options[i]);
    if (idxs.length === 0) return false;
    if (!question.multiSelect) {
      void this.finalize(id, question.options[idxs[0]].label);
      return true;
    }
    const labels = [...new Set(idxs)].sort((a, b) => a - b).map((i) => question.options[i].label);
    void this.finalize(id, labels.join(", "));
    return true;
  }

  /** Clear the buttons, post a confirmation, and resolve the question promise. */
  private async finalize(id: string, answer: string): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timeout);
    this.pending.delete(id);
    askQueue.remove(id);
    await this.web.chat
      .update({
        channel: entry.channel,
        ts: entry.ts,
        text: `Question: ${entry.question.header}`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `${renderQuestion(entry.question)}\n\n✅ *${escapeSlackMrkdwn(answer)}*` },
          },
        ],
      })
      .catch(() => {});
    entry.resolve(answer);
  }
}

/** Render a question's body (header + question + option descriptions) as Slack mrkdwn. */
function renderQuestion(q: AskQuestion): string {
  const lines = [`❓ *${escapeSlackMrkdwn(q.header)}*`, escapeSlackMrkdwn(q.question)];
  const described = q.options.filter((o) => o.description && o.description.trim());
  if (described.length > 0) {
    lines.push("");
    for (const o of described) {
      lines.push(`• *${escapeSlackMrkdwn(o.label)}* — ${escapeSlackMrkdwn(o.description as string)}`);
    }
  }
  if (q.multiSelect) lines.push("\n_Tap to toggle options, then Done._");
  return lines.join("\n");
}

/** Truncate a long option label so it fits a Slack button. */
function btnLabel(label: string): string {
  return label.length > BTN_MAX ? label.slice(0, BTN_MAX - 1) + "…" : label;
}
