import { Telegraf } from "telegraf";
import type { Telegram } from "telegraf";
import type { Worker } from "../core/workers.js";
import { workers } from "../core/workers.js";
import { runTurn } from "../claude/runner.js";
import type { ImageInput } from "../claude/runner.js";
import { memoryMcp } from "../mcp/memory.js";
import { createTasksMcp } from "../mcp/tasks.js";
import { skillsMcp } from "../mcp/skills.js";
import { createCrewMcp } from "../mcp/crew.js";
import { buildConnectorMcps } from "../mcp/connectorsMcp.js";
import { hasPendingAsk, resolveAsk } from "../core/crewAsk.js";
import { SessionManager } from "../session/manager.js";
import { isAuthorized } from "../auth.js";
import { resolveSecret } from "../core/vault.js";
import { getProvider } from "../core/providers.js";
import { TelegramStreamer } from "./streamer.js";
import { setBotProfilePhoto } from "./botPhoto.js";
import { AskQuestionManager } from "./askQuestion.js";
import { sendExpandableQuote, sendFormattedMarkdown } from "./send.js";
import { normalizeAgentText, summarizeArg, summarizeInput, toolDiffMeta } from "./formatting.js";
import { downloadIncomingFile, isViewableImage, readImageInput } from "./files.js";
import { getLeadProtocol } from "../prompt.js";
import { t, langForChat } from "./i18n/index.js";
import { log } from "../logger.js";
import { config } from "../config.js";
import { agentUsage } from "../core/agentUsage.js";

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

  /** Core turn-runner shared by text, photo, and document handlers. */
  private async runPrompt(
    chatId: number,
    tg: Telegram,
    sessions: SessionManager,
    prompt: string,
    images?: ImageInput[],
  ): Promise<void> {
    const { lead, asks } = this;
    const s = sessions.get(chatId);
    if (s.busy) {
      await tg.sendMessage(chatId, t("bot_busy", langForChat(chatId))).catch(() => {});
      return;
    }
    s.busy = true;
    s.abort = new AbortController();
    const placeholder = await tg.sendMessage(chatId, t("bot_working", langForChat(chatId)));
    const streamer = new TelegramStreamer(tg, chatId, placeholder.message_id);

    await tg.sendChatAction(chatId, "typing").catch(() => {});
    const typing = setInterval(() => {
      if (hasPendingAsk(chatId) || asks.hasPending(chatId)) return;
      void tg.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);
    try {
      const protocol = getLeadProtocol(lead.name, lead.portfolio);
      const append = [protocol, lead.systemPrompt].filter(Boolean).join("\n\n");

      const provider = lead.providerId ? getProvider(lead.providerId) : undefined;
      const env = provider
        ? {
            ANTHROPIC_BASE_URL: provider.baseUrl,
            ANTHROPIC_AUTH_TOKEN: resolveSecret(provider.authToken),
            ANTHROPIC_API_KEY: undefined,
          }
        : undefined;

      const crewMcp = createCrewMcp({
        notify: async (text) => {
          await tg.sendMessage(chatId, text).catch(() => {});
        },
        primaryChatId: chatId,
        fromAgentId: lead.id,
      });

      log.info("Lead turn starting", { lead: lead.name, leadId: lead.id, chatId, model: lead.model ?? config.CLAUDE_MODEL });
      const res = await runTurn({
        prompt,
        images,
        cwd: s.cwd,
        resume: s.sessionId,
        model: lead.model,
        env,
        systemPromptAppend: append,
        permissionMode: s.autonomy === "full" ? "bypassPermissions" : "default",
        abortController: s.abort,
        mcpServers: { memory: memoryMcp, tasks: createTasksMcp({ createdBy: lead.id }), skills: skillsMcp, crew: crewMcp, ...buildConnectorMcps() },
        canUseTool: async (name, input) => {
          if (name === "AskUserQuestion") {
            log.info("AskUserQuestion intercepted (lead)", { leadId: lead.id, chatId });
            const answer = await asks.ask(chatId, input);
            return { behavior: "deny", message: answer };
          }
          return { behavior: "allow", updatedInput: input };
        },
        onText: (delta) => {
          streamer.appendText(normalizeAgentText(delta));
        },
        onToolUse: (name, input) => {
          const diff = toolDiffMeta(name, input);
          log.info("Tool use", { chatId, tool: name, arg: summarizeArg(input).slice(0, 300), lead: lead.name, leadId: lead.id, ...(diff ?? {}) });
          streamer.setStatus(`🔧 <i>${name}</i> ${summarizeInput(input)}`);
        },
        onSessionId: (id) => {
          s.sessionId = id;
          sessions.save();
        },
      });

      await streamer.finalize();

      agentUsage.record(lead.name, "lead", {
        costUsd: res.costUsd ?? 0,
        durationMs: res.durationMs ?? 0,
        inputTokens: res.tokens?.inputTokens ?? 0,
        outputTokens: res.tokens?.outputTokens ?? 0,
        cacheReadTokens: res.tokens?.cacheReadTokens ?? 0,
        cacheWriteTokens: res.tokens?.cacheWriteTokens ?? 0,
      });

      // Same finish UX as the main bot: split on \n---\n to post the closing
      // sentence as a clean message and collapse the work log.
      if (!res.isError && res.text) {
        const splitIdx = res.text.lastIndexOf("\n---\n");
        if (splitIdx !== -1) {
          const bulk = res.text.slice(0, splitIdx).trim();
          const reply = res.text.slice(splitIdx + 5).trim();
          if (bulk && reply) {
            for (const id of streamer.persistedMessageIds()) {
              await tg.deleteMessage(chatId, id).catch(() => {});
            }
            await sendExpandableQuote(tg, chatId, bulk).catch(() => {});
            await sendFormattedMarkdown(tg, chatId, reply).catch(() => {});
          }
        }
      }
    } catch (err) {
      log.error("LeadBot turn error", { leadId: lead.id, error: String(err) });
      await tg.sendMessage(chatId, t("bot_action_failed", langForChat(chatId), { detail: err instanceof Error ? err.message : String(err) })).catch(() => {});
    } finally {
      clearInterval(typing);
      s.busy = false;
      s.abort = undefined;
    }
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
        await ctx.reply(t("bot_stopping", langForChat(ctx.chat.id)));
      } else {
        await ctx.reply(t("bot_nothing_running", langForChat(ctx.chat.id)));
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

    // Document/photo uploads — download, then run as a prompt with optional vision.
    bot.on("message", async (ctx, next) => {
      // Only handle document and photo messages here; pass everything else through.
      const msg = ctx.message as unknown as Record<string, unknown>;
      const isDoc = "document" in msg;
      const isPhoto = "photo" in msg;
      if (!isDoc && !isPhoto) return next();

      const s = sessions.get(ctx.chat.id);
      try {
        let filePath: string;
        let images: ImageInput[] | undefined;
        const caption = (msg.caption as string | undefined)?.trim();

        if (isPhoto) {
          const photos = msg.photo as Array<{ file_id: string; file_unique_id: string }>;
          const largest = photos[photos.length - 1];
          filePath = await downloadIncomingFile(
            ctx.telegram,
            largest.file_id,
            `photo_${largest.file_unique_id}.jpg`,
            s.cwd,
          );
          log.info("Photo received (lead)", { lead: lead.name, chatId: ctx.chat.id, path: filePath });
          const img = await readImageInput(filePath).catch(() => undefined);
          if (img) images = [img];
        } else {
          const doc = msg.document as { file_id: string; file_unique_id: string; file_name?: string };
          filePath = await downloadIncomingFile(
            ctx.telegram,
            doc.file_id,
            doc.file_name ?? `file_${doc.file_unique_id}`,
            s.cwd,
          );
          log.info("File received (lead)", { lead: lead.name, chatId: ctx.chat.id, name: doc.file_name, path: filePath });
          if (isViewableImage(filePath)) {
            const img = await readImageInput(filePath).catch(() => undefined);
            if (img) images = [img];
          }
        }

        const prompt = caption
          ? `${caption}\n\n(${isPhoto ? "The user sent an image" : "The user uploaded a file"}, also saved at: ${filePath})`
          : isPhoto
            ? `The user sent this image (also saved at: ${filePath}).`
            : `The user uploaded a file, saved at: ${filePath}. Take a look.`;

        await this.runPrompt(ctx.chat.id, ctx.telegram, sessions, prompt, images);
      } catch (err) {
        log.error("Lead file/photo download failed", { leadId: lead.id, error: String(err) });
        await ctx.reply(`⚠️ Could not download: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      }
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
      await this.runPrompt(ctx.chat.id, ctx.telegram, sessions, ctx.message.text);
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

    // Match the bot's Telegram profile photo to its avatar. Idempotent (Telegram
    // persists it), and setBotProfilePhoto never throws — a cosmetic photo must
    // never block startup.
    if (lead.avatar) {
      const ok = await setBotProfilePhoto(bot.telegram, lead.avatar);
      if (ok) log.info("Lead bot profile photo set", { leadId: lead.id, avatar: lead.avatar });
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
