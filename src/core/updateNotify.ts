import { Markup } from "telegraf";
import { loadJson, saveJson } from "./jsonStore.js";
import { getUpdateStatus } from "./updateControl.js";
import { mainSettingsView } from "./mainSettings.js";
import { notifyOwner } from "./notify.js";
import { escapeHtml } from "../telegram/formatting.js";
import { t, langForChat } from "../telegram/i18n/index.js";
import { log } from "../logger.js";

const FILE = "updateNotify.json";
// Cheap, no-network poll of the cache that src/panel/server.ts already keeps
// fresh (it hits the network every 6h). Polling more often just notices that
// refresh sooner, without doubling the git fetch traffic.
const POLL_MS = 5 * 60_000;

interface UpdateNotifyState {
  /** The remote version we already messaged the president about, so a version
   *  we've already reported (Accepted, or still-pending Reject) isn't repeated
   *  every poll — only a newer version bump re-triggers a message. */
  lastNotifiedVersion?: string;
}

/** True while a version-bump message is outstanding (used to answer the toast
 *  for the Reject button without re-deriving state). */
export function isUpdateNotifyCallback(data: string): boolean {
  return data === "updnotify:reject";
}

export async function resolveUpdateNotifyCallback(chatId: number): Promise<string> {
  return t("updatenotify_rejected", langForChat(chatId));
}

class UpdateNotifyManager {
  private state = loadJson<UpdateNotifyState>(FILE, {});
  private timer?: ReturnType<typeof setInterval>;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.maybeNotify(), POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async maybeNotify(): Promise<void> {
    if (mainSettingsView().updateNotifyOptOut) return;
    const status = getUpdateStatus();
    if (!status.available || !status.latestVersion) return;
    if (status.latestVersion === status.currentVersion) return;
    if (this.state.lastNotifiedVersion === status.latestVersion) return;
    this.state.lastNotifiedVersion = status.latestVersion;
    saveJson<UpdateNotifyState>(FILE, this.state);
    log.info("Update-notify: new version detected", {
      from: status.currentVersion,
      to: status.latestVersion,
    });
    const from = status.currentVersion ?? status.current;
    const to = status.latestVersion ?? status.latest ?? "";
    const list = status.commits
      .slice(0, 8)
      .map((c) => `• ${escapeHtml(c)}`)
      .join("\n");
    // The buttons are Telegram's; other surfaces get the same news in plain
    // text and apply the update from the panel's Updates view instead.
    await notifyOwner({
      text: `A new version is available: v${from} → v${to}.`,
      telegram: {
        i18n: { key: "updatenotify_available", params: { from, to, list } },
        replyMarkupFor: (lang) =>
          Markup.inlineKeyboard([
            // Reuses the exact /reload confirm action — accepting the notice
            // runs the same rescue path a manual /reload would.
            [Markup.button.callback(t("updatenotify_accept_btn", lang), "reload:yes")],
            [Markup.button.callback(t("updatenotify_reject_btn", lang), "updnotify:reject")],
          ]).reply_markup,
      },
      push: { title: "MyAgens update available", kind: "update", tag: "update-available", url: "/" },
    });
  }
}

const updateNotify = new UpdateNotifyManager();

/** Start the background update-bump notifier. Cheap (no network) — call once at boot. */
export function startUpdateNotify(): void {
  updateNotify.start();
}
