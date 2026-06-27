import { Telegraf } from "telegraf";
import type { Worker } from "../core/workers.js";
import { workers } from "../core/workers.js";
import { runTurn } from "../claude/runner.js";
import { memoryMcp } from "../mcp/memory.js";
import { createTasksMcp } from "../mcp/tasks.js";
import { skillsMcp } from "../mcp/skills.js";
import { createCrewMcp } from "../mcp/crew.js";
import { hasPendingAsk, resolveAsk } from "../core/crewAsk.js";
import { SessionManager } from "../session/manager.js";
import { isAuthorized } from "../auth.js";
import { resolveSecret } from "../core/vault.js";
import { getProvider } from "../core/providers.js";
import { TelegramStreamer } from "./streamer.js";
import { AskQuestionManager } from "./askQuestion.js";
import { sendExpandableQuote, sendFormattedMarkdown } from "./send.js";
import { normalizeAgentText, summarizeInput } from "./formatting.js";
import { getLeadProtocol } from "../prompt.js";
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
  private asks: AskQuestionManager;

  constructor(lead: Worker) {
    this.lead = lead;
    const token = resolveSecret(lead.telegramToken!);
    // handlerTimeout: Infinity — a turn can run for minutes (long tool work).
    // Telegraf's default 90s watchdog would otherwise throw mid-handler and,
    // with no bot.catch, tear down this Lead's long-poll (the "polling stopped"
    // crash). The matching bot.catch in start() is the second line of defence.
    this.bot = new Telegraf(token, { handlerTimeout: Infinity });
    // Each lead bot gets its own session store, namespaced by lead id.
    this.sessions = new SessionManager(`lead-${lead.id}-state.json`);
    // Renders AskUserQuestion tool calls as inline buttons in this Lead's chat.
    this.asks = new AskQuestionManager(this.bot.telegram);
  }

  async start(): Promise<void> {
    const { bot, sessions, lead, asks } = this;

    // Auth middleware — identical rule to the main bot: allow-listed user in a
    // private 1:1 chat. The shared helper also enforces the private-chat check,
    // so a Lead bot added to a group can't leak the agent's output (host paths,
    // command results) to other members.
    bot.use(async (ctx, next) => {
      if (!isAuthorized(ctx)) return;
      return next();
    });

    // Global error handler so a handler failure (e.g. an API hiccup) is logged
    // rather than propagating up and stopping this Lead's long-poll.
    bot.catch((err, ctx) => {
      log.error("Lead bot handler error", {
        leadId: lead.id,
        updateType: ctx.updateType,
        error: String(err),
      });
    });

    // AskUserQuestion inline buttons resolve through here, mirroring the main
    // bot's callback_query handler. The blocking canUseTool promise is settled
    // by asks.resolve once the user taps an option (or Done for multi-select).
    bot.on("callback_query", async (ctx) => {
      const data =
        ctx.callbackQuery && "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
      if (data && asks.isAskCallback(data)) {
        log.debug("AskQuestion button pressed (lead)", { leadId: lead.id, chatId: ctx.chat?.id, data });
        const toast = await asks.resolve(data);
        await ctx.answerCbQuery(toast.slice(0, 200)).catch(() => {});
      } else {
        await ctx.answerCbQuery().catch(() => {});
      }
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
      // If this Lead is blocked inside crew_ask_president waiting on the
      // president, the reply must resolve that ask, not start a new turn —
      // checked before the busy guard, since the asking turn holds busy=true.
      if (hasPendingAsk(ctx.chat.id) && resolveAsk(ctx.chat.id, ctx.message.text)) {
        log.info("crew_ask resolved by user (lead)", { leadId: lead.id, chatId: ctx.chat.id });
        return;
      }
      // A free-text "Other" answer to an AskUserQuestion prompt resolves that
      // pending question instead of starting a new turn (the asking turn holds
      // busy=true, so this must short-circuit before the busy guard).
      if (asks.hasPendingText(ctx.chat.id) && asks.resolveText(ctx.chat.id, ctx.message.text)) {
        log.info("AskUserQuestion resolved by text (lead)", { leadId: lead.id, chatId: ctx.chat.id });
        return;
      }
      const s = sessions.get(ctx.chat.id);
      if (s.busy) {
        await ctx.reply("Already working on something. /stop to cancel.");
        return;
      }
      s.busy = true;
      s.abort = new AbortController();
      const placeholder = await ctx.reply("💭 Working on it…");
      const streamer = new TelegramStreamer(ctx.telegram, ctx.chat.id, placeholder.message_id);

      // Typing heartbeat, like the main bot. Suppressed while parked inside
      // crew_ask_president so the input area isn't stuck spinning.
      await ctx.telegram.sendChatAction(ctx.chat.id, "typing").catch(() => {});
      const typing = setInterval(() => {
        // Suppress while parked on crew_ask_president or an AskUserQuestion
        // prompt, so the input area isn't stuck spinning (and a typed "Other"
        // reply isn't masked).
        if (hasPendingAsk(ctx.chat.id) || asks.hasPending(ctx.chat.id)) return;
        void ctx.telegram.sendChatAction(ctx.chat.id, "typing").catch(() => {});
      }, 4000);
      try {
        const protocol = getLeadProtocol(lead.name, lead.portfolio);
        const append = [protocol, lead.systemPrompt].filter(Boolean).join("\n\n");

        // Point the run at a local model / proxy if a provider is set.
        const provider = lead.providerId ? getProvider(lead.providerId) : undefined;
        const env = provider
          ? {
              ANTHROPIC_BASE_URL: provider.baseUrl,
              ANTHROPIC_AUTH_TOKEN: resolveSecret(provider.authToken),
              ANTHROPIC_API_KEY: undefined,
            }
          : undefined;

        // Crew tools so a Lead can ask its president (this chat) or report back.
        const crewMcp = createCrewMcp({
          notify: async (text) => {
            await ctx.telegram
              .sendMessage(ctx.chat.id, text)
              .catch(() => {});
          },
          primaryChatId: ctx.chat.id,
          fromAgentId: lead.id,
        });

        const res = await runTurn({
          prompt: ctx.message.text,
          cwd: s.cwd,
          resume: s.sessionId,
          model: lead.model,
          env,
          systemPromptAppend: append,
          permissionMode: s.autonomy === "full" ? "bypassPermissions" : "default",
          abortController: s.abort,
          mcpServers: { memory: memoryMcp, tasks: createTasksMcp({ createdBy: lead.id }), skills: skillsMcp, crew: crewMcp },
          canUseTool: async (name, input) => {
            // AskUserQuestion has no Telegram-native picker, so render it as
            // inline buttons (with a free-text fallback) and hand the collected
            // answers back to the model as the tool result via a deny message —
            // same interception the main bot does. Everything else is allowed
            // (Leads run autonomously).
            if (name === "AskUserQuestion") {
              log.info("AskUserQuestion intercepted (lead)", { leadId: lead.id, chatId: ctx.chat.id });
              const answer = await asks.ask(ctx.chat.id, input);
              return { behavior: "deny", message: answer };
            }
            return { behavior: "allow", updatedInput: input };
          },
          onText: (delta) => {
            streamer.appendText(normalizeAgentText(delta));
          },
          onToolUse: (name, input) => {
            streamer.setStatus(`🔧 <i>${name}</i> ${summarizeInput(input)}`);
          },
          onSessionId: (id) => {
            s.sessionId = id;
            sessions.save();
          },
        });

        await streamer.finalize();

        // Same finish UX as the main bot: if the reply ends with a \n---\n
        // delimiter, replace the streamed message(s) with a collapsed expandable
        // blockquote (the full transcript as a log) and post the short closing
        // line as a separate clean message, so the president can tell the Lead
        // has finished writing.
        if (!res.isError && res.text) {
          const splitIdx = res.text.lastIndexOf("\n---\n");
          if (splitIdx !== -1) {
            const bulk = res.text.slice(0, splitIdx).trim();
            const reply = res.text.slice(splitIdx + 5).trim();
            if (bulk && reply) {
              for (const id of streamer.persistedMessageIds()) {
                await ctx.telegram.deleteMessage(ctx.chat.id, id).catch(() => {});
              }
              await sendExpandableQuote(ctx.telegram, ctx.chat.id, bulk).catch(() => {});
              await sendFormattedMarkdown(ctx.telegram, ctx.chat.id, reply).catch(() => {});
            }
          }
        }
      } catch (err) {
        log.error("LeadBot turn error", { leadId: lead.id, error: String(err) });
        // The streamer owns the placeholder; send the error as a fresh message.
        await ctx.reply(`Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      } finally {
        clearInterval(typing);
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

    // Capture the bot's @username so the panel/roster can show a t.me link.
    // Direct API call, so it works before launch(); failure is non-fatal.
    try {
      const me = await bot.telegram.getMe();
      if (me.username) workers.setBotUsername(lead.id, me.username);
    } catch (err) {
      log.warn("Lead bot getMe failed", { leadId: lead.id, error: String(err) });
    }

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
