/**
 * Owner notifications, independent of any one chat surface.
 *
 * Background subsystems (heartbeat, schedules, task outcomes, self-update, the
 * inbox) all need to tell the owner something. They used to do that by looping
 * `allowedUserIds` and calling `bot.telegram.sendMessage` directly, which made
 * every one of them a hard Telegram dependency — the reason a panel-only or
 * Slack-only install could not work at all.
 *
 * They now hand the message to `notifyOwner()`, and whichever surfaces are
 * actually running pick it up: Telegram registers a channel when its bot is
 * built, Slack when its Socket Mode connection opens, and the panel when its
 * WebSocket hub starts. A message with no channel at all still reaches the log,
 * so a headless install never loses an alert silently.
 */

import type { InlineKeyboardMarkup } from "telegraf/types";
import type { TranslationKey } from "../telegram/i18n/index.js";
import { push } from "./push.js";
import { log } from "../logger.js";

export interface OwnerNotice {
  /** Plain-text body. Every channel can render this, so it is required. */
  text: string;
  /**
   * Telegram-only extras, all optional.
   *
   * `i18n` is the important one: these notices used to be built per recipient
   * with `t(key, langForChat(chatId))`, so passing the key (not a rendered
   * string) keeps every chat in its own language. `html` is the pre-built
   * alternative for notices with no catalogue entry, and must already be
   * escaped. `replyMarkup` carries an inline keyboard (the task-failure Retry
   * button, the update Accept/Reject pair) that other surfaces ignore.
   *
   * Falls back to `text` when none of them is set.
   */
  telegram?: {
    i18n?: { key: TranslationKey; params?: Record<string, string | number> };
    html?: string;
    replyMarkup?: InlineKeyboardMarkup;
    /** Per-recipient keyboard, for buttons whose labels are also translated. */
    replyMarkupFor?: (lang: string) => InlineKeyboardMarkup;
  };
  /** Mirror to subscribed browsers as an OS-level push. Omit to skip. */
  push?: { title: string; kind: string; tag?: string; url?: string };
}

export type NotifyChannel = (notice: OwnerNotice) => Promise<void>;

const channels = new Map<string, NotifyChannel>();

/**
 * Register a delivery channel. Re-registering the same id replaces the previous
 * one, which is what a surface restart (Slack settings changed in the panel)
 * needs — otherwise the dead client would keep receiving alerts.
 */
export function registerNotifyChannel(id: string, channel: NotifyChannel): void {
  channels.set(id, channel);
}

export function unregisterNotifyChannel(id: string): void {
  channels.delete(id);
}

/** Which channels are live. Used by /status-style reporting. */
export function notifyChannels(): string[] {
  return [...channels.keys()];
}

/**
 * Deliver a notice to every live surface. Never throws and never lets one
 * broken surface stop another: a channel that rejects is logged and skipped.
 */
export async function notifyOwner(notice: OwnerNotice): Promise<void> {
  if (notice.push) {
    void push.notify({
      title: notice.push.title,
      body: notice.text,
      kind: notice.push.kind,
      tag: notice.push.tag,
      url: notice.push.url,
    });
  }

  if (channels.size === 0) {
    // No chat surface and no panel client. The log is the only record left, so
    // make it a real one rather than dropping the message on the floor.
    log.info("Owner notice (no delivery channel)", { text: notice.text.slice(0, 500) });
    return;
  }

  await Promise.all(
    [...channels].map(async ([id, channel]) => {
      try {
        await channel(notice);
      } catch (err) {
        log.warn("Owner notice delivery failed", {
          channel: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}
