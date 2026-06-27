import { randomBytes } from "node:crypto";
import { Markup, type Telegram } from "telegraf";
import { config } from "../config.js";
import { escapeHtml } from "./formatting.js";
import { log } from "../logger.js";
import { isHexId, CALLBACK_MAX_BYTES } from "./callback.js";

/** One option of an AskUserQuestion question. */
interface AskOption {
  label: string;
  description?: string;
}

/** One normalized question from the AskUserQuestion tool input. */
interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskOption[];
}

/** State for a single question currently awaiting the user's answer. */
interface PendingQuestion {
  chatId: number;
  messageId: number;
  question: AskQuestion;
  /** Indices the user has toggled on (multiSelect); single-select resolves immediately. */
  selected: Set<number>;
  /** True once an "Other" button armed free-text capture for this question. */
  awaitingText: boolean;
  resolve: (answer: string) => void;
  timeout: NodeJS.Timeout;
}

const CB_PREFIX = "askq";

/** Telegram inline-button label cap (chars). Keep some headroom. */
const BTN_MAX = 60;

/**
 * Renders the built-in AskUserQuestion tool as Telegram inline buttons (with a
 * free-text "Other" fallback) and bridges the user's answer back to the blocking
 * canUseTool flow. Mirrors PermissionManager / LoopPromptManager: each pending
 * question gets a random id embedded in the callback data and a promise that
 * resolves on a matching callback_query (or a typed reply, or a timeout).
 *
 * Questions in one tool call are asked sequentially (one keyboard at a time) so
 * the inline keyboards don't collide; the collected answers are formatted into a
 * single string that is returned to the model as the tool result.
 */
export class AskQuestionManager {
  private pending = new Map<string, PendingQuestion>();

  constructor(private tg: Telegram) {}

  /**
   * Ask all questions in an AskUserQuestion tool input and return a formatted
   * answer string suitable for handing back to the model as the tool result.
   */
  async ask(chatId: number, input: unknown): Promise<string> {
    const questions = parseAskInput(input);
    if (questions.length === 0) {
      return "The user was not shown any question (the tool input had no questions).";
    }

    const parts: string[] = [];
    for (const q of questions) {
      const answer = await this.askOne(chatId, q);
      parts.push(`Q: ${q.question}\nA: ${answer}`);
    }
    return `The user answered:\n\n${parts.join("\n\n")}`;
  }

  /** Render and await one question. */
  private askOne(chatId: number, question: AskQuestion): Promise<string> {
    return new Promise<string>((resolve) => {
      void this.post(chatId, question, resolve);
    });
  }

  private async post(
    chatId: number,
    question: AskQuestion,
    resolve: (answer: string) => void,
  ): Promise<void> {
    const id = randomBytes(4).toString("hex");
    const text = renderQuestion(question);
    const selected = new Set<number>();

    const msg = await this.tg.sendMessage(chatId, text, {
      parse_mode: "HTML",
      ...this.keyboard(id, question, selected),
    });

    const timeout = setTimeout(() => {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      const fallback = question.options[0]?.label ?? "(no answer)";
      log.warn("AskUserQuestion timed out — using default", { chatId, header: question.header });
      void this.tg
        .editMessageText(
          chatId,
          msg.message_id,
          undefined,
          `${text}\n\n⏳ <i>Timed out — defaulted to "${escapeHtml(fallback)}".</i>`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});
      entry.resolve(`${fallback} (no reply, defaulted on timeout)`);
    }, config.APPROVAL_TIMEOUT_MS);
    timeout.unref?.();

