/**
 * Minimal Telegram Bot API client for the first-run setup wizard.
 *
 * Deliberately independent of telegraf and config.ts: setup mode runs before a
 * valid configuration exists, so this file only speaks raw HTTPS to
 * api.telegram.org with the token the user just pasted.
 */

import { log } from "../logger.js";

const API_BASE = "https://api.telegram.org";

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

async function tgCall<T>(
  token: string,
  method: string,
  payload?: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    result?: T;
    description?: string;
    error_code?: number;
  } | null;
  if (!body?.ok) {
    throw new TelegramError(body?.description ?? `Telegram returned HTTP ${res.status}`, body?.error_code ?? res.status);
  }
  return body.result as T;
}

export interface BotInfo {
  id: number;
  username: string;
  firstName: string;
}

/** Validate a bot token by asking Telegram who it belongs to. */
export async function getMe(token: string): Promise<BotInfo> {
  const me = await tgCall<{ id: number; username?: string; first_name?: string }>(token, "getMe");
  return { id: me.id, username: me.username ?? "", firstName: me.first_name ?? "" };
}

export async function sendMessage(token: string, chatId: number, text: string): Promise<void> {
  await tgCall(token, "sendMessage", { chat_id: chatId, text });
}

export interface Candidate {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  /** Snippet of their latest message, so the confirm card is recognisable. */
  lastText?: string;
  at: number;
}

/**
 * Long-polls getUpdates and collects every human who DMs the bot, so the wizard
 * can offer "is this you?" instead of making the user hunt down their numeric id.
 * Only private chats count — a group member must not be able to sneak into the
 * candidate list by mentioning the bot in a group.
 */
export class CandidatePoller {
  private offset = 0;
  private stopped = false;
  private started = false;
  /**
   * Epoch-ms of the last 409 Conflict. Sticky: another consumer usually only
   * collides with us intermittently (both sides retry and take turns winning),
   * so the warning must outlive the next successful poll or the UI shows it
   * for a 2s flash at best — the exact "nothing arrives and no explanation"
   * failure this exists to prevent.
   */
  private conflictAt = 0;
  /** Set when polling hits a persistent error worth surfacing (e.g. 409 Conflict). */
  warning: string | null = null;
  readonly candidates = new Map<number, Candidate>();

  constructor(private readonly token: string) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    // A leftover webhook makes getUpdates return 409 forever; clear it first.
    try {
      await tgCall(this.token, "deleteWebhook", { drop_pending_updates: false });
    } catch {
      /* best-effort */
    }
    while (!this.stopped) {
      try {
        // After a conflict, drop to short polls: a competing long-poller holds
        // the connection for tens of seconds and swallows whatever arrives in
        // that window, while each of our requests preempts theirs — asking
        // often is the best shot at seeing the user's message at all.
        const conflicted = this.conflictAt > 0;
        const updates = await tgCall<
          Array<{
            update_id: number;
            message?: {
              text?: string;
              chat?: { type?: string };
              from?: {
                id: number;
                is_bot?: boolean;
                first_name?: string;
                last_name?: string;
                username?: string;
              };
            };
          }>
        >(
          this.token,
          "getUpdates",
          { timeout: conflicted ? 2 : 25, offset: this.offset, allowed_updates: ["message"] },
          conflicted ? 12_000 : 35_000,
        );
        // A success does not mean the competitor is gone — keep the warning up
        // until they've been quiet for a while.
        if (Date.now() - this.conflictAt > 90_000) this.warning = null;
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          const msg = u.message;
          const from = msg?.from;
          if (!from || from.is_bot) continue;
          if (msg?.chat?.type !== "private") continue;
          if (!this.candidates.has(from.id)) {
            log.info("Setup: detected a Telegram DM", { userId: from.id, name: from.first_name ?? "" });
          }
          this.candidates.set(from.id, {
            id: from.id,
            firstName: from.first_name ?? "",
            lastName: from.last_name,
            username: from.username,
            lastText: typeof msg.text === "string" ? msg.text.slice(0, 64) : undefined,
            at: Date.now(),
          });
        }
        if (conflicted) await new Promise((r) => setTimeout(r, 1_000));
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof TelegramError && err.code === 409) {
          if (this.conflictAt === 0) {
            log.warn("Setup: another process is polling this bot token (Telegram 409) — its messages are being intercepted");
          }
          this.conflictAt = Date.now();
          this.warning =
            "Something else is already reading this bot's messages (Telegram 409 conflict) — usually a previous install or another server using the same token. Stop it (or create a fresh bot with @BotFather), then message the bot again.";
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }
}
