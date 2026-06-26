import { randomBytes } from "node:crypto";
import { Markup, type Telegram } from "telegraf";
import { config } from "../config.js";
import { escapeHtml } from "./formatting.js";
import { log } from "../logger.js";

/** What the user decided about a detected loop. */
export type LoopChoice = "skip" | "once" | "continue";

interface Pending {
  resolve: (choice: LoopChoice) => void;
  timeout: NodeJS.Timeout;
  chatId: number;
  messageId: number;
}

const CB_PREFIX = "loop";

/**
 * Posts the "Loop detected" prompt and bridges its button press back to the
 * blocking canUseTool flow. Mirrors PermissionManager: each request gets a
 * random id embedded in the callback data, and the promise resolves when a
 * matching callback_query arrives (or it times out → continue, the least
 * disruptive default so a momentary inattention doesn't kill a real task).
 */
export class LoopPromptManager {
  private pending = new Map<string, Pending>();

  constructor(private tg: Telegram) {}

  /**
   * Ask the user what to do about a tool call that has repeated `count` times.
   * Resolves with their choice; auto-resolves to "continue" on timeout.
   */
  async request(
    chatId: number,
    toolName: string,
    summary: string,
    count: number,
  ): Promise<LoopChoice> {
    const id = randomBytes(4).toString("hex");
    const text =
      `🔁 <b>Loop detected</b>\n` +
      `<b>${escapeHtml(toolName)}</b> has run the same call <b>${count}×</b> this turn:\n\n` +
      `<pre><code>${escapeHtml(clamp(summary))}</code></pre>\n` +
      `Skip it, allow it once more, or let it keep going?`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback("⏭️ Skip", `${CB_PREFIX}:${id}:skip`),
        Markup.button.callback("1️⃣ Approve once", `${CB_PREFIX}:${id}:once`),
      ],
      [Markup.button.callback("▶️ Continue", `${CB_PREFIX}:${id}:continue`)],
    ]);

    const msg = await this.tg.sendMessage(chatId, text, { parse_mode: "HTML", ...keyboard });

    return new Promise<LoopChoice>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        log.warn("Loop prompt timed out — continuing", { chatId, tool: toolName });
        void this.tg
          .editMessageText(
            chatId,
            msg.message_id,
            undefined,
            `${text}\n\n⏳ <i>Timed out — continuing.</i>`,
            { parse_mode: "HTML" },
          )
          .catch(() => {});
        resolve("continue");
      }, config.APPROVAL_TIMEOUT_MS);

      this.pending.set(id, { resolve, timeout, chatId, messageId: msg.message_id });
    });
  }

  /** Returns true if the callback was a loop-prompt button this manager owns. */
  isLoopCallback(data: string): boolean {
    return data.startsWith(`${CB_PREFIX}:`);
  }

  /** Resolve a pending loop prompt from a callback_query; returns a toast. */
  async resolve(data: string): Promise<string> {
    const [, id, action] = data.split(":");
    const entry = this.pending.get(id);
    if (!entry) return "This prompt has expired.";

    clearTimeout(entry.timeout);
    this.pending.delete(id);

    const choice = (action as LoopChoice) ?? "continue";
    const label =
      choice === "skip"
        ? "⏭️ Skipped"
        : choice === "once"
          ? "1️⃣ Allowed once"
          : "▶️ Continuing";

    await this.tg
      .editMessageReplyMarkup(entry.chatId, entry.messageId, undefined, undefined)
      .catch(() => {});
    await this.tg
      .sendMessage(entry.chatId, label, { reply_parameters: { message_id: entry.messageId } })
      .catch(() => {});

    entry.resolve(choice);
    return label;
  }
}

/** Max characters of the call summary shown in the prompt. */
const MAX_DESC = 350;

function clamp(s: string): string {
  return s.length > MAX_DESC ? s.slice(0, MAX_DESC) + "\n…(truncated)" : s;
}