    this.pending.set(id, {
      chatId,
      messageId: msg.message_id,
      question,
      selected,
      awaitingText: false,
      resolve,
      timeout,
    });
  }

  /** Build the inline keyboard for a question (option buttons + Other [+ Done]). */
  private keyboard(id: string, question: AskQuestion, selected: Set<number>) {
    const rows = question.options.map((opt, i) => {
      const mark = question.multiSelect && selected.has(i) ? "✅ " : "";
      return [Markup.button.callback(`${mark}${btnLabel(opt.label)}`, `${CB_PREFIX}:${id}:o:${i}`)];
    });
    rows.push([Markup.button.callback("✏️ Other (type a reply)", `${CB_PREFIX}:${id}:other`)]);
    if (question.multiSelect) {
      rows.push([Markup.button.callback("✔️ Done", `${CB_PREFIX}:${id}:done`)]);
    }
    return Markup.inlineKeyboard(rows);
  }

  /** Returns true if the callback is an ask-question button this manager owns. */
  isAskCallback(data: string): boolean {
    return data.startsWith(`${CB_PREFIX}:`);
  }

  /** Resolve (or progress) a pending question from a callback_query; returns a toast. */
  async resolve(data: string): Promise<string> {
    if (Buffer.byteLength(data, "utf8") > CALLBACK_MAX_BYTES) return "This question has expired.";
    const segs = data.split(":");
    if (segs.length < 3 || segs.length > 4) return "This question has expired.";
    const [, id, kind, idxStr] = segs;
    if (!isHexId(id)) return "This question has expired.";
    const entry = this.pending.get(id);
    if (!entry) return "This question has expired.";
    const { question } = entry;

    if (kind === "other") {
      entry.awaitingText = true;
      await this.tg
        .sendMessage(entry.chatId, "✏️ Type your answer as a normal message.", {
          reply_parameters: { message_id: entry.messageId },
        })
        .catch(() => {});
      return "Type your answer";
    }

    if (kind === "o") {
      const idx = Number(idxStr);
      const opt = question.options[idx];
      if (!opt) return "Unknown option.";
      if (question.multiSelect) {
        // Toggle and re-render; wait for Done to confirm.
        if (entry.selected.has(idx)) entry.selected.delete(idx);
        else entry.selected.add(idx);
        await this.tg
          .editMessageReplyMarkup(
            entry.chatId,
            entry.messageId,
            undefined,
            this.keyboard(id, question, entry.selected).reply_markup,
          )
          .catch(() => {});
        return entry.selected.has(idx) ? `Selected ${opt.label}` : `Unselected ${opt.label}`;
      }
      // Single-select: resolve immediately.
      await this.finalize(id, opt.label);
      return `✅ ${opt.label}`;
    }

    if (kind === "done") {
      if (entry.selected.size === 0) return "Pick at least one option first.";
      const labels = [...entry.selected].sort((a, b) => a - b).map((i) => question.options[i].label);
      await this.finalize(id, labels.join(", "));
      return `✅ ${labels.join(", ")}`;
    }

    return "Unknown action.";
  }

  /** Whether a pending question for this chat is armed for a free-text answer. */
  hasPendingText(chatId: number): boolean {
    for (const e of this.pending.values()) {
      if (e.chatId === chatId && e.awaitingText) return true;
    }
    return false;
  }

  /** Whether any question for this chat is awaiting the user (button or text). */
  hasPending(chatId: number): boolean {
    for (const e of this.pending.values()) {
      if (e.chatId === chatId) return true;
    }
    return false;
  }

  /**
   * Consume a typed free-text answer for the oldest text-armed question in a
   * chat. Returns true if one was found and resolved.
   */
  resolveText(chatId: number, text: string): boolean {
    for (const [id, e] of this.pending) {
      if (e.chatId === chatId && e.awaitingText) {
        void this.finalize(id, text);
        return true;
      }
    }
    return false;
  }

  /** Clear the keyboard, post a confirmation, and resolve the question promise. */
  private async finalize(id: string, answer: string): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timeout);
    this.pending.delete(id);
    await this.tg
      .editMessageReplyMarkup(entry.chatId, entry.messageId, undefined, undefined)
      .catch(() => {});
    await this.tg
      .sendMessage(entry.chatId, `🗣️ <b>${escapeHtml(entry.question.header)}:</b> ${escapeHtml(answer)}`, {
        parse_mode: "HTML",
        reply_parameters: { message_id: entry.messageId },
      })
      .catch(() => {});
    entry.resolve(answer);
  }
}

/** Render a question's body (header + question + numbered option descriptions). */
function renderQuestion(q: AskQuestion): string {
  const lines = [`❓ <b>${escapeHtml(q.header)}</b>`, escapeHtml(q.question)];
  const described = q.options.filter((o) => o.description && o.description.trim());
  if (described.length > 0) {
    lines.push("");
    for (const o of described) {
      lines.push(`• <b>${escapeHtml(o.label)}</b> — ${escapeHtml(o.description as string)}`);
    }
  }
  if (q.multiSelect) lines.push("\n<i>Pick one or more, then tap Done.</i>");
  return lines.join("\n");
}

/** Truncate a long option label so it fits a Telegram inline button. */
function btnLabel(label: string): string {
  return label.length > BTN_MAX ? label.slice(0, BTN_MAX - 1) + "…" : label;
}

/**
 * Defensively normalize the AskUserQuestion tool input into our shape. The SDK
 * input is `{ questions: [{ question, header, multiSelect, options: [{label, description}] }] }`.
 */
function parseAskInput(input: unknown): AskQuestion[] {
  const raw = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw) {
    const obj = (q ?? {}) as Record<string, unknown>;
    const question = typeof obj.question === "string" ? obj.question : "";
    if (!question) continue;
    const header = typeof obj.header === "string" && obj.header.trim() ? obj.header : "Question";
    const optsRaw = Array.isArray(obj.options) ? obj.options : [];
    const options: AskOption[] = [];
    for (const o of optsRaw) {
      const oo = (o ?? {}) as Record<string, unknown>;
      if (typeof oo.label === "string" && oo.label.trim()) {
        options.push({
          label: oo.label,
          description: typeof oo.description === "string" ? oo.description : undefined,
        });
      }
    }
    out.push({ question, header, multiSelect: obj.multiSelect === true, options });
  }
  return out;
}
