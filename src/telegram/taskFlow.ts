import type { Telegram } from "telegraf";
import { taskDelegator } from "../core/taskRunner.js";
import { getTask } from "../core/tasks.js";
import { log } from "../logger.js";
import { parseCallback, isHexId } from "./callback.js";

/**
 * Telegram inline-button flow for failed delegated tasks. When a delegation
 * errors, the president gets a "🔁 Retry" button (callback `task:retry:<id>`)
 * that resets the card to backlog and re-delegates in one tap. Namespaced like
 * the git/project/inbox flows and routed through the shared callback_query
 * handler in bot.ts.
 */

const NS = "task:";

export function isTaskCallback(data: string): boolean {
  return data.startsWith(NS);
}

/** Inline keyboard markup offering a Retry button for a failed card. */
export function retryKeyboard(taskId: string) {
  return {
    inline_keyboard: [[{ text: "🔁 Retry", callback_data: `${NS}retry:${taskId}` }]],
  };
}

/**
 * Resolve a task callback. Returns a short toast for answerCbQuery. On a
 * successful retry it strips the keyboard from the original message so it can't
 * be tapped twice.
 */
export async function resolveTaskCallback(
  tg: Telegram,
  chatId: number,
  data: string,
  messageId?: number,
): Promise<string> {
  const parts = parseCallback(data, NS, 2);
  if (!parts) return "Unknown action";
  const [action, taskId] = parts;
  if (action !== "retry" || !isHexId(taskId)) return "Unknown action";

  const task = getTask(taskId);
  if (!task) return "Task no longer exists";

  const r = taskDelegator.retry(taskId);
  if (!r.ok) return r.error === "already running" ? "Already running" : (r.error ?? "Could not retry");

  log.info("Task retry from Telegram", { taskId, retryCount: r.retryCount });
  // Remove the Retry button so it can't be pressed again for this run.
  if (messageId !== undefined) {
    await tg.editMessageReplyMarkup(chatId, messageId, undefined, { inline_keyboard: [] }).catch(() => {});
  }
  return `Retrying${r.retryCount ? ` (attempt ${r.retryCount + 1})` : ""}…`;
}
