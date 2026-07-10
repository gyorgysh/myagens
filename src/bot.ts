import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { config, allowedUserIds } from "./config.js";
import { authMiddleware } from "./auth.js";
import { registerCommands } from "./commands.js";
import { handleInlineQuery } from "./telegram/inlineSearch.js";
import { AUTO_ALLOWED_TOOLS, isStaleSession, type PermissionResult } from "./claude/runner.js";
import { createTelegramMcp } from "./mcp/sendFile.js";
import { memoryMcp } from "./mcp/memory.js";
import { createTasksMcp } from "./mcp/tasks.js";
import { skillsMcp } from "./mcp/skills.js";
import { selfUpdateMcp } from "./mcp/selfUpdate.js";
import { selfUpdate } from "./core/selfUpdate.js";
import { createCrewMcp } from "./mcp/crew.js";
import { buildConnectorMcps } from "./mcp/connectorsMcp.js";
import { buildImageGenMcps } from "./mcp/imageGenMcp.js";
import { webhookMcps } from "./mcp/webhookMcp.js";
import { TelegramStreamer, type Streamer } from "./telegram/streamer.js";
import { DraftStreamer } from "./telegram/draftStreamer.js";
import { RichDraftStreamer } from "./telegram/richDraftStreamer.js";
import { sendFormattedMarkdown, sendRichMarkdown, sendExpandableQuote } from "./telegram/send.js";
import { PermissionManager, bashLeadCmd } from "./telegram/permissions.js";
import { LoopPromptManager } from "./telegram/loopPrompt.js";
import { AskQuestionManager } from "./telegram/askQuestion.js";
import { LoopDetector } from "./core/loopDetector.js";
import { downloadIncomingFile, isViewableImage, readImageInput } from "./telegram/files.js";
import { isGitCallback, resolveGitCallback } from "./telegram/gitFlow.js";
import { isReloadCallback, resolveReloadCallback } from "./telegram/reloadFlow.js";
import { startUpdateNotify, isUpdateNotifyCallback, resolveUpdateNotifyCallback } from "./core/updateNotify.js";
import { consumeUpdateMarker, currentPackageVersion } from "./core/updateControl.js";
import { isTaskCallback, resolveTaskCallback, retryKeyboard } from "./telegram/taskFlow.js";
import { isProjectCallback, resolveProjectCallback } from "./telegram/projects.js";
import { isInboxCallback, resolveInboxCallback } from "./telegram/inboxFlow.js";
import { isModelCallback, resolveModelCallback } from "./commands.js";
import {
  isResumeCallback,
  resolveResumeCallback,
  maybeOfferResume,
} from "./telegram/resumePrompt.js";
import { transcribeAudio, voiceEnabled, voiceSetupHint } from "./telegram/voice.js";
import { sendVoiceReply, ttsEnabled } from "./telegram/tts.js";
import { schedules, type ScheduleRunner } from "./schedule/manager.js";
import { heartbeat } from "./core/heartbeat.js";
import { taskDelegator } from "./core/taskRunner.js";
import { createTask, startRecurrenceTicker } from "./core/tasks.js";
import { push } from "./core/push.js";
import { fireWebhook, type WebhookSource } from "./core/webhook.js";
import { resolveMainRunFor, mainFallbackSpec, isDryRun, dryRunDescription, DRY_RUN_TOOLS } from "./core/mainSettings.js";
import { runTurnWithFallback } from "./core/fallback.js";
import { TokenBucketLimiter } from "./core/rateLimiter.js";
import { workers } from "./core/workers.js";
import { suggestions } from "./core/suggestions.js";
import {
  escapeHtml,
  normalizeAgentText,
  summarizeArg,
  summarizeInput,
  toolDiffMeta,
} from "./telegram/formatting.js";
import { resolveAsk, hasPendingAsk } from "./core/crewAsk.js";
import { reflectOnTurn } from "./core/reflect.js";
import { chatBridge, mainChatId } from "./core/chatBridge.js";
import { isPlanningPrompt } from "./core/planningMode.js";
import type { ImageInput, RunResult } from "./claude/runner.js";
import type { Autonomy } from "./session/manager.js";
import { sessions, AUTO_UNTIL_ERROR_TOOLS } from "./session/manager.js";
import { t, langForChat } from "./telegram/i18n/index.js";
import { log, preview } from "./logger.js";
import { agentUsage } from "./core/agentUsage.js";
import { errText, friendlyError } from "./telegram/errors.js";
import { sendBusyNotice, promptPreview } from "./telegram/busy.js";
import { guardCwd, cwdFallbackNotice } from "./core/cwdGuard.js";

