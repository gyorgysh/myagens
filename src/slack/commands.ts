import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { config } from "../config.js";
import { log } from "../logger.js";
import { slackSessions } from "./session.js";
import { escapeSlackMrkdwn } from "./formatting.js";
import { fmtUptime } from "../telegram/leadBot.js";
import { mainSettingsView } from "../core/mainSettings.js";
import { AGENT_LANGUAGES, isValidLanguage, languageName } from "../core/languages.js";
import { resetInstanceConversation } from "../claude/tmuxInstance.js";
import type { SlackAskQuestionManager } from "./askQuestion.js";
import type { SlackPermissionManager } from "./permissions.js";
import type { Autonomy } from "../session/manager.js";

/**
 * Chat commands for the Slack surface, mirroring the Telegram ones.
 *
 * Slack will not deliver an unregistered `/command` to the app at all: the
 * client rejects it before it is ever sent. So the same handlers are reachable
 * three ways:
 *   - `!stop` (and any other `!name`), which is a plain message and always
 *     arrives, so this works with no Slack app configuration at all;
 *   - `/stop`, if the workspace admin declared the command on the Slack app
 *     under "Slash Commands", routed through Bolt's `app.command`;
 *   - `/stop` typed with a leading space, which Slack sends as normal text.
 *
 * Everything here operates on the per-user SlackSession, so the command set is
 * the subset of Telegram's that this surface actually has state for.
 */

export interface SlackCommandCtx {
  userId: string;
  channel: string;
  /** Post a plain message back to the channel. */
  say: (text: string) => Promise<unknown>;
  asks: SlackAskQuestionManager;
  permissions: SlackPermissionManager;
}

interface CommandSpec {
  name: string;
  description: string;
  run: (args: string, ctx: SlackCommandCtx) => Promise<void>;
}

