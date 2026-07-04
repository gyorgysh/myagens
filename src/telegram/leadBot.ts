import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Telegraf } from "telegraf";
import type { Telegram } from "telegraf";
import type { Worker } from "../core/workers.js";
import { workers } from "../core/workers.js";
import { isStaleSession, AUTO_ALLOWED_TOOLS } from "../claude/runner.js";
import { getBackend } from "../core/backends.js";
import type { ImageInput } from "../claude/runner.js";
import { memoryMcp } from "../mcp/memory.js";
import { createTasksMcp } from "../mcp/tasks.js";
import { skillsMcp } from "../mcp/skills.js";
import { createCrewMcp } from "../mcp/crew.js";
import { buildConnectorMcps } from "../mcp/connectorsMcp.js";
import { buildImageGenMcps } from "../mcp/imageGenMcp.js";
import { webhookMcps } from "../mcp/webhookMcp.js";
import { hasPendingAsk, resolveAsk } from "../core/crewAsk.js";
import { SessionManager } from "../session/manager.js";
import { isAuthorized } from "../auth.js";
import { resolveSecret } from "../core/vault.js";
import { getProvider } from "../core/providers.js";
import { TelegramStreamer } from "./streamer.js";
import { DraftStreamer } from "./draftStreamer.js";
import { RichDraftStreamer } from "./richDraftStreamer.js";
import { setBotProfilePhoto } from "./botPhoto.js";
import { AskQuestionManager } from "./askQuestion.js";
import { sendExpandableQuote, sendFormattedMarkdown } from "./send.js";
import { escapeHtml, normalizeAgentText, summarizeArg, summarizeInput, toolDiffMeta } from "./formatting.js";
import { downloadIncomingFile, isViewableImage, readImageInput } from "./files.js";
import { getLeadProtocol } from "../prompt.js";
import { t, langForChat } from "./i18n/index.js";
import { friendlyError } from "./errors.js";
import { sendBusyNotice, promptPreview } from "./busy.js";
import { LoopDetector } from "../core/loopDetector.js";
import { guardCwd, cwdFallbackNotice } from "../core/cwdGuard.js";
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
  // Flips true once long-polling actually ends (intentional stop() or an
  // unrecoverable error e.g. a Telegram 409 Conflict from a second poller on
  // the same token). LeadBotManager's watchdog polls this to notice a Lead
  // that died without anyone asking it to, and restarts it.
  private stopped = false;

  constructor(lead: Worker) {
    this.lead = lead;
    const token = resolveSecret(lead.telegramToken!);
    // handlerTimeout: Infinity, paired with fire-and-forget turn dispatch in the
    // message handlers below. Telegraf's polling loop awaits every handler in a
    // batch (Promise.all) before it fetches the next batch, so a handler that
    // blocks on a full turn would freeze the long-poll for minutes: new messages
    // sit unfetched at Telegram (the bot "stops reading" while it works, spinner
    // stuck) and only drain when the turn ends. So the handlers kick off runPrompt
    // WITHOUT awaiting it and return immediately, keeping polling live so the busy
    // guard can answer follow-up messages at once. The Infinity timeout then only
    // covers the small awaited prelude (a file download) and never throws the 90s
    // watchdog mid-turn (which would tear down the long-poll: the "polling stopped"
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
      // Reassure (debounced) without interrupting the running turn — same UX as
      // Atlas so an impatient user gets a calm "still working / /stop to cancel"
      // instead of feeling ignored.
      await sendBusyNotice(tg, s);
      return;
    }
    s.busy = true;
    s.busySince = Date.now();
    s.busyPrompt = promptPreview(prompt);
    s.lastBusyNoticeAt = undefined;
    s.busyNoticeCount = undefined;
    s.abort = new AbortController();

    const requestedCwd = s.cwd;
    const guardedCwd = guardCwd(requestedCwd, { leadId: lead.id, chatId });
    if (guardedCwd !== requestedCwd) {
      s.cwd = guardedCwd;
      sessions.save();
      void tg.sendMessage(chatId, cwdFallbackNotice(requestedCwd)).catch(() => {});
    }

    // Stream mode: per-lead override falls back to global STREAM_MODE config.
    const mode = lead.streamMode ?? config.STREAM_MODE;
    const parkedOnUser = () => hasPendingAsk(chatId, lead.id) || asks.hasPending(chatId);
    // Streamer setup does network I/O (draft.start() / the placeholder send) and
    // can reject on a Telegram hiccup. It runs BEFORE the main try/finally below,
    // so a throw here would skip the finally that clears s.busy — wedging the Lead
    // "busy" forever (every later message hits the busy guard, and /stop can't help
    // since no turn is in flight). Guard it here and release busy on failure.
    let streamer!: TelegramStreamer | DraftStreamer | RichDraftStreamer;
    try {
      if (mode === "rich") {
        const draft = new RichDraftStreamer(tg, chatId);
        draft.setPaused(parkedOnUser);
        await draft.start();
        streamer = draft;
      } else if (mode === "draft") {
        const draft = new DraftStreamer(tg, chatId);
        draft.setPaused(parkedOnUser);
        await draft.start();
        streamer = draft;
      } else {
        const placeholder = await tg.sendMessage(chatId, t("bot_working", langForChat(chatId)));
        streamer = new TelegramStreamer(tg, chatId, placeholder.message_id);
      }
      await tg.sendChatAction(chatId, "typing").catch(() => {});
    } catch (err) {
      log.error("Lead streamer setup failed — releasing busy", { leadId: lead.id, chatId, error: String(err) });
      s.busy = false;
      s.busySince = undefined;
      s.busyPrompt = undefined;
      s.abort = undefined;
      return;
    }

    const typing = setInterval(() => {
      if (hasPendingAsk(chatId, lead.id) || asks.hasPending(chatId)) return;
      void tg.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);
    let retrying = false;
    // Lead bots run unattended, so there's no human to prompt when the model gets
    // stuck firing the same tool call in a loop. Detect it here and abort the turn,
    // mirroring Atlas's autonomous guard, so an overnight loop can't burn tokens.
    const loopDetector = new LoopDetector(config.LOOP_THRESHOLD);
    let loopAborted = false;
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
      const res = await getBackend(lead.backendId).runTurn({
        prompt,
        images,
        cwd: s.cwd,
        resume: s.sessionId,
        model: lead.model,
        env,
        systemPromptAppend: append,
        permissionMode: s.autonomy === "full" ? "bypassPermissions" : "default",
        abortController: s.abort,
        mcpServers: { memory: memoryMcp, tasks: createTasksMcp({ createdBy: lead.id }), skills: skillsMcp, crew: crewMcp, ...buildConnectorMcps(), ...buildImageGenMcps(), ...webhookMcps() },
        canUseTool: async (name, input) => {
          if (name === "AskUserQuestion") {
            log.info("AskUserQuestion intercepted (lead)", { leadId: lead.id, chatId });
            const answer = await asks.ask(chatId, input);
            return { behavior: "deny", message: answer };
          }
          // A Lead runs unattended: there's no human to show approval buttons to.
          // Only `full` autonomy grants unrestricted tools (via bypassPermissions,
          // where this gate is a no-op). In every other mode the turn runs in
          // `default` permission mode and we must gate here — mirroring
          // WorkerManager.execute, only the read-only/safe set auto-runs; risky
          // tools (Bash/Write/Edit) are denied rather than silently executed, so
          // /mode supervised/standard is actually enforced.
          if (s.autonomy === "full") return { behavior: "allow", updatedInput: input };
          if (AUTO_ALLOWED_TOOLS.has(name)) return { behavior: "allow", updatedInput: input };
          return {
            behavior: "deny",
            message: "Tool not permitted for an unattended Lead outside 'full' autonomy — set the Lead to full to allow it.",
          };
        },
        onText: (delta) => {
          streamer.appendText(normalizeAgentText(delta));
        },
        onToolUse: (name, input) => {
          const diff = toolDiffMeta(name, input);
          log.info("Tool use", { chatId, tool: name, arg: summarizeArg(input).slice(0, 300), lead: lead.name, leadId: lead.id, ...(diff ?? {}) });
          streamer.setStatus(`🔧 <i>${name}</i> ${summarizeInput(input)}`);

          // No human to prompt in a Lead's autonomous run: detect a runaway retry
          // and abort, notifying the chat (once) so tokens aren't burned silently.
          if (!loopAborted) {
            const loop = loopDetector.record(name, input);
            if (loop.isLoop) {
              loopAborted = true;
              log.warn("Loop detected in Lead run — aborting", { leadId: lead.id, chatId, tool: name, count: loop.count });
              void tg
                .sendMessage(
                  chatId,
                  t("bot_loop_aborted", langForChat(chatId), { name, count: loop.count }),
                  { parse_mode: "HTML" },
                )
                .catch(() => {});
              s.abort?.abort();
            }
          }
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
      await streamer.finalize().catch(() => {});
      const stopped = s.abort?.signal.aborted;
      if (loopAborted) {
        // The loop-detection notice already explained the abort — don't pile a
        // generic error on top of it.
        log.info("Lead turn aborted by loop guard", { leadId: lead.id, chatId });
      } else if (stopped) {
        log.info("Lead turn stopped by user", { leadId: lead.id, chatId });
        await tg.sendMessage(chatId, t("bot_stopped", langForChat(chatId))).catch(() => {});
      } else if (isStaleSession(err) && s.sessionId) {
        // The stored session ID is no longer valid in the CLI. Drop it, inform
        // the user, and kick off a fresh turn automatically. We must NOT re-enter
        // here: `s.busy` is still true, so the re-run would just hit the busy
        // guard and bail, leaving the session stuck busy forever. Flag it and
        // re-run from `finally`, after the state below is cleared.
        log.warn("LeadBot stale session — clearing and retrying fresh", { leadId: lead.id, chatId });
        s.sessionId = undefined;
        sessions.save();
        retrying = true;
        await tg.sendMessage(chatId, t("bot_session_expired_retrying", langForChat(chatId))).catch(() => {});
      } else {
        // Map rate-limit / usage / auth failures to the same friendly lines Atlas
        // uses, instead of dumping a raw error.
        log.error("LeadBot turn error", { leadId: lead.id, error: String(err) });
        await tg.sendMessage(chatId, friendlyError(err, langForChat(chatId))).catch(() => {});
      }
    } finally {
      clearInterval(typing);
      s.busy = false;
      s.busySince = undefined;
      s.busyPrompt = undefined;
      s.abort = undefined;
      if (retrying) {
        // Fresh start now that busy is cleared and the stale sessionId is gone.
        void this.runPrompt(chatId, tg, sessions, prompt, images);
      }
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

    // /ping — cheap "are you alive?" check. Users treat the bots like people and
    // keep asking; this answers instantly with connection + busy state so they
    // don't have to wonder whether the Lead is online.
    bot.command("ping", async (ctx) => {
      const s = sessions.get(ctx.chat.id);
      const lang = langForChat(ctx.chat.id);
      const uptime = fmtUptime(process.uptime());
      if (s.busy) {
        const elapsed = fmtUptime(s.busySince ? (Date.now() - s.busySince) / 1000 : 0);
        const task = s.busyPrompt ? t("bot_busy_task", lang, { task: escapeHtml(s.busyPrompt) }) : "";
        await ctx.replyWithHTML(t("bot_ping_busy", lang, { elapsed, uptime, task }));
      } else {
        await ctx.replyWithHTML(t("bot_ping_idle", lang, { uptime }));
      }
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

    // /pwd
    bot.command("pwd", async (ctx) => {
      const s = sessions.get(ctx.chat.id);
      await ctx.replyWithHTML(`📂 <code>${escapeHtml(s.cwd)}</code>`);
    });

    // /cd
    bot.command("cd", async (ctx) => {
      const lang = langForChat(ctx.chat.id);
      const s = sessions.get(ctx.chat.id);
      const arg = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
      if (!arg) {
        await ctx.reply(t("cmd_cd_usage", lang));
        return;
      }
      const target = isAbsolute(arg) ? arg : resolve(s.cwd, arg);
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        await ctx.reply(t("cmd_cd_not_dir", lang, { path: target }));
        return;
      }
      s.cwd = target;
      sessions.save();
      log.info("Command /cd (lead)", { leadId: lead.id, chatId: ctx.chat.id, cwd: target });
      await ctx.replyWithHTML(t("cmd_cd_done", lang, { path: escapeHtml(target) }));
    });

    // /help
    bot.command("help", async (ctx) => {
      await ctx.replyWithHTML(
        `🤖 <b>${lead.name}</b>${lead.portfolio ? `: ${lead.portfolio}` : ""}\n\n` +
          `/ping: check I'm online and whether I'm busy\n` +
          `/status: session info (cwd, model, autonomy)\n` +
          `/cd [path]: change working directory\n` +
          `/pwd: show current directory\n` +
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

        // Fire-and-forget for the same reason as the text handler: awaiting the
        // turn here would freeze the poll loop until it finishes.
        void this.runPrompt(ctx.chat.id, ctx.telegram, sessions, prompt, images).catch((err) => {
          log.error("Lead runPrompt crashed", { leadId: lead.id, error: String(err) });
        });
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
      if (hasPendingAsk(ctx.chat.id, lead.id) && resolveAsk(ctx.chat.id, lead.id, ctx.message.text)) {
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
      // Fire-and-forget: don't await the turn, or this handler would block
      // Telegraf's poll loop for the whole turn and the Lead would stop reading
      // messages. runPrompt handles its own errors; the catch is just a backstop
      // so a fire-and-forget rejection can't surface as an unhandled rejection.
      void this.runPrompt(ctx.chat.id, ctx.telegram, sessions, ctx.message.text).catch((err) => {
        log.error("Lead runPrompt crashed", { leadId: lead.id, error: String(err) });
      });
    });

    await bot.telegram.setMyCommands([
      { command: "ping", description: "Am I online? (and busy or idle)" },
      { command: "status", description: "Show session info" },
      { command: "cd", description: "Change working directory" },
      { command: "pwd", description: "Show current directory" },
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
    void bot
      // Same 409-Conflict resilience as the main bot: ride out a second poller on
      // this token (e.g. the watchdog reviving a Lead whose old poll is still
      // draining) with in-loop backoff instead of dropping the connection.
      .launch({ polling: { retryOnConflict: true, conflictRetryDelay: 1000, maxConflictRetryDelay: 15000 } })
      .catch((err) => {
        log.error("Lead bot polling stopped", { leadId: lead.id, error: String(err) });
      })
      .finally(() => {
        this.stopped = true;
      });
  }

  /** True once this Lead's long-poll has ended, whether by stop() or a died launch(). */
  isRunning(): boolean {
    return !this.stopped;
  }

  /** True while a turn is mid-flight for this Lead. The watchdog checks this
   *  before dropping a dead entry, so a died poll doesn't get replaced by a
   *  fresh instance (and a fresh SessionManager over the same state file)
   *  while the old instance is still mid-write to session state. */
  hasActiveTurn(): boolean {
    return this.sessions.all().some((s) => s.busy);
  }

  stop(signal: "SIGINT" | "SIGTERM"): void {
    this.stopped = true;
    this.bot.stop(signal);
    this.sessions.flush();
  }
}

/** Compact human duration from seconds, e.g. "3h 12m", "8m", "45s". */
export function fmtUptime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return `${h}h ${rem}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