export function buildBot(): Telegraf {
  const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
  const permissions = new PermissionManager(bot.telegram);
  const loops = new LoopPromptManager(bot.telegram);
  const asks = new AskQuestionManager(bot.telegram);

  // Inline queries carry no chat, so the chat-scoped authMiddleware can't vet
  // them and would silently drop every one. Register the inline handler ahead
  // of that middleware; it does its own user-id allow-list check internally.
  bot.on("inline_query", handleInlineQuery);

  bot.use(authMiddleware);
  registerCommands(bot);

  // Panel Chat is a window onto the main Telegram chat: let it drive turns and
  // abort them through the same flow the Telegram handlers use.
  chatBridge.attach(
    (chatId, prompt, images) =>
      runUserPrompt(permissions, loops, asks, chatId, prompt, bot.telegram, { images }),
    (chatId) => {
      const s = sessions.get(chatId);
      s.abort?.abort();
    },
  );

  // --- Tool-approval button presses ---
  bot.on("callback_query", async (ctx) => {
    const data =
      "data" in ctx.callbackQuery ? (ctx.callbackQuery.data as string) : undefined;
    if (data && permissions.isApprovalCallback(data)) {
      log.debug("Approval button pressed", { chatId: ctx.chat?.id, data });
      const toast = await permissions.resolve(data, ctx.chat?.id);
      await ctx.answerCbQuery(toast.slice(0, 200)).catch(() => {});
    } else if (data && loops.isLoopCallback(data)) {
      log.debug("Loop button pressed", { chatId: ctx.chat?.id, data });
      const toast = await loops.resolve(data, ctx.chat?.id);
      await ctx.answerCbQuery(toast.slice(0, 200)).catch(() => {});
    } else if (data && asks.isAskCallback(data)) {
      log.debug("AskQuestion button pressed", { chatId: ctx.chat?.id, data });
      const toast = await asks.resolve(data, ctx.chat?.id);
      await ctx.answerCbQuery(toast.slice(0, 200)).catch(() => {});
    } else if (data && isGitCallback(data) && ctx.chat) {
      log.debug("Git button pressed", { chatId: ctx.chat.id, data });
      const messageId = ctx.callbackQuery.message?.message_id;
      const toast = await resolveGitCallback(ctx.telegram, ctx.chat.id, data, messageId);
      await ctx.answerCbQuery(toast.slice(0, 200)).catch(() => {});
    } else if (data && isReloadCallback(data) && ctx.chat) {
      log.debug("Reload button pressed", { chatId: ctx.chat.id, data });
      const messageId = ctx.callbackQuery.message?.message_id;
      const toast = await resolveReloadCallback(ctx.telegram, ctx.chat.id, data, messageId);
      await ctx.answerCbQuery(toast.slice(0, 200)).catch(() => {});
    } else if (data && isUpdateNotifyCallback(data) && ctx.chat) {
      log.debug("Update-notify Reject pressed", { chatId: ctx.chat.id, data });
      const messageId = ctx.callbackQuery.message?.message_id;
      if (messageId !== undefined) {
        await ctx.telegram
          .editMessageReplyMarkup(ctx.chat.id, messageId, undefined, { inline_keyboard: [] })
          .catch(() => {});
      }
      const toast = await resolveUpdateNotifyCallback(ctx.chat.id);
      await ctx.answerCbQuery(toast.slice(0, 200)).catch(() => {});
    } else if (data && isTaskCallback(data) && ctx.chat) {
      log.debug("Task button pressed", { chatId: ctx.chat.id, data });
      const messageId = ctx.callbackQuery.message?.message_id;
      const toast = await resolveTaskCallback(ctx.telegram, ctx.chat.id, data, messageId);
      await ctx.answerCbQuery(toast.slice(0, 200)).catch(() => {});
    } else if (data && isProjectCallback(data) && ctx.chat) {
      log.debug("Project button pressed", { chatId: ctx.chat.id, data });
      const messageId = ctx.callbackQuery.message?.message_id;
      const toast = await resolveProjectCallback(ctx.telegram, ctx.chat.id, data, messageId);
      await ctx.answerCbQuery(toast.slice(0, 200)).catch(() => {});
    } else if (data && isInboxCallback(data) && ctx.chat) {
      log.debug("Inbox button pressed", { chatId: ctx.chat.id, data });
      const messageId = ctx.callbackQuery.message?.message_id;
      const toast = await resolveInboxCallback(ctx.telegram, ctx.chat.id, data, messageId);
      await ctx.answerCbQuery(toast.slice(0, 200)).catch(() => {});
    } else if (data && isModelCallback(data) && ctx.chat) {
      if (data.startsWith("mdl:noop")) {
        await ctx.answerCbQuery().catch(() => {});
      } else {
        log.debug("Model button pressed", { chatId: ctx.chat.id, data });
        const messageId = ctx.callbackQuery.message?.message_id;
        const toast = await resolveModelCallback(ctx.telegram, ctx.chat.id, messageId, data);
        await ctx.answerCbQuery(toast.slice(0, 200)).catch(() => {});
      }
    } else if (data && isResumeCallback(data) && ctx.chat) {
      log.debug("Resume button pressed", { chatId: ctx.chat.id, data });
      const toast = resolveResumeCallback(ctx.telegram, ctx.chat.id, data);
      await ctx.answerCbQuery(toast.slice(0, 200)).catch(() => {});
    } else {
      await ctx.answerCbQuery().catch(() => {});
    }
  });

  // --- Incoming files ---
  bot.on(message("document"), async (ctx) => {
    const doc = ctx.message.document;
    const session = sessions.get(ctx.chat.id);
    try {
      const path = await downloadIncomingFile(
        ctx.telegram,
        doc.file_id,
        doc.file_name ?? `file_${doc.file_unique_id}`,
        session.cwd,
      );
      log.info("File received", { chatId: ctx.chat.id, name: doc.file_name, path });
      const caption = ctx.message.caption?.trim();
      const prompt = caption
        ? `${caption}\n\n(The user uploaded a file, saved at: ${path})`
        : `The user uploaded a file, saved at: ${path}. Take a look.`;
      const images = isViewableImage(path) ? await imageInputs(path) : undefined;
      const run = () =>
        runUserPrompt(permissions, loops, asks, ctx.chat.id, prompt, ctx.telegram, { images });
      if (await maybeOfferResume(ctx.telegram, ctx.chat.id, run)) return;
      run();
    } catch (err) {
      log.error("File download failed", { chatId: ctx.chat.id, error: errText(err) });
      await ctx.reply(t("bot_dl_file_failed", langForChat(ctx.chat.id), { error: errText(err) }));
    }
  });

  bot.on(message("photo"), async (ctx) => {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const session = sessions.get(ctx.chat.id);
    try {
      const path = await downloadIncomingFile(
        ctx.telegram,
        largest.file_id,
        `photo_${largest.file_unique_id}.jpg`,
        session.cwd,
      );
      log.info("Photo received", { chatId: ctx.chat.id, path });
      const caption = ctx.message.caption?.trim();
      const prompt = caption
        ? `${caption}\n\n(The user sent an image, also saved at: ${path})`
        : `The user sent this image (also saved at: ${path}).`;
      const images = await imageInputs(path);
      const run = () =>
        runUserPrompt(permissions, loops, asks, ctx.chat.id, prompt, ctx.telegram, { images });
      if (await maybeOfferResume(ctx.telegram, ctx.chat.id, run)) return;
      run();
    } catch (err) {
      log.error("Photo download failed", { chatId: ctx.chat.id, error: errText(err) });
      await ctx.reply(t("bot_dl_image_failed", langForChat(ctx.chat.id), { error: errText(err) }));
    }
  });

  // --- Voice notes (transcribe, then treat as a text prompt) ---
  bot.on(message("voice"), async (ctx) => {
    const chatId = ctx.chat.id;
    if (!voiceEnabled()) {
      await ctx.reply(voiceSetupHint(langForChat(chatId)));
      return;
    }
    const session = sessions.get(chatId);
    try {
      const voice = ctx.message.voice;
      const path = await downloadIncomingFile(
        ctx.telegram,
        voice.file_id,
        `voice_${voice.file_unique_id}.ogg`,
        session.cwd,
      );
      await ctx.telegram.sendChatAction(chatId, "typing").catch(() => {});
      const text = await transcribeAudio(path);
      if (!text) {
        await ctx.reply(t("bot_voice_no_speech", langForChat(chatId)));
        return;
      }
      log.info("Voice transcribed", { chatId, text: preview(text) });
      await ctx.replyWithHTML(`🎤 <i>${escapeHtml(text)}</i>`).catch(() => {});
      const run = () =>
        runUserPrompt(permissions, loops, asks, chatId, text, ctx.telegram, { inputVoice: true });
      if (await maybeOfferResume(ctx.telegram, chatId, run)) return;
      run();
    } catch (err) {
      log.error("Voice handling failed", { chatId, error: errText(err) });
      await ctx.reply(t("bot_voice_failed", langForChat(chatId), { error: errText(err) }));
    }
  });

  // --- Plain text prompts ---
  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // handled by command handlers
    // If a crew agent is waiting for the president's reply, resolve it.
    if (hasPendingAsk(ctx.chat.id, "atlas")) {
      if (resolveAsk(ctx.chat.id, "atlas", text)) {
        log.info("crew_ask resolved by user", { chatId: ctx.chat.id });
        return;
      }
    }
    // If an AskUserQuestion is armed for a free-text ("Other") answer, consume
    // this message as the answer instead of starting a new turn (the asking turn
    // still holds busy=true, so this must short-circuit before the run path).
    if (asks.hasPendingText(ctx.chat.id) && asks.resolveText(ctx.chat.id, text)) {
      log.info("AskUserQuestion answered by typed reply", { chatId: ctx.chat.id });
      return;
    }
    const chatId = ctx.chat.id;
    const run = () => runUserPrompt(permissions, loops, asks, chatId, text, ctx.telegram);
    if (await maybeOfferResume(ctx.telegram, chatId, run)) return;
    run();
  });

  bot.catch((err, ctx) => {
    log.error("Unhandled bot error", { updateType: ctx.updateType, error: errText(err) });
  });

  // --- Scheduled prompts: run due jobs as autonomous turns, pushed to the chat ---
  // When the chat is busy at firing time we don't drop the job: the scheduler
  // retries it every tick (~30s) until the chat frees up. If it's still busy
  // after this long, fall back to running it as a background Kanban task so a
  // long-running conversation never silently swallows a scheduled run.
  const SCHED_BUSY_FALLBACK_MS = 5 * 60_000;
  const runScheduled: ScheduleRunner = async (s) => {
    if (sessions.get(s.chatId).busy) {
      const waited = s.busySince ? Date.now() - s.busySince : 0;
      if (waited < SCHED_BUSY_FALLBACK_MS) return "busy"; // retry next tick
      // Busy too long: move the run to a background task and report when done.
      log.info("Scheduled task busy too long; moving to background task", {
        chatId: s.chatId,
        id: s.id,
        waitedMs: waited,
      });
      const card = createTask({
        title: `Scheduled: ${s.prompt.slice(0, 80)}`,
        notes: s.prompt,
        column: "backlog",
        createdBy: "schedule",
      });
      const r = taskDelegator.delegate(card.id);
      if (!r.ok && !r.queued && !r.blocked) {
        // Couldn't delegate (no runner/capacity issue): keep retrying the chat.
        log.warn("Scheduled fallback delegate failed; will retry chat", { id: s.id, error: r.error });
        return "busy";
      }
      await bot.telegram
        .sendMessage(
          s.chatId,
          t("bot_scheduled_deferred", langForChat(s.chatId), { prompt: escapeHtml(s.prompt) }),
          { parse_mode: "HTML" },
        )
        .catch(() => {});
      return "deferred";
    }
    log.info("Scheduled task firing", { chatId: s.chatId, id: s.id });
    await bot.telegram
      .sendMessage(s.chatId, t("bot_scheduled", langForChat(s.chatId), { prompt: escapeHtml(s.prompt) }), {
        parse_mode: "HTML",
      })
      .catch(() => {});
    runUserPrompt(permissions, loops, asks, s.chatId, s.prompt, bot.telegram, {
      autonomous: true,
      cwd: s.cwd,
      webhook: s.webhookUrl
        ? { url: s.webhookUrl, source: "schedule", title: s.prompt.slice(0, 120), id: s.id }
        : undefined,
    });
    return "started";
  };
  schedules.start(runScheduled);

  // Recurring kanban templates: spawn fresh backlog copies on each card's
  // cadence. Runs independently of the panel; a live board refresh is pushed
  // via onRecurrenceFire (registered by the panel server) when the panel is up.
  startRecurrenceTicker();

  // Recover kanban cards left "queued"/"running" by a crash or restart: their
  // in-memory run state is gone, so mark them as a stale error the user can
  // retry, rather than leaving them stuck on the board forever.
  const recovered = taskDelegator.reconcileStuck();
  if (recovered) log.info("Reconciled stuck tasks on boot", { count: recovered });

  // --- Heartbeat: proactive host/kanban monitoring (off unless enabled) ---
  const alertTargets = [...allowedUserIds];

  // Self-update reports (build/restart of the bot's own source) go to the
  // president — every allowed chat — as plain status messages.
  selfUpdate.start(async (text) => {
    for (const chatId of alertTargets) {
      await bot.telegram
        .sendMessage(chatId, `<i>${escapeHtml(text)}</i>`, { parse_mode: "HTML" })
        .catch(() => {});
    }
  });
  heartbeat.start({
    notify: async (text) => {
      // Mirror the alert to any subscribed browsers as an OS-level push.
      void push.notify({ title: "MyAgens heartbeat", body: text, kind: "heartbeat", tag: "heartbeat" });
      for (const chatId of alertTargets) {
        await bot.telegram
          .sendMessage(chatId, `<i>${escapeHtml(text)}</i>`, { parse_mode: "HTML" })
          .catch(() => {});
      }
    },
    runActive: async (prompt) => {
      const chatId = alertTargets[0];
      if (chatId === undefined || sessions.get(chatId).busy) return false;
      runUserPrompt(permissions, loops, asks, chatId, prompt, bot.telegram, { autonomous: true });
      return true;
    },
  });

  // Proactive "new version detected" notice: polls the update-status cache
  // server.ts already keeps fresh (no extra git fetch traffic) and messages
  // the president with Accept ( == /reload) / Reject buttons on a version bump.
  startUpdateNotify(bot.telegram, alertTargets);

  // "Back online" confirmation after an update/reload/self-update restart: the
  // update runner leaves a marker on disk before restarting, so finding a fresh
  // one at boot means the restart completed — close the loop the "new version"
  // notice opened instead of coming back silently.
  const appliedUpdate = consumeUpdateMarker();
  if (appliedUpdate) {
    const to = currentPackageVersion() ?? "?";
    const from = appliedUpdate.fromVersion;
    log.info("Update restart confirmed", { mode: appliedUpdate.mode, from, to });
    void push.notify({ title: "MyAgens updated", body: `v${to} is back online`, kind: "update", tag: "update" });
    for (const chatId of alertTargets) {
      const lang = langForChat(chatId);
      const text =
        from && from !== to
          ? t("updatenotify_applied", lang, { from, to })
          : t("updatenotify_applied_same", lang, { to });
      void bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" }).catch(() => {});
    }
  }

  // Delegated kanban cards run via runTurn (not handleUserPrompt), so they have
  // no Telegram path of their own — report their outcome to the president here.
  taskDelegator.onReport(async (r) => {
    const chatId = alertTargets[0];
    if (chatId === undefined) return;
    const by = r.leadName ? ` (${r.leadName})` : "";
    // Mirror the outcome to subscribed browsers as an OS-level push.
    void push.notify({
      title:
        r.status === "ok" ? "Task done" : r.status === "stopped" ? "Task stopped" : "Task failed",
      body: `${r.title}${by}${r.status === "error" && r.error ? `: ${r.error}` : ""}`,
      kind: "task",
      tag: `task-${r.taskId}`,
      url: "/tasks",
    });
    if (r.status === "ok" && r.res) {
      await sendSummaryReport(bot.telegram, chatId, r.res, `Task${by}: ${r.title}`).catch(() => {});
      return;
    }
    const lang = langForChat(chatId);
    const notice =
      r.status === "stopped"
        ? t("bot_task_stopped", lang, { title: r.title, by })
        : t("bot_task_failed", lang, { title: r.title, by, error: r.error ? `: ${r.error}` : "" });
    // On a genuine failure (not a manual stop), offer a one-tap Retry button
    // that resets the card to backlog and re-delegates.
    await bot.telegram
      .sendMessage(chatId, `<i>${escapeHtml(notice)}</i>`, {
        parse_mode: "HTML",
        ...(r.status === "error" ? { reply_markup: retryKeyboard(r.taskId) } : {}),
      })
      .catch(() => {});
  });

  // New inbox suggestion filed by an agent — give the president a light ping so
  // nothing waits unseen (the full triage/decision still happens via /inbox).
  suggestions.onAdd(async (s) => {
    const n = suggestions.pendingCount();
    const cat = s.category ? ` [${s.category}]` : "";
    for (const chatId of alertTargets) {
      const text = t("bot_inbox_suggestion", langForChat(chatId), {
        agent: escapeHtml(s.fromAgentName),
        category: escapeHtml(cat),
        title: escapeHtml(s.title),
        count: n,
      });
      await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" }).catch(() => {});
    }
  });

  return bot;
}