/** Parse `!name args` / `/name args` out of a message. Returns undefined otherwise. */
export function parseSlackCommand(text: string): { name: string; args: string } | undefined {
  const m = text.trim().match(/^[!/]([a-z_]+)(?:\s+([\s\S]*))?$/i);
  if (!m) return undefined;
  return { name: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}

/**
 * Run a command by name. Returns false when the name is unknown, so a message
 * that merely looks like a command can still fall through to the agent.
 */
export async function runSlackCommand(name: string, args: string, ctx: SlackCommandCtx): Promise<boolean> {
  const spec = COMMANDS.find((c) => c.name === name);
  if (!spec) return false;
  log.info("Slack command", { userId: ctx.userId, command: name });
  await spec.run(args, ctx);
  return true;
}

/** Command names, for the Slack app manifest and the help text. */
export function slackCommandList(): Array<{ name: string; description: string }> {
  return COMMANDS.map((c) => ({ name: c.name, description: c.description }));
}

const AUTONOMY_ALIASES: Record<string, Autonomy> = {
  supervised: "supervised",
  standard: "standard",
  safe: "standard",
  full: "full",
  auto: "full",
  auto_until_error: "auto_until_error",
  autoerror: "auto_until_error",
  "auto-error": "auto_until_error",
  "until-error": "auto_until_error",
};

const COMMANDS: CommandSpec[] = [
  {
    name: "help",
    description: "Show the command list",
    run: async (_args, ctx) => {
      const lines = [
        `*${config.ATLAS_NAME}: commands*`,
        "",
        ...COMMANDS.map((c) => `\`!${c.name}\` · ${c.description}`),
        "",
        "_Slack only delivers slash commands the app declares, so `!name` always works. While a question or an approval is open you can answer it by just typing._",
      ];
      await ctx.say(lines.join("\n"));
    },
  },
  {
    name: "ping",
    description: "Am I online? (and busy or idle)",
    run: async (_args, ctx) => {
      const s = slackSessions.get(ctx.userId);
      const uptime = fmtUptime(process.uptime());
      if (!s.busy) {
        await ctx.say(`:white_check_mark: Online and idle · up ${uptime}`);
        return;
      }
      const elapsed = fmtUptime(s.busySince ? (Date.now() - s.busySince) / 1000 : 0);
      const task = s.busyPrompt ? `\n> ${escapeSlackMrkdwn(s.busyPrompt.slice(0, 200))}` : "";
      await ctx.say(`:hourglass_flowing_sand: Busy for ${elapsed} · up ${uptime}${task}${waitingSuffix(ctx)}`);
    },
  },
  {
    name: "status",
    description: "Show session info",
    run: async (_args, ctx) => {
      const s = slackSessions.get(ctx.userId);
      const lines = [
        "*Status*",
        `:file_folder: \`${escapeSlackMrkdwn(s.cwd)}\``,
        `:brain: ${config.ATLAS_NAME} · \`${mainSettingsView().effectiveModel}\``,
        `:lock: autonomy: *${s.autonomy}*`,
        `:link: session: \`${s.sessionId ?? "new"}\``,
        `:gear: ${s.busy ? "running a turn" : "idle"}`,
      ];
      const waiting = waitingOn(ctx);
      if (waiting) lines.push(`:raising_hand: waiting on you: ${waiting}`);
      if (s.language) lines.push(`:globe_with_meridians: language: ${languageName(s.language)}`);
      await ctx.say(lines.join("\n"));
    },
  },
  {
    name: "new",
    description: "Start a fresh conversation",
    run: async (_args, ctx) => {
      slackSessions.reset(ctx.userId);
      await resetInstanceConversation("atlas").catch(() => {});
      await ctx.say(":sparkles: Fresh conversation. Previous context dropped.");
    },
  },
  {
    name: "stop",
    description: "Abort the running request",
    run: async (_args, ctx) => {
      const s = slackSessions.get(ctx.userId);
      // Settle anything the turn is blocked on first. Aborting the SDK run does
      // not resolve a canUseTool promise, so a turn parked on an unanswered
      // question or approval would otherwise stay busy forever.
      const asked = ctx.asks.cancelAll(ctx.channel, "The user cancelled this question and stopped the turn.");
      const approved = ctx.permissions.cancelAll(ctx.channel);
      const wasBusy = s.busy;
      if (s.abort) s.abort.abort();
      // Clear the flags directly too: if the turn never resumes (a wedged
      // backend, a promise that outlived its run), the session must not stay
      // busy and lock the user out of the next message. Bumping turnSeq stops
      // the abandoned turn from clearing the flags of whatever runs next.
      s.turnSeq = (s.turnSeq ?? 0) + 1;
      s.busy = false;
      s.busySince = undefined;
      s.busyPrompt = undefined;
      s.abort = undefined;

      const cancelled = [
        asked > 0 ? `${asked} question${asked === 1 ? "" : "s"}` : "",
        approved > 0 ? `${approved} approval${approved === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(" and ");
      if (!wasBusy && !cancelled) {
        await ctx.say("Nothing is running.");
        return;
      }
      await ctx.say(`:octagonal_sign: Stopped${cancelled ? ` · cancelled ${cancelled}` : ""}.`);
    },
  },
  {
    name: "pwd",
    description: "Show current directory",
    run: async (_args, ctx) => {
      const s = slackSessions.get(ctx.userId);
      await ctx.say(`:file_folder: \`${escapeSlackMrkdwn(s.cwd)}\``);
    },
  },
  {
    name: "cd",
    description: "Change working directory",
    run: async (args, ctx) => {
      const s = slackSessions.get(ctx.userId);
      if (!args) {
        await ctx.say("Usage: `!cd <path>`");
        return;
      }
      const target = isAbsolute(args) ? args : resolve(s.cwd, args);
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        await ctx.say(`:x: Not a directory: \`${escapeSlackMrkdwn(target)}\``);
        return;
      }
      s.cwd = target;
      slackSessions.save();
      await ctx.say(`:file_folder: Now in \`${escapeSlackMrkdwn(target)}\``);
    },
  },
  {
    name: "mode",
    description: "supervised | standard | full | auto_until_error",
    run: async (args, ctx) => {
      const s = slackSessions.get(ctx.userId);
      const arg = args.split(/\s+/)[0]?.toLowerCase();
      const next = arg ? AUTONOMY_ALIASES[arg] : undefined;
      if (!next) {
        await ctx.say(
          `Autonomy is *${s.autonomy}*. Set it with \`!mode supervised|standard|full|auto_until_error\`.`,
        );
        return;
      }
      s.autonomy = next;
      s.escalation = undefined;
      slackSessions.save();
      await ctx.say(`:lock: Autonomy set to *${next}*.`);
    },
  },
  {
    name: "lang",
    description: "Set response language",
    run: async (args, ctx) => {
      const s = slackSessions.get(ctx.userId);
      const arg = args.split(/\s+/)[0]?.toLowerCase();
      if (!arg) {
        const current = s.language ?? config.DEFAULT_LANGUAGE;
        const list = Object.entries(AGENT_LANGUAGES).map(([k, v]) => `\`${k}\` ${v}`).join("  ·  ");
        await ctx.say(`Replying in *${languageName(current)}* (\`${current}\`).\n${list}`);
        return;
      }
      if (!isValidLanguage(arg)) {
        await ctx.say(`:x: Unknown language code \`${escapeSlackMrkdwn(arg)}\`. Try \`!lang\` for the list.`);
        return;
      }
      s.language = arg;
      slackSessions.save();
      await ctx.say(`:globe_with_meridians: Now replying in ${languageName(arg)}.`);
    },
  },
  {
    name: "allow",
    description: "Always allow a tool",
    run: async (args, ctx) => {
      const s = slackSessions.get(ctx.userId);
      const tool = args.split(/\s+/)[0];
      if (!tool) {
        await ctx.say("Usage: `!allow <ToolName>`");
        return;
      }
      s.sessionAllowedTools.add(tool);
      slackSessions.save();
      await ctx.say(`:white_check_mark: \`${escapeSlackMrkdwn(tool)}\` will run without asking.`);
    },
  },
  {
    name: "disallow",
    description: "Remove an always-allow rule (or `all`)",
    run: async (args, ctx) => {
      const s = slackSessions.get(ctx.userId);
      const arg = args.split(/\s+/)[0];
      if (!arg) {
        await ctx.say("Usage: `!disallow <ToolName|all>`");
        return;
      }
      if (arg === "all") {
        s.sessionAllowedTools.clear();
        s.allowedBashCmds.clear();
        slackSessions.save();
        await ctx.say(":broom: Cleared every always-allow rule.");
        return;
      }
      // Evaluate BOTH deletes: a name can live in the tool allow-list and the
      // Bash cmd allow-list, and removing only one leaves the other firing.
      const removedTool = s.sessionAllowedTools.delete(arg);
      const removedCmd = s.allowedBashCmds.delete(arg);
      slackSessions.save();
      await ctx.say(
        removedTool || removedCmd
          ? `:white_check_mark: Removed \`${escapeSlackMrkdwn(arg)}\`.`
          : `Not in the allow-list: \`${escapeSlackMrkdwn(arg)}\``,
      );
    },
  },
  {
    name: "allowed",
    description: "Show always-allow rules",
    run: async (_args, ctx) => {
      const s = slackSessions.get(ctx.userId);
      const tools = [...s.sessionAllowedTools];
      const cmds = [...s.allowedBashCmds];
      if (tools.length === 0 && cmds.length === 0) {
        await ctx.say("No always-allow rules yet.");
        return;
      }
      const lines = ["*Always allowed*"];
      if (tools.length) lines.push(`Tools: ${tools.map((x) => `\`${escapeSlackMrkdwn(x)}\``).join(", ")}`);
      if (cmds.length) lines.push(`Bash: ${cmds.map((x) => `\`${escapeSlackMrkdwn(x)}\``).join(", ")}`);
      lines.push("_Remove one with `!disallow <name>`._");
      await ctx.say(lines.join("\n"));
    },
  },
  {
    name: "usage",
    description: "Show cost & activity",
    run: async (_args, ctx) => {
      const s = slackSessions.get(ctx.userId);
      const day = new Date().toISOString().slice(0, 10);
      const today = s.usage.daily[day];
      const fmt = (t: typeof s.usage.total) =>
        `${t.turns} turns · $${t.costUsd.toFixed(2)} · ${t.inputTokens.toLocaleString()} in / ${t.outputTokens.toLocaleString()} out`;
      const lines = ["*Usage (this Slack chat)*", `Today: ${today ? fmt(today) : "nothing yet"}`, `All time: ${fmt(s.usage.total)}`];
      await ctx.say(lines.join("\n"));
    },
  },
];

/** Short description of what the turn is currently blocked on, if anything. */
function waitingOn(ctx: SlackCommandCtx): string | undefined {
  const header = ctx.asks.pendingHeader(ctx.channel);
  if (header) return `a question (*${escapeSlackMrkdwn(header)}*)`;
  const tool = ctx.permissions.pendingTool(ctx.channel);
  if (tool) return `an approval for \`${escapeSlackMrkdwn(tool)}\``;
  return undefined;
}

function waitingSuffix(ctx: SlackCommandCtx): string {
  const waiting = waitingOn(ctx);
  return waiting ? `\n:raising_hand: Waiting on you: ${waiting}` : "";
}
