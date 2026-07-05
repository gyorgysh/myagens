import { randomBytes } from "node:crypto";
import { Markup, type Telegram } from "telegraf";
import { config } from "../config.js";
import { escapeHtml } from "./formatting.js";
import { log } from "../logger.js";
import { isHexId, CALLBACK_MAX_BYTES } from "./callback.js";
import { t, langForChat } from "./i18n/index.js";
import { askQueue } from "../core/askQueue.js";
import { parseAskInput, type AskQuestion } from "../core/askInput.js";

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

  constructor(private tg: Telegram) {
    // Let the panel answer the same pending questions the Telegram buttons settle.
    askQueue.attach((id, answer) => this.resolveFromPanel(id, answer));
  }

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
    const lang = langForChat(chatId);
    const text = renderQuestion(question, lang);
    const selected = new Set<number>();

    let msg;
    try {
      msg = await this.tg.sendMessage(chatId, text, {
        parse_mode: "HTML",
        ...this.keyboard(id, question, selected, lang),
      });
    } catch (err) {
      // If the question can't even be posted (flood limit, network blip, an
      // over-long option list), resolve with the default answer rather than
      // leaving the SDK turn blocked forever on the canUseTool promise — that
      // would wedge the session busy until the user noticed and sent /stop.
      log.warn("AskUserQuestion send failed — using default", { chatId, header: question.header, error: String(err) });
      const fallback = question.options[0]?.label ?? t("ask_no_answer");
      // Best-effort plain-text notice: the original send may have failed on
      // formatting or an oversized keyboard, so a bare message has a real
      // chance of getting through even when the rich one didn't.
      await this.tg
        .sendMessage(chatId, `⚠️ Couldn't show the question "${question.header}" — defaulted to "${fallback}".`)
        .catch(() => {});
      resolve(`${fallback} (question could not be delivered)`);
      return;
    }

    const timeout = setTimeout(() => {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      askQueue.remove(id);
      const fallback = question.options[0]?.label ?? t("ask_no_answer");
      log.warn("AskUserQuestion timed out — using default", { chatId, header: question.header });
      void this.tg
        .editMessageText(
          chatId,
          msg.message_id,
          undefined,
          `${text}\n\n<i>${t("ask_timed_out_default", lang, { fallback: escapeHtml(fallback) })}</i>`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});
      // Tool result handed back to the model stays English for consistency.
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

    // Mirror the question into the panel so the President can answer it from the
    // browser too (the same promise the Telegram buttons settle).
    askQueue.add({
      id,
      chatId,
      header: question.header,
      question: question.question,
      multiSelect: question.multiSelect,
      options: question.options.map((o) => ({ label: o.label, description: o.description })),
      ts: Date.now(),
    });
  }

  /** Build the inline keyboard for a question (option buttons + Other [+ Done]). */
  private keyboard(id: string, question: AskQuestion, selected: Set<number>, lang: string) {
    const rows = question.options.map((opt, i) => {
      const mark = question.multiSelect && selected.has(i) ? "✅ " : "";
      return [Markup.button.callback(`${mark}${btnLabel(opt.label)}`, `${CB_PREFIX}:${id}:o:${i}`)];
    });
    rows.push([Markup.button.callback(t("ask_other_btn", lang), `${CB_PREFIX}:${id}:other`)]);
    if (question.multiSelect) {
      rows.push([Markup.button.callback(t("ask_done_btn", lang), `${CB_PREFIX}:${id}:done`)]);
    }
    return Markup.inlineKeyboard(rows);
  }

  /** Returns true if the callback is an ask-question button this manager owns. */
  isAskCallback(data: string): boolean {
    return data.startsWith(`${CB_PREFIX}:`);
  }

  /** Resolve (or progress) a pending question from a callback_query; returns a toast. */
  async resolve(data: string, chatId?: number): Promise<string> {
    if (Buffer.byteLength(data, "utf8") > CALLBACK_MAX_BYTES) return t("ask_expired");
    const segs = data.split(":");
    if (segs.length < 3 || segs.length > 4) return t("ask_expired");
    const [, id, kind, idxStr] = segs;
    if (!isHexId(id)) return t("ask_expired");
    const entry = this.pending.get(id);
    if (!entry) return t("ask_expired");
    // Scope to the pressing chat so one allow-listed operator can't answer
    // another's question by crafting a callback with its id.
    if (chatId !== undefined && entry.chatId !== chatId) return t("ask_expired");
    const { question } = entry;
    const lang = langForChat(entry.chatId);

    if (kind === "other") {
      entry.awaitingText = true;
      await this.tg
        .sendMessage(entry.chatId, t("ask_type_answer", lang), {
          reply_parameters: { message_id: entry.messageId },
        })
        .catch(() => {});
      return t("ask_type_answer_toast", lang);
    }

    if (kind === "o") {
      const idx = Number(idxStr);
      const opt = question.options[idx];
      if (!opt) return t("ask_unknown_option", lang);
      if (question.multiSelect) {
        // Toggle and re-render; wait for Done to confirm.
        if (entry.selected.has(idx)) entry.selected.delete(idx);
        else entry.selected.add(idx);
        await this.tg
          .editMessageReplyMarkup(
            entry.chatId,
            entry.messageId,
            undefined,
            this.keyboard(id, question, entry.selected, lang).reply_markup,
          )
          .catch(() => {});
        return entry.selected.has(idx)
          ? t("ask_selected", lang, { label: opt.label })
          : t("ask_unselected", lang, { label: opt.label });
      }
      // Single-select: resolve immediately.
      await this.finalize(id, opt.label);
      return `✅ ${opt.label}`;
    }

    if (kind === "done") {
      if (entry.selected.size === 0) return t("ask_pick_one", lang);
      const labels = [...entry.selected].sort((a, b) => a - b).map((i) => question.options[i].label);
      await this.finalize(id, labels.join(", "));
      return `✅ ${labels.join(", ")}`;
    }

    return t("ask_unknown_action", lang);
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

  /**
   * Resolve a pending question from the panel. `optionIndices` taps option
   * buttons by index (one for single-select, any number for multiSelect);
   * `text` answers the free-text "Other" path. Returns true if a matching
   * pending question was found and resolved. Mirrors the Telegram callback flow
   * in resolve(), settling the same promise.
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

  /** Clear the keyboard, post a confirmation, and resolve the question promise. */
  private async finalize(id: string, answer: string): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timeout);
    this.pending.delete(id);
    askQueue.remove(id);
    await this.tg
      .editMessageReplyMarkup(entry.chatId, entry.messageId, undefined, undefined)
      .catch(() => {});
    const lang = langForChat(entry.chatId);
    await this.tg
      .sendMessage(
        entry.chatId,
        t("ask_answer_given", lang, {
          header: escapeHtml(entry.question.header),
          answer: escapeHtml(answer),
        }),
        {
          parse_mode: "HTML",
          reply_parameters: { message_id: entry.messageId },
        },
      )
      .catch(() => {});
    entry.resolve(answer);
  }
}

/** Render a question's body (header + question + numbered option descriptions). */
function renderQuestion(q: AskQuestion, lang: string): string {
  const lines = [`❓ <b>${escapeHtml(q.header)}</b>`, escapeHtml(q.question)];
  const described = q.options.filter((o) => o.description && o.description.trim());
  if (described.length > 0) {
    lines.push("");
    for (const o of described) {
      lines.push(`• <b>${escapeHtml(o.label)}</b> — ${escapeHtml(o.description as string)}`);
    }
  }
  if (q.multiSelect) lines.push(`\n${t("ask_pick_instruction", lang)}`);
  return lines.join("\n");
}

/** Truncate a long option label so it fits a Telegram inline button. */
function btnLabel(label: string): string {
  return label.length > BTN_MAX ? label.slice(0, BTN_MAX - 1) + "…" : label;
}