// Per-chat turn rate limit (SEC): cap how many new user-initiated turns a single
// chat can start in a rolling window, so an allow-listed user can't spawn many
// concurrent runTurn calls by messaging faster than one finishes. Disabled when
// TURN_RATE_LIMIT is 0. Autonomous turns (schedules/heartbeat) bypass it.
const turnLimiter =
  config.TURN_RATE_LIMIT > 0
    ? new TokenBucketLimiter(config.TURN_RATE_LIMIT, config.TURN_RATE_WINDOW_MS)
    : undefined;

interface TurnOptions {
  /** Images to include inline (vision). */
  images?: ImageInput[];
  /** Force bypassPermissions regardless of session mode (scheduled/unattended). */
  autonomous?: boolean;
  /** Run in this directory for this turn only (does not change session cwd). */
  cwd?: string;
  /** When set, POST a JSON outcome to this webhook once the turn completes. */
  webhook?: { url: string; source: WebhookSource; title: string; id?: string };
  /** This turn's prompt came from a transcribed voice message, not typed text. */
  inputVoice?: boolean;
}

function runUserPrompt(
  permissions: PermissionManager,
  loops: LoopPromptManager,
  asks: AskQuestionManager,
  chatId: number,
  prompt: string,
  tg: Telegraf["telegram"],
  opts: TurnOptions = {},
): void {
  handleUserPrompt(permissions, loops, asks, chatId, prompt, tg, opts).catch((err) => {
    const session = sessions.get(chatId);
    session.busy = false;
    session.busySince = undefined;
    session.busyPrompt = undefined;
    session.abort = undefined;
    void tg.sendMessage(chatId, friendlyError(err, langForChat(chatId))).catch(() => {});
    log.error("Turn failed", { chatId, error: errText(err) });
  });
}

