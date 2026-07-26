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
 *
 * A typed reply always answers the open question too (by number, by option
 * text, or as free text). Buttons only reach us when the Slack app has
 * Interactivity turned on, and a question that can only be answered by button
 * would otherwise wedge the whole turn — the model stays blocked in
 * canUseTool, the session stays busy, and every further message the user sends
 * bounces off the busy guard.
 */
export class SlackAskQuestionManager {
  private pending = new Map<string, PendingQuestion>();
  /** Bumped per channel by cancelAll(), so an in-flight ask() stops posting. */
  private cancelEpoch = new Map<string, number>();

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

    // Questions are posted one at a time, so a cancel that lands mid-way has to
    // stop the remaining ones from being posted — otherwise the stop command
    // settles the open question and the next one immediately takes its place.
    const epoch = this.cancelEpoch.get(channel) ?? 0;

    const parts: string[] = [];
    for (const q of questions) {
      if ((this.cancelEpoch.get(channel) ?? 0) !== epoch) {
        parts.push(`Q: ${q.question}\nA: (not asked — the user cancelled)`);
        continue;
      }
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
      // If the question can't even be posted, settle it anyway rather than
      // leaving the SDK turn blocked forever on the canUseTool promise — that
      // would wedge the session busy until the user noticed.
      log.warn("AskUserQuestion send failed (Slack) — no answer collected", {
        channel,
        header: question.header,
        error: String(err),
      });
      // Do not invent an answer here: reporting the first option as the user's
      // choice would have the model act on a decision nobody made.
      resolve("(the question could not be delivered to the user — no answer was given)");
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

    this.pending.set(id, { channel, ts, question, selected, resolve, timeout });
    log.info("AskUserQuestion posted (Slack)", { channel, id, header: question.header, options: question.options.length });

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

    // Slack rejects an actions block with more than 5 elements (invalid_blocks),
    // which four options plus "Other…" plus "Done" would hit — and a rejected
    // post falls back to answering with the first option, an answer the user
    // never gave. Spread them over as many rows as needed instead.
    const blocks: any[] = [{ type: "section", text: { type: "mrkdwn", text: renderQuestion(question) } }];
    for (let i = 0; i < elements.length; i += 5) {
      blocks.push({ type: "actions", elements: elements.slice(i, i + 5) });
    }
    return blocks;
  }

  /** Returns true if the action_id is an ask-question button this manager owns. */
  isAskAction(actionId: string): boolean {
    return actionId.startsWith(`${ACTION_PREFIX}_`);
  }

  /** Handle a Block Kit button click for a pending question. */
  async handleAction(actionId: string): Promise<void> {
    const match = actionId.match(/^askq_([0-9a-f]+)_(o|other|done)(?:_(\d+))?$/);
    if (!match) {
      log.warn("Ask button ignored — unrecognised action id (Slack)", { actionId });
      return;
    }
    const [, id, kind, idxStr] = match;
    const entry = this.pending.get(id);
    if (!entry) {
      // Already settled: answered from the panel or by typing, timed out, or
      // the process restarted. Logged rather than announced, since the message
      // itself already shows the answer it settled on.
      log.warn("Ask button ignored — question no longer pending (Slack)", { actionId, id });
      return;
    }
    const { question } = entry;

    if (kind === "other") {
      await this.web.chat
        .postMessage({ channel: entry.channel, text: "Type your answer as a normal message." })
        .catch(() => {});
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
      if (entry.selected.size === 0) {
        await this.web.chat
          .postMessage({ channel: entry.channel, text: "Pick at least one option first (or just type your answer)." })
          .catch(() => {});
        return;
      }
      const labels = [...entry.selected].sort((a, b) => a - b).map((i) => question.options[i].label);
      await this.finalize(id, labels.join(", "));
    }
  }

  /** Whether any question for this channel is awaiting the user (button or text). */
  hasPending(channel: string): boolean {
    for (const e of this.pending.values()) {
      if (e.channel === channel) return true;
    }
    return false;
  }

