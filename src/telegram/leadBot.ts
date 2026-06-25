import { Telegraf } from "telegraf";
import type { Worker } from "../core/workers.js";
import { runTurn } from "../claude/runner.js";
import { memoryMcp } from "../mcp/memory.js";
import { tasksMcp } from "../mcp/tasks.js";
import { skillsMcp } from "../mcp/skills.js";
import { SessionManager } from "../session/manager.js";
import { allowedUserIds } from "../config.js";
import { resolveSecret } from "../core/vault.js";
import { getProvider } from "../core/providers.js";
import { log } from "../logger.js";

/**
 * A standalone Telegram bot for a single Lead worker. It reuses the same
 * runTurn pipeline as the main bot (memory recall + Claude Code preset), runs
 * autonomously (bypass permissions), and keeps its own per-chat session state
 * namespaced by lead id so it survives restarts independently of the main bot.
 */
export class LeadBot {
  private bot: Telegraf;
  private sessions: SessionManager;
  private lead: Worker;

  constructor(lead: Worker) {
    this.lead = lead;
    const token = resolveSecret(lead.telegramToken!);
    this.bot = new Telegraf(token);
    // Each lead bot gets its own session store, namespaced by lead id.
    this.sessions = new SessionManager(`lead-${lead.id}-state.json`);
  }

  async start(): Promise<void> {
    const { bot, sessions, lead } = this;

    // Auth middleware — same allowed users as the main bot.
    bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !allowedUserIds.has(userId)) return;
      return next();
    });

    // /status
    bot.command("status", async (ctx) => {
      const s = sessions.get(ctx.chat.id);
      await ctx.replyWithHTML(
        `<b>${lead.name}</b> · ${lead.portfolio ?? "Lead"}\n` +
          `📂 <code>${s.cwd}</code>\n` +
          `🔒 autonomy: <b>${s.autonomy}</b>\n` +
          `⚙️ ${s.busy ? "running…" : "idle"}`,
      );
    });

    // /stop
    bot.command("stop", async (ctx) => {
      const s = sessions.get(ctx.chat.id);
      if (s.busy && s.abort) {
        s.abort.abort();
        await ctx.reply("⏹ Stopping…");
      } else {
        await ctx.reply("Nothing is running.");
      }
    });

    // /mode
    bot.command("mode", async (ctx) => {
      const s = sessions.get(ctx.chat.id);
      const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      if (arg === "supervised" || arg === "standard" || arg === "full") {
        s.autonomy = arg;
        sessions.save();
        await ctx.reply(
          arg === "full" ? "⚠️ Full mode." : arg === "supervised" ? "🔒 Supervised mode." : "⚖️ Standard mode.",
        );
      } else {
        await ctx.reply(`Current autonomy: ${s.autonomy}. Usage: /mode supervised|standard|full`);
      }
    });

    // /help
    bot.command("help", async (ctx) => {
      await ctx.replyWithHTML(
        `🤖 <b>${lead.name}</b>${lead.portfolio ? `: ${lead.portfolio}` : ""}\n\n` +
          `/status: session info (cwd, model, autonomy)\n` +
          `/stop: abort the running request\n` +
          `/mode supervised|standard|full: approval level\n` +
          `/lang [code]: show or set response language\n` +
          `/help: this message`,
      );
    });

    // Text messages → runTurn
    bot.on("text", async (ctx) => {
      const s = sessions.get(ctx.chat.id);
      if (s.busy) {
        await ctx.reply("Already working on something. /stop to cancel.");
        return;
      }
      s.busy = true;
      s.abort = new AbortController();
      const placeholder = await ctx.reply("💭 Working on it…");
      let reply = "";
      try {
        const portfolioPrompt = lead.portfolio
          ? `You are ${lead.name}, the ${lead.portfolio} Lead in MyHQ. Portfolio: ${lead.portfolio}.`
          : `You are ${lead.name}, a Lead in MyHQ.`;
        const append = [portfolioPrompt, lead.systemPrompt].filter(Boolean).join("\n\n");

        // Point the run at a local model / proxy if a provider is set.
        const provider = lead.providerId ? getProvider(lead.providerId) : undefined;
        const env = provider
          ? {
              ANTHROPIC_BASE_URL: provider.baseUrl,
              ANTHROPIC_AUTH_TOKEN: resolveSecret(provider.authToken),
              ANTHROPIC_API_KEY: undefined,
            }
          : undefined;

        await runTurn({
          prompt: ctx.message.text,
          cwd: s.cwd,
          resume: s.sessionId,
          model: lead.model,
          env,
          systemPromptAppend: append,
          permissionMode: s.autonomy === "full" ? "bypassPermissions" : "default",
          abortController: s.abort,
          mcpServers: { memory: memoryMcp, tasks: tasksMcp, skills: skillsMcp },
          canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
          onText: (delta) => {
            reply += delta;
          },
          onToolUse: () => {},
          onSessionId: (id) => {
            s.sessionId = id;
            sessions.save();
          },
        });

        await ctx.telegram.editMessageText(
          ctx.chat.id,
          placeholder.message_id,
          undefined,
          reply || "(done)",
        );
      } catch (err) {
        log.error("LeadBot turn error", { leadId: lead.id, error: String(err) });
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          placeholder.message_id,
          undefined,
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        s.busy = false;
        s.abort = undefined;
      }
    });

    await bot.telegram.setMyCommands([
      { command: "status", description: "Show session info" },
      { command: "stop", description: "Abort running request" },
      { command: "mode", description: "safe or auto" },
      { command: "help", description: "Help" },
    ]);

    log.info("Lead bot starting", { name: lead.name, portfolio: lead.portfolio });
    void bot.launch().catch((err) => {
      log.error("Lead bot polling stopped", { leadId: lead.id, error: String(err) });
    });
  }

  stop(signal: "SIGINT" | "SIGTERM"): void {
    this.bot.stop(signal);
    this.sessions.flush();
  }
}