/** Run a single Claude Code turn for a chat, streaming output back live. */
async function handleUserPrompt(
  permissions: PermissionManager,
  loops: LoopPromptManager,
  asks: AskQuestionManager,
  chatId: number,
  prompt: string,
  tg: Telegraf["telegram"],
  opts: TurnOptions = {},
): Promise<void> {
  const { images, autonomous = false, webhook, inputVoice = false } = opts;
  const session = sessions.get(chatId);
  // An autonomous turn (scheduled/heartbeat) that resumes the persisted context
  // counts as "using" it, so the user's next message shouldn't re-offer a resume.
  if (autonomous) sessions.markSeen(chatId);
  if (session.busy) {
    log.info("Prompt rejected — chat busy", { chatId });
    // Reassure (debounced) without touching the in-flight turn. This send is
    // deliberately fire-and-forget inside the helper: a throw here must NOT
    // reject up into runUserPrompt's catch, which would clear the RUNNING
    // turn's busy flag and post a spurious error over live work.
    await sendBusyNotice(tg, session);
    return;
  }
  // Per-chat turn rate limit (SEC): an allow-listed user mustn't be able to spawn
  // unbounded concurrent turns by messaging faster than one finishes. Autonomous
  // turns (schedules/heartbeat) are exempt.
  if (!autonomous && turnLimiter && !turnLimiter.tryConsume(chatId)) {
    const waitS = Math.ceil(turnLimiter.retryAfterMs(chatId) / 1000);
    log.info("Prompt rejected — rate limited", { chatId, retryAfterS: waitS });
    await tg
      .sendMessage(chatId, t("bot_rate_limited", langForChat(chatId), { seconds: waitS }))
      .catch(() => {});
    return;
  }
  const requestedCwd = opts.cwd ?? session.cwd;
  const cwd = guardCwd(requestedCwd, { chatId });
  if (cwd !== requestedCwd && !opts.cwd) {
    // Only persist/notify when the session's own cwd was invalid (not a
    // one-off override passed via opts.cwd, e.g. a delegated card run).
    session.cwd = cwd;
    sessions.save();
    void tg.sendMessage(chatId, cwdFallbackNotice(requestedCwd)).catch(() => {});
  }

  // Mirror this turn into the panel Chat view when it's the main chat, so the
  // conversation is visible (and drivable) from the web UI too.
  const mirror = chatBridge.isEnabled() && chatId === mainChatId();
  if (mirror) {
    chatBridge.mirrorUser(prompt);
    chatBridge.mirrorBusy(true);
  }

  log.info("Prompt received", {
    chatId,
    autonomy: session.autonomy,
    resume: Boolean(session.sessionId),
    cwd: session.cwd,
    text: preview(prompt),
  });
  const startedAt = Date.now();

  session.busy = true;
  session.busySince = startedAt;
  session.busyPrompt = promptPreview(prompt);
  session.lastBusyNoticeAt = undefined;
  session.busyNoticeCount = undefined;
  session.abort = new AbortController();
  let retryStale = false;

  const ack = await tg.sendMessage(chatId, t("bot_working", langForChat(chatId))).catch(() => undefined);
  let placeholderId: number | undefined;

  // Parked-on-user predicate, shared by the typing loop and the draft keepalive:
  // while a crew_ask_president or AskUserQuestion free-text reply is awaited, the
  // draft preview must stop refreshing so it doesn't mask the user's typed answer.
  const parkedOnUser = () => hasPendingAsk(chatId, "atlas") || asks.hasPending(chatId);

  let streamer: Streamer;
  if (config.STREAM_MODE === "rich") {
    const draft = new RichDraftStreamer(tg, chatId);
    draft.setPaused(parkedOnUser);
    await draft.start();
    streamer = draft;
    placeholderId = ack?.message_id;
  } else if (config.STREAM_MODE === "draft") {
    const draft = new DraftStreamer(tg, chatId);
    draft.setPaused(parkedOnUser);
    await draft.start();
    streamer = draft;
    placeholderId = ack?.message_id;
  } else if (ack) {
    streamer = new TelegramStreamer(tg, chatId, ack.message_id);
  } else {
    const placeholder = await tg.sendMessage(chatId, t("bot_working", langForChat(chatId)));
    streamer = new TelegramStreamer(tg, chatId, placeholder.message_id);
  }

  await tg.sendChatAction(chatId, "typing").catch(() => {});
  const typing = setInterval(() => {
    // While the turn is parked waiting on the user — either crew_ask_president or
    // an AskUserQuestion prompt — suppress the "typing…" indicator so their input
    // area isn't stuck spinning (and so a typed "Other" reply isn't masked).
    if (parkedOnUser()) return;
    void tg.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);

  // Effective autonomy for this turn.
  const autonomy: Autonomy = autonomous ? "full" : session.autonomy;

  // auto_until_error: start each turn trusting the happy path (clear any leftover
  // supervised cooldown from a previous turn).
  if (autonomy === "auto_until_error") sessions.resetEscalation(chatId);

  // Per-turn agentic loop detection: catch the model firing the same tool call
  // over and over (a failing retry burning tokens). Fresh per turn so counts
  // never leak across requests.
  const loopDetector = new LoopDetector(config.LOOP_THRESHOLD);

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    // AskUserQuestion has a TUI-native picker with no Telegram equivalent, so we
    // intercept it: render the questions as inline buttons (with a free-text
    // fallback), then hand the collected answers back to the model as the tool
    // result via a deny message. Runs in every autonomy mode — we always want to
    // surface the question rather than silently auto-resolve it to nothing.
    if (toolName === "AskUserQuestion") {
      log.info("AskUserQuestion intercepted — prompting user", { chatId });
      const answer = await asks.ask(chatId, input);
      return { behavior: "deny", message: answer };
    }

    // Global dry-run: intercept mutating tools and feed back a synthetic "would
    // have…" result instead of executing them, so the model narrates intended
    // actions without touching the host. The runTurn permissionMode is forced off
    // bypass when dry-run is on (below), so this gate is always consulted.
    if (isDryRun() && DRY_RUN_TOOLS.includes(toolName as (typeof DRY_RUN_TOOLS)[number])) {
      const what = dryRunDescription(toolName, input);
      log.info("Dry-run: skipped mutating tool", { chatId, tool: toolName, what });
      return {
        behavior: "deny",
        message: `[dry-run] Skipped — would have ${what}. Dry-run mode is on, so this was not executed. Continue narrating the remaining intended steps; do not retry this tool.`,
      };
    }

    const lead = toolName === "Bash" ? bashLeadCmd(input) : undefined;

    // Loop guard runs before the normal permission flow so a runaway retry is
    // caught even for otherwise auto-allowed tools (Read/Grep/Bash, …).
    const loop = loopDetector.record(toolName, input);
    if (loop.isLoop) {
      log.warn("Loop detected — prompting user", {
        chatId,
        tool: toolName,
        count: loop.count,
      });
      const choice = await loops.request(chatId, toolName, loopSummary(toolName, input), loop.count);
      if (choice === "skip") {
        return { behavior: "deny", message: "User skipped this repeated call (loop detected)." };
      }
      if (choice === "once") {
        loopDetector.approveOnce(loop.hash);
      } else {
        // "continue": stop prompting for this exact call for the rest of the turn.
        loopDetector.silence(loop.hash);
      }
      // Fall through to the normal permission flow with the user's intent honored.
    }

    if (autonomy === "standard") {
      // Standard: auto-allow safe tools; risky tools prompt.
      if (
        AUTO_ALLOWED_TOOLS.has(toolName) ||
        session.sessionAllowedTools.has(toolName) ||
        (lead !== undefined && session.allowedBashCmds.has(lead))
      ) {
        log.debug("Tool auto-allowed", { chatId, tool: toolName });
        return { behavior: "allow", updatedInput: input };
      }
    } else if (autonomy === "auto_until_error") {
      // Auto-until-error: auto-allow the trusted set + safe tools, UNLESS a
      // recent tool error opened a supervised cooldown — then prompt for the
      // next few calls (decrementing the counter) before resuming auto-approval.
      const cooldown = session.escalation?.cooldown ?? 0;
      if (cooldown > 0) {
        session.escalation = { cooldown: cooldown - 1 };
        log.info("auto_until_error: escalated to prompt", { chatId, tool: toolName, cooldown });
        // fall through to the prompt below.
      } else if (
        AUTO_ALLOWED_TOOLS.has(toolName) ||
        AUTO_UNTIL_ERROR_TOOLS.includes(toolName as (typeof AUTO_UNTIL_ERROR_TOOLS)[number]) ||
        session.sessionAllowedTools.has(toolName) ||
        (lead !== undefined && session.allowedBashCmds.has(lead))
      ) {
        log.debug("Tool auto-allowed (auto_until_error)", { chatId, tool: toolName });
        return { behavior: "allow", updatedInput: input };
      }
    }
    // supervised: fall through to always prompt (skip auto-allow check above).

    log.info("Approval requested", { chatId, tool: toolName });
    const choice = await permissions.request(chatId, toolName, input);
    log.info("Approval resolved", { chatId, tool: toolName, choice });
    if (choice === "always") {
      session.sessionAllowedTools.add(toolName);
      sessions.save();
      return { behavior: "allow", updatedInput: input };
    }
    if (choice === "alwayscmd" && lead) {
      session.allowedBashCmds.add(lead);
      sessions.save();
      return { behavior: "allow", updatedInput: input };
    }
    if (choice === "allow" || choice === "alwayscmd") {
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: "User denied this action." };
  };

  // Autonomous/background turns fail over to a configured local provider while
  // the Anthropic plan is rate-limited (Feature: rate-limit auto-fallback).
  const mainRun = resolveMainRunFor({ autonomous: Boolean(autonomous) });

  const leads = workers.list().filter((w) => w.role === "lead" && w.enabled);
  const crew =
    leads.length > 0
      ? leads
          .map(
            (w) =>
              `- ${w.name}${w.portfolio ? ` (${w.portfolio} Lead)` : ""}${w.botUsername ? ` — reachable at t.me/${w.botUsername}` : ""}${w.systemPrompt ? `: ${w.systemPrompt.split("\n")[0]}` : ""}`,
          )
          .join("\n")
      : undefined;

  // Pending suggestion inbox (main agent only): a compact digest so Atlas can
  // triage and surface noteworthy items. Capped so it never bloats the prompt.
  const pendingItems = suggestions.pending();
  const pendingSuggestions =
    pendingItems.length > 0
      ? [
          ...pendingItems
            .slice(0, 10)
            .map(
              (s) =>
                `- ${s.id} · ${s.fromAgentName}${s.category ? ` [${s.category}]` : ""}: ${s.title}`,
            ),
          pendingItems.length > 10 ? `…and ${pendingItems.length - 10} more` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : undefined;

  // Build crew MCP: notify goes to all allowed chats, ask goes to this chat.
  const notifyAll = async (text: string) => {
    for (const targetId of allowedUserIds) {
      await tg
        .sendMessage(targetId, `<i>${escapeHtml(text)}</i>`, { parse_mode: "HTML" })
        .catch(() => {});
    }
  };
  const crewMcp = createCrewMcp({
    notify: notifyAll,
    primaryChatId: chatId,
    fromAgentId: "atlas",
    callerAutonomy: autonomy,
    callerPlanning: isPlanningPrompt(prompt),
  });

  // Panel mirror: a stable assistant message id the streamed text/tools fold into.
  const mirrorMsgId = mirror ? chatBridge.mirrorStart() : "";
  let mirrorText = "";
  // Set once an autonomous loop has triggered an abort, so we only notify once.
  let loopAborted = false;

  // Notify the chat when a usage-limit error mid-turn triggers the error-driven
  // failover to the configured fallback model/backend (core/fallback.ts).
  const onFallback = (name: string) =>
    void tg
      .sendMessage(chatId, t("bot_fallback_engaged", langForChat(chatId), { name }), { parse_mode: "HTML" })
      .catch(() => {});

  try {
    const res = await runTurnWithFallback(mainRun.backendId, {
      prompt,
      images,
      cwd,
      // Drop the resume token when the threshold fallback switched to another
      // backend (a Claude resume UUID means nothing to Grok/Codex/Ollama). The
      // error-driven helper handles the same drop for its own backend switch.
      resume: mainRun.fallbackBackendActive ? undefined : session.sessionId,
      model: mainRun.model,
      env: mainRun.env,
      crew,
      pendingSuggestions,
      knownPaths: mainRun.knownPaths,
      persona: mainRun.persona,
      promptExclude: mainRun.promptExclude,
      language: session.language ?? mainRun.defaultLanguage,
      // Dry-run forces the gate on (default mode) even in full autonomy, so the
      // canUseTool interception above can catch and echo mutating tools.
      permissionMode: autonomy === "full" && !isDryRun() ? "bypassPermissions" : "default",
      abortController: session.abort,
      mcpServers: {
        telegram: createTelegramMcp(tg, chatId, cwd),
        memory: memoryMcp,
        tasks: createTasksMcp({ createdBy: "atlas" }),
        skills: skillsMcp,
        self_update: selfUpdateMcp,
        crew: crewMcp,
        ...buildConnectorMcps(),
        ...buildImageGenMcps(),
        ...webhookMcps(),
      },
      canUseTool,
      onText: (delta) => {
        streamer.appendText(normalizeAgentText(delta));
        if (mirror) {
          mirrorText += delta;
          chatBridge.mirrorDelta(mirrorMsgId, delta);
        }
      },
      onToolUse: (name, input) => {
        const diff = toolDiffMeta(name, input);
        log.info("Tool use", { chatId, tool: name, arg: preview(summarizeArg(input), 300), ...(diff ?? {}) });
        streamer.setStatus(`🔧 <i>${name}</i> ${summarizeInput(input)}`);
        if (mirror) chatBridge.mirrorTool(mirrorMsgId, name, preview(summarizeArg(input), 120));

        // In "full" autonomy the SDK runs in bypassPermissions and never calls
        // canUseTool, so the loop guard above can't fire. Detect the runaway
        // here instead and abort the turn (there's no human to prompt mid-run),
        // notifying the user so an overnight retry can't burn tokens unchecked.
        if (autonomy === "full" && !loopAborted) {
          const loop = loopDetector.record(name, input);
          if (loop.isLoop) {
            loopAborted = true;
            log.warn("Loop detected in autonomous run — aborting", {
              chatId,
              tool: name,
              count: loop.count,
            });
            void tg
              .sendMessage(
                chatId,
                t("bot_loop_aborted", langForChat(chatId), { name, count: loop.count }),
                { parse_mode: "HTML" },
              )
              .catch(() => {});
            session.abort?.abort();
          }
        }
      },
      onSessionId: (id) => {
        log.debug("Session id", { chatId, sessionId: id });
        session.sessionId = id;
      },
      onToolResult: (isError) => {
        // auto_until_error: a failed tool drops us to supervised approval for
        // the next few calls so a human sees the failure path.
        if (isError && autonomy === "auto_until_error") {
          sessions.noteToolError(chatId);
          log.info("auto_until_error: tool error — escalating to supervised", { chatId });
        }
      },
    }, mainFallbackSpec(), onFallback);
    if (mirror) {
      // Prefer the model's final text; fall back to the streamed accumulation.
      const finalText = res.text?.trim() || mirrorText;
      chatBridge.mirrorEnd(mirrorMsgId, finalText, {
        error: res.isError,
        costUsd: res.costUsd,
      });
    }

    try {
      await streamer.finalize();
    } catch (err) {
      // A finalize failure (a Telegram send/edit rejecting) must not discard the
      // rest of a successful turn — usage accounting, the summary report, and the
      // success webhook all follow below. Log and continue on the success path.
      log.warn("Streamer finalize failed (continuing)", { chatId, error: errText(err) });
    }
    const turnUsage = {
      costUsd: res.costUsd ?? 0,
      durationMs: res.durationMs ?? 0,
      inputTokens: res.tokens?.inputTokens ?? 0,
      outputTokens: res.tokens?.outputTokens ?? 0,
      cacheReadTokens: res.tokens?.cacheReadTokens ?? 0,
      cacheWriteTokens: res.tokens?.cacheWriteTokens ?? 0,
    };
    sessions.recordUsage(chatId, turnUsage);
    // Schedule-triggered autonomous turns are attributed to a "Schedule" category
    // so they appear separately from interactive Atlas turns in the usage view.
    if (webhook?.source === "schedule") {
      agentUsage.record("Schedule", "schedule", turnUsage);
    } else {
      agentUsage.record(config.ATLAS_NAME, "atlas", turnUsage);
    }
    log.info("Turn complete", {
      chatId,
      ms: Date.now() - startedAt,
      sdkMs: res.durationMs ?? null,
      isError: res.isError,
      chars: res.text?.length ?? 0,
    });
    if (res.isError && res.text) {
      await tg.sendMessage(chatId, friendlyError(new Error(res.text))).catch(() => {});
    } else if (autonomous && !res.isError) {
      // Autonomous run (scheduled job / delegated card / heartbeat): the streamed
      // transcript is noise for the President. Replace it with a single clean
      // summary report of the job done, dropping the streamed messages first.
      for (const id of streamer.persistedMessageIds()) {
        await tg.deleteMessage(chatId, id).catch(() => {});
      }
      await sendSummaryReport(tg, chatId, res);
    } else if (!res.isError && res.text) {
      // If the agent ended its reply with a \n---\n delimiter, split the output:
      // replace the streamed message(s) with a collapsed expandable blockquote
      // (the full transcript as a log), then send the short reply line as a
      // normal chat message so the conversation stays clean. Text is always
      // shown — voice is an addition, never a replacement.
      const splitIdx = res.text.lastIndexOf("\n---\n");
      let spokenText = res.text;
      if (splitIdx !== -1) {
        const bulk = res.text.slice(0, splitIdx).trim();
        const reply = res.text.slice(splitIdx + 5).trim();
        if (bulk && reply) {
          spokenText = reply; // speak only the closing line, not the work log
          for (const id of streamer.persistedMessageIds()) {
            await tg.deleteMessage(chatId, id).catch(() => {});
          }
          await sendExpandableQuote(tg, chatId, bulk).catch(() => {});
          await sendFormattedMarkdown(tg, chatId, reply).catch(() => {});
        }
      }
      // Voice-out mirrors voice-in: only speak the reply when this turn's
      // prompt was itself a voice message and the president has voice replies
      // on. A typed message always gets a typed answer, even with /voice on —
      // this stays a conversation that follows how the president is talking,
      // not a blanket mode switch.
      const voiceMode = !autonomous && inputVoice && session.voiceReply && ttsEnabled();
      if (voiceMode) {
        await tg.sendChatAction(chatId, "record_voice").catch(() => {});
        await sendVoiceReply(tg, chatId, spokenText);
      }
    }

    // Post-turn reflection: distil a durable fact and/or reusable skill
    // (fire-and-forget, gated by env var + cost/time thresholds).
    if (!res.isError && res.toolCalls?.length) {
      void reflectOnTurn(prompt, res.toolCalls, res, chatId);
    }

    // Outbound webhook: push the outcome to the schedule's configured URL.
    if (webhook) {
      fireWebhook(webhook.url, {
        source: webhook.source,
        title: webhook.title,
        id: webhook.id,
        status: res.isError ? "error" : "ok",
        summary: res.text?.trim() || undefined,
        costUsd: res.costUsd,
        durationMs: res.durationMs,
        error: res.isError ? res.text?.trim() : undefined,
        completedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    await streamer.finalize().catch(() => {});
    const stopped = session.abort?.signal.aborted;
    if (loopAborted) {
      // The loop-detection notification already explained the abort; don't pile
      // a generic "Stopped." on top of it.
      log.info("Turn aborted by loop guard", { chatId, ms: Date.now() - startedAt });
    } else if (stopped) {
      log.info("Turn stopped by user", { chatId, ms: Date.now() - startedAt });
      await tg.sendMessage(chatId, t("bot_stopped", langForChat(chatId))).catch(() => {});
    } else if (isStaleSession(err) && session.sessionId) {
      // The stored session ID is stale (CLI no longer has that conversation).
      // Clear it and re-run the same prompt as a fresh turn automatically.
      // Applies to autonomous turns too (scheduled jobs, heartbeat) — those
      // used to fall through to the generic error branch and report a hard
      // failure ("No conversation found…") instead of silently recovering.
      log.warn("Main chat stale session — clearing and retrying fresh", { chatId, autonomous });
      session.sessionId = undefined;
      sessions.save();
      retryStale = true;
      await tg.sendMessage(chatId, t("bot_session_expired_retrying", langForChat(chatId))).catch(() => {});
    } else {
      log.error("Turn errored", { chatId, ms: Date.now() - startedAt, error: errText(err) });
      await tg.sendMessage(chatId, friendlyError(err, langForChat(chatId))).catch(() => {});
    }
    if (mirror) {
      chatBridge.mirrorEnd(mirrorMsgId, mirrorText || (stopped ? t("bot_stopped_plain", langForChat(chatId)) : friendlyError(err, langForChat(chatId))), {
        error: true,
      });
    }
    // Outbound webhook: report the failed/stopped outcome too.
    if (webhook) {
      fireWebhook(webhook.url, {
        source: webhook.source,
        title: webhook.title,
        id: webhook.id,
        status: stopped ? "stopped" : "error",
        error: stopped ? undefined : errText(err),
        completedAt: new Date().toISOString(),
      });
    }
  } finally {
    clearInterval(typing);
    if (placeholderId !== undefined) {
      await tg.deleteMessage(chatId, placeholderId).catch(() => {});
    }
    session.busy = false;
    session.busySince = undefined;
    session.busyPrompt = undefined;
    session.abort = undefined;
    if (mirror) chatBridge.mirrorBusy(false);
    if (retryStale) {
      // Kick off a fresh turn now that busy is cleared and sessionId is gone.
      // Go through runUserPrompt (not handleUserPrompt directly) so a throw in the
      // retry's setup still clears busy and notifies the user — a raw call would
      // leave the chat wedged busy plus an unhandled rejection.
      runUserPrompt(permissions, loops, asks, chatId, prompt, tg, opts);
    }
  }
}

async function imageInputs(path: string): Promise<ImageInput[] | undefined> {
  try {
    const img = await readImageInput(path);
    return img ? [img] : undefined;
  } catch (err) {
    log.error("Failed to read image for vision", { path, error: errText(err) });
    return undefined;
  }
}

/**
 * Post a clean summary report for an autonomous run, replacing the streamed
 * transcript. The agent's final result text is the "summary of changes"; we add
 * a compact footer (tools used + cost/duration) so the President gets a tidy
 * report rather than a wall of streamed tokens.
 */
async function sendSummaryReport(
  tg: Telegraf["telegram"],
  chatId: number,
  res: RunResult,
  heading?: string,
): Promise<void> {
  const lang = langForChat(chatId);
  const summary = (res.text ?? "").trim() || t("bot_done", lang);
  const body = heading ? `**${heading}**\n\n${summary}` : summary;
  const parts: string[] = [];
  const tools = res.toolCalls?.length ?? 0;
  if (tools > 0) parts.push(t(tools === 1 ? "bot_tool_calls_one" : "bot_tool_calls_many", lang, { n: tools }));
  if (typeof res.durationMs === "number") parts.push(fmtDuration(res.durationMs));
  const footer = parts.length ? t("bot_report_with", lang, { parts: parts.join(" · ") }) : t("bot_report", lang);
  // Render through the same path as the streamed reply so headings/lists/bold
  // look the way the transcript did (the HTML path leaves `#`/`-` literal).
  if (config.STREAM_MODE === "rich") {
    await sendRichMarkdown(tg, chatId, body, footer).catch(() => {});
  } else {
    await sendFormattedMarkdown(tg, chatId, body, footer).catch(() => {});
  }
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** Plain-text summary of a tool call for the loop-detection prompt. */
function loopSummary(toolName: string, input: unknown): string {
  const arg = summarizeArg(input);
  if (arg) return arg;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return toolName;
  }
}

