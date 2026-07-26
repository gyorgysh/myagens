/**
 * Slack setup helpers, shared by the first-run wizard (`src/setup/`) and the
 * panel's Slack settings card.
 *
 * Setting Slack up by hand is the worst onboarding path in the product: two
 * tokens that look alike and live on different pages of the Slack app admin,
 * plus a member id most people have never had to find. So the same three
 * things the Telegram wizard does are done here — prove the bot token, prove
 * the app token, and detect the owner's member id from a DM instead of asking
 * them to hunt for it.
 *
 * Deliberately dependency-light (raw `fetch` against slack.com/api, plus the
 * Socket Mode client only for detection): the wizard runs before a valid
 * configuration exists, so nothing here may import `config.ts`.
 */

import { log } from "../logger.js";

const API = "https://slack.com/api";

export class SlackSetupError extends Error {
  constructor(
    message: string,
    readonly slackError?: string,
  ) {
    super(message);
  }
}

/** Slack API errors are terse slugs; say what the user should actually do. */
const ERROR_HINTS: Record<string, string> = {
  invalid_auth: "Slack rejected this token. Check you pasted the whole value, and the right one of the two.",
  not_authed: "No token was sent to Slack.",
  account_inactive: "That token belongs to a deactivated app or workspace.",
  token_revoked: "This token has been revoked — reinstall the app to the workspace and copy the new one.",
  missing_scope: "The app is missing a required scope. Reinstall it with the manifest from .env.example.",
  invalid_arguments:
    "Slack did not accept this as an app-level token. App tokens start with `xapp-` and come from Basic Information → App-Level Tokens.",
};

function describe(slackError: string | undefined, fallback: string): string {
  if (!slackError) return fallback;
  return ERROR_HINTS[slackError] ?? `${fallback} (${slackError})`;
}

async function slackCall<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new SlackSetupError(
      `Could not reach Slack: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const payload = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
  if (!payload?.ok) {
    throw new SlackSetupError(
      describe(payload?.error, `Slack rejected ${method} (HTTP ${res.status})`),
      payload?.error,
    );
  }
  return payload as T;
}

export interface SlackIdentity {
  /** Workspace name, so the user can confirm they installed it in the right one. */
  team: string;
  teamId: string;
  /** The bot's own user id — excluded from DM detection so it can't nominate itself. */
  botUserId: string;
  botName: string;
}

/** Prove a bot token (`xoxb-…`) and report which workspace it belongs to. */
export async function verifyBotToken(botToken: string): Promise<SlackIdentity> {
  const token = botToken.trim();
  if (!token.startsWith("xoxb-")) {
    throw new SlackSetupError("A bot token starts with `xoxb-`. That looks like a different token.");
  }
  const r = await slackCall<{ team?: string; team_id?: string; user_id?: string; user?: string }>(
    token,
    "auth.test",
  );
  return {
    team: r.team ?? "",
    teamId: r.team_id ?? "",
    botUserId: r.user_id ?? "",
    botName: r.user ?? "",
  };
}

/**
 * Prove an app-level token (`xapp-…`) carries `connections:write`, which is what
 * Socket Mode needs. `apps.connections.open` hands back a single-use WebSocket
 * URL; we never connect to it, and unused URLs simply expire.
 */
export async function verifyAppToken(appToken: string): Promise<void> {
  const token = appToken.trim();
  if (!token.startsWith("xapp-")) {
    throw new SlackSetupError(
      "An app-level token starts with `xapp-`. Generate one under Basic Information → App-Level Tokens with the `connections:write` scope.",
    );
  }
  await slackCall(token, "apps.connections.open");
}

/** Send the "you're connected" DM that proves the detected id is really you. */
export async function sendConfirmDm(botToken: string, userId: string, text: string): Promise<void> {
  await slackCall(botToken.trim(), "chat.postMessage", { channel: userId, text });
}

export interface SlackCandidate {
  id: string;
  name: string;
  /** Snippet of their message, so the confirm card is recognisable. */
  lastText?: string;
  at: number;
}

/**
 * Watches for a DM to the bot and collects whoever sent it, so the wizard can
 * offer "is this you?" instead of making the user find their member id.
 *
 * Only direct messages count — a channel member must not be able to nominate
 * themselves as the owner by mentioning the bot in a channel, which would hand
 * them a shell on this machine.
 */
export class SlackCandidatePoller {
  private app?: { start: () => Promise<unknown>; stop: () => Promise<unknown> };
  private stopped = false;
  private started = false;
  /** Set when the connection fails in a way worth showing (bad token, no socket mode). */
  warning: string | null = null;
  readonly candidates = new Map<string, SlackCandidate>();

  constructor(
    private readonly botToken: string,
    private readonly appToken: string,
    private readonly botUserId?: string,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      // Imported lazily: the setup wizard boots before the app does, and this
      // pulls in the whole Bolt runtime for what is a one-off detection step.
      const { App } = await import("@slack/bolt");
      const app = new App({ token: this.botToken, appToken: this.appToken, socketMode: true });
      app.message(async ({ message }) => {
        const m = message as unknown as {
          user?: string;
          channel?: string;
          channel_type?: string;
          text?: string;
          bot_id?: string;
          subtype?: string;
        };
        if (m.bot_id || !m.user || m.user === this.botUserId) return;
        // DM only, both by the event's own channel_type and the id shape.
        if (m.channel_type !== "im" && !m.channel?.startsWith("D")) return;
        if (!this.candidates.has(m.user)) {
          log.info("Setup: detected a Slack DM", { userId: m.user });
        }
        this.candidates.set(m.user, {
          id: m.user,
          name: await this.displayName(m.user),
          lastText: typeof m.text === "string" ? m.text.slice(0, 64) : undefined,
          at: Date.now(),
        });
      });
      this.app = app;
      if (this.stopped) return;
      await app.start();
    } catch (err) {
      this.warning =
        err instanceof Error
          ? `Could not connect to Slack: ${err.message}`
          : "Could not connect to Slack.";
      log.warn("Setup: Slack detection failed to connect", { error: String(err) });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.app?.stop().catch(() => {});
    this.app = undefined;
  }

  /** Best-effort real name for the confirm card; the id alone is unrecognisable. */
  private async displayName(userId: string): Promise<string> {
    try {
      const r = await slackCall<{ user?: { real_name?: string; name?: string } }>(
        this.botToken,
        "users.info",
        { user: userId },
      );
      return r.user?.real_name || r.user?.name || userId;
    } catch {
      return userId;
    }
  }
}

/** A Slack member id: `U…` for a person, `W…` on Enterprise Grid. */
export function isSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9]{6,}$/.test(value.trim());
}

/** The app manifest we tell people to paste, kept in one place. */
export const SLACK_APP_MANIFEST = {
  display_information: { name: "MyAgens Atlas" },
  features: {
    app_home: {
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    },
  },
  oauth_config: {
    scopes: {
      bot: [
        "chat:write",
        "files:read",
        "files:write",
        "im:history",
        "im:read",
        "im:write",
        "search:read",
        "users:read",
      ],
    },
  },
  settings: {
    event_subscriptions: { bot_events: ["message.im"] },
    interactivity: { is_enabled: true },
    socket_mode_enabled: true,
  },
} as const;
