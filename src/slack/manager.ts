import { buildSlackBot, type SlackBotInstance } from "./bot.js";
import { resolveSlackConfig } from "../core/slackSettings.js";
import { registerNotifyChannel, unregisterNotifyChannel } from "../core/notify.js";
import { log } from "../logger.js";

/**
 * Owns the lifetime of the Slack surface so it can be (re)started when its
 * settings change, instead of only at boot. Without this, configuring Slack
 * from the panel would mean "saved, now restart the whole app", which is a
 * poor answer for an optional second front end.
 *
 * `sync()` is serialized: boot and a panel save can land at the same moment,
 * and two overlapping starts would open two Socket Mode connections on one
 * token, which makes Slack deliver each message to whichever won the race.
 */
class SlackSurfaceManager {
  private instance?: SlackBotInstance;
  private queue: Promise<void> = Promise.resolve();

  /** Start, stop, or restart the surface so it matches the current settings. */
  sync(): Promise<void> {
    this.queue = this.queue.then(() => this.syncNow()).catch((err) => {
      log.error("Slack surface sync failed", { error: err instanceof Error ? err.message : String(err) });
    });
    return this.queue;
  }

  private async syncNow(): Promise<void> {
    const slack = resolveSlackConfig();
    // Always tear down first: the tokens or the allow-list may have changed,
    // and the running instance captured them when it was built.
    if (this.instance) {
      await this.instance.stop().catch(() => {});
      this.instance = undefined;
      unregisterNotifyChannel("slack");
    }
    if (!slack.configured) return;
    const instance = buildSlackBot();
    if (!instance) return;
    try {
      await instance.start();
      this.instance = instance;
      // Owner notices (heartbeat alerts, task outcomes, update news) reach Slack
      // as DMs, so a Slack-only install is as well informed as a Telegram one.
      // Registered per start, since the client is rebuilt on every settings change.
      registerNotifyChannel("slack", async (notice) => {
        for (const userId of slack.allowedUserIds) {
          await instance.app.client.chat
            .postMessage({ channel: userId, text: notice.text })
            .catch((err) =>
              log.warn("Slack notice delivery failed", {
                userId,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
        }
      });
    } catch (err) {
      log.error("Failed to start Slack surface", {
        error: err instanceof Error ? err.message : String(err),
      });
      await instance.stop().catch(() => {});
    }
  }

  running(): boolean {
    return this.instance !== undefined;
  }

  async stop(): Promise<void> {
    await this.instance?.stop().catch(() => {});
    this.instance = undefined;
    unregisterNotifyChannel("slack");
  }
}

export const slackSurface = new SlackSurfaceManager();