  /** Header of the oldest question awaiting an answer in this channel. */
  pendingHeader(channel: string): string | undefined {
    for (const e of this.pending.values()) {
      if (e.channel === channel) return e.question.header;
    }
    return undefined;
  }

  /**
   * Consume a typed reply as the answer to the oldest pending question in a
   * channel. A bare number (or comma-separated numbers, for multiSelect) picks
   * options by their listed position, text matching an option label picks that
   * option, and anything else is passed through as a free-text answer.
   * Returns true if a question was found and resolved.
   */
  answerTyped(channel: string, text: string): boolean {
    for (const [id, e] of this.pending) {
      if (e.channel !== channel) continue;
      const answer = matchOptions(e.question, text) ?? text;
      log.info("AskUserQuestion answered by typed reply (Slack)", { channel, id, header: e.question.header });
      void this.finalize(id, answer);
      return true;
    }
    return false;
  }

  /**
   * Drop every question pending in a channel, unblocking the turn that is
   * waiting on them. Used by the stop command: aborting the SDK run does not settle a
   * canUseTool promise, so without this the session can stay busy forever.
   * Returns how many were cancelled.
   */
  cancelAll(channel: string, reason = "The user cancelled this question."): number {
    this.cancelEpoch.set(channel, (this.cancelEpoch.get(channel) ?? 0) + 1);
    let n = 0;
    for (const [id, e] of [...this.pending]) {
      if (e.channel !== channel) continue;
      clearTimeout(e.timeout);
      this.pending.delete(id);
      askQueue.remove(id);
      void this.web.chat
        .update({
          channel: e.channel,
          ts: e.ts,
          text: `Question: ${e.question.header}`,
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: `${renderQuestion(e.question)}\n\n_Cancelled._` },
            },
          ],
        })
        .catch(() => {});
      e.resolve(reason);
      n += 1;
    }
    if (n > 0) log.info("Pending questions cancelled (Slack)", { channel, count: n });
    return n;
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

/**
 * Render a question's body (header + question + numbered options) as Slack
 * mrkdwn. The options are numbered because a typed reply can pick one by its
 * number, which is the answer path that works even when the Slack app has no
 * Interactivity (so the buttons never fire).
 */
function renderQuestion(q: AskQuestion): string {
  const lines = [`❓ *${escapeSlackMrkdwn(q.header)}*`, escapeSlackMrkdwn(q.question)];
  if (q.options.length > 0) {
    lines.push("");
    q.options.forEach((o, i) => {
      const desc = o.description?.trim() ? ` — ${escapeSlackMrkdwn(o.description.trim())}` : "";
      lines.push(`${i + 1}. *${escapeSlackMrkdwn(o.label)}*${desc}`);
    });
  }
  lines.push(
    q.multiSelect
      ? "\n_Tap to toggle options then Done, or reply with the numbers (e.g. `1,3`)._"
      : "\n_Tap an option, or just reply with its number or your own answer._",
  );
  return lines.join("\n");
}

/**
 * Resolve a typed reply against a question's options: a number (or numbers,
 * for multiSelect) picks by listed position, and text equal to a label picks
 * that option. Returns undefined when the reply is free text.
 */
function matchOptions(q: AskQuestion, text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const byLabel = q.options.find((o) => o.label.toLowerCase() === trimmed.toLowerCase());
  if (byLabel) return byLabel.label;

  const parts = trimmed.split(/[\s,+]+/).filter(Boolean);
  if (!parts.every((p) => /^\d+$/.test(p))) return undefined;
  const idxs = parts.map((p) => Number(p) - 1);
  if (!idxs.every((i) => q.options[i])) return undefined;
  if (!q.multiSelect) return q.options[idxs[0]].label;
  return [...new Set(idxs)]
    .sort((a, b) => a - b)
    .map((i) => q.options[i].label)
    .join(", ");
}

/** Truncate a long option label so it fits a Slack button. */
function btnLabel(label: string): string {
  return label.length > BTN_MAX ? label.slice(0, BTN_MAX - 1) + "…" : label;
}
