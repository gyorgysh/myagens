import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { config, allowedUserIds } from "./config.js";
import { authMiddleware } from "./auth.js";
import { registerCommands } from "./commands.js";
import { AUTO_ALLOWED_TOOLS, runTurn, type PermissionResult } from "./claude/runner.js";
import { createTelegramMcp } from "./mcp/sendFile.js";
import { memoryMcp } from "./mcp/memory.js";
import { createTasksMcp } from "./mcp/tasks.js";
import { skillsMcp } from "./mcp/skills.js";
import { selfUpdateMcp } from "./mcp/selfUpdate.js";
import { selfUpdate } from "./core/selfUpdate.js";
import { createCrewMcp } from "./mcp/crew.js";
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
import { isProjectCallback, resolveProjectCallback } from "./telegram/projects.js";
import { isInboxCallback, resolveInboxCallback } from "./telegram/inboxFlow.js";
import { isModelCallback, resolveModelCallback } from "./commands.js";
import {
  isResumeCallback,
  resolveResumeCallback,
  maybeOfferResume,
} from "./telegram/resumePrompt.js";
import { transcribeAudio, voiceEnabled, voiceSetupHint } from "./telegram/voice.js";
import { schedules, type ScheduleRunner } from "./schedule/manager.js";
import { heartbeat } from "./core/heartbeat.js";
import { taskDelegator } from "./core/taskRunner.js";
import { fireWebhook, type WebhookSource } from "./core/webhook.js";
import { resolveMainRun } from "./core/mainSettings.js";
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
import type { ImageInput, RunResult } from "./claude/runner.js";
import type { Autonomy } from "./session/manager.js";
import { sessions, AUTO_UNTIL_ERROR_TOOLS } from "./session/manager.js";
import { log, preview } from "./logger.js";
import { loadProbeResult } from "./core/usageProbe.js";

export function buildBot(): Telegraf {
  const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
  const permissions = new PermissionManager(bot.telegram);
  const loops = new LoopPromptManager(bot.telegram);
  const asks = new AskQuestionManager(bot.telegram);

  bot.use(authMiddleware);
  registerCommands(bot);

  // Panel Chat is a window onto the main Telegram chat: let it drive turns and
  // abort them through the same flow the Telegram handlers use.
  chatBridge.attach(
    (chatId, prompt) => runUserPrompt(permissions, loops, asks, chatId, prompt, bot.telegram),
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
      const toast = await loops.resolve(data);
      await ctx.answerCbQuery(toast.slice(0, 200)).catch(() => {});
    } else if (data && asks.isAskCallback(data)) {
      log.debug("AskQuestion button pressed", { chatId: ctx.chat?.id, data });
      const toast = await asks.resolve(data);
      await ctx.answerCbQuery(toast.slice(0, 200)).catch(() => {});
    } else if (data && isGitCallback(data) && ctx.chat) {
      log.debug("Git button pressed", { chatId: ctx.chat.id, data });
      const messageId = ctx.callbackQuery.message?.message_id;
      const toast = await resolveGitCallback(ctx.telegram, ctx.chat.id, data, messageId);
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
      await ctx.reply(`⚠️ Could not download file: ${errText(err)}`);
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
      await ctx.reply(`⚠️ Could not download image: ${errText(err)}`);
    }
  });

  // --- Voice notes (transcribe, then treat as a text prompt) ---
  bot.on(message("voice"), async (ctx) => {
    const chatId = ctx.chat.id;
    if (!voiceEnabled()) {
      await ctx.reply(voiceSetupHint());
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
        await ctx.reply("🎤 Couldn't make out any speech in that note.");
        return;
      }
      log.info("Voice transcribed", { chatId, text: preview(text) });
      await ctx.replyWithHTML(`🎤 <i>${escapeHtml(text)}</i>`).catch(() => {});
      const run = () => runUserPrompt(permissions, loops, asks, chatId, text, ctx.telegram);
      if (await maybeOfferResume(ctx.telegram, chatId, run)) return;
      run();
    } catch (err) {
      log.error("Voice handling failed", { chatId, error: errText(err) });
      await ctx.reply(`⚠️ Voice transcription failed: ${errText(err)}`);
    }
  });

  // --- Plain text prompts ---
  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // handled by command handlers
    // If a crew agent is waiting for the president's reply, resolve it.
    if (hasPendingAsk(ctx.chat.id)) {
      if (resolveAsk(ctx.chat.id, text)) {
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
  const runScheduled: ScheduleRunner = async (s) => {
    if (sessions.get(s.chatId).busy) return false;
    log.info("Scheduled task firing", { chatId: s.chatId, id: s.id });
    await bot.telegram
      .sendMessage(s.chatId, `⏰ <b>Scheduled task</b>\n<i>${escapeHtml(s.prompt)}</i>`, {
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
    return true;
  };
  schedules.start(runScheduled);

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

  // Delegated kanban cards run via runTurn (not handleUserPrompt), so they have
  // no Telegram path of their own — report their outcome to the president here.
  taskDelegator.onReport(async (r) => {
    const chatId = alertTargets[0];
    if (chatId === undefined) return;
    const by = r.leadName ? ` (${r.leadName})` : "";
    if (r.status === "ok" && r.res) {
      await sendSummaryReport(bot.telegram, chatId, r.res, `Task${by}: ${r.title}`).catch(() => {});
      return;
    }
    const notice =
      r.status === "stopped"
        ? `⏹ Task stopped — ${r.title}${by}`
        : `⚠️ Task failed — ${r.title}${by}${r.error ? `: ${r.error}` : ""}`;
    await bot.telegram
      .sendMessage(chatId, `<i>${escapeHtml(notice)}</i>`, { parse_mode: "HTML" })
      .catch(() => {});
  });

  // New inbox suggestion filed by an agent — give the president a light ping so
  // nothing waits unseen (the full triage/decision still happens via /inbox).
  suggestions.onAdd(async (s) => {
    const n = suggestions.pendingCount();
    const cat = s.category ? ` [${s.category}]` : "";
    const text =
      `💡 New inbox suggestion from <b>${escapeHtml(s.fromAgentName)}</b>${escapeHtml(cat)}\n` +
      `${escapeHtml(s.title)}\n\n` +
      `${n} pending — review with /inbox`;
    for (const chatId of alertTargets) {
      await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" }).catch(() => {});
    }
  });

  return bot;
}

interface TurnOptions {
  /** Images to include inline (vision). */
  images?: ImageInput[];
  /** Force bypassPermissions regardless of session mode (scheduled/unattended). */
  autonomous?: boolean;
  /** Run in this directory for this turn only (does not change session cwd). */
  cwd?: string;
  /** When set, POST a JSON outcome to this webhook once the turn completes. */
  webhook?: { url: string; source: WebhookSource; title: string; id?: string };
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
    session.abort = undefined;
    void tg.sendMessage(chatId, friendlyError(err)).catch(() => {});
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
  const { images, autonomous = false, webhook } = opts;
  const session = sessions.get(chatId);
  // An autonomous turn (scheduled/heartbeat) that resumes the persisted context
  // counts as "using" it, so the user's next message shouldn't re-offer a resume.
  if (autonomous) sessions.markSeen(chatId);
  if (session.busy) {
    log.info("Prompt rejected — chat busy", { chatId });
    await tg.sendMessage(chatId, "⏳ Still working on the previous request. Send /stop to cancel.");
    return;
  }
  const cwd = opts.cwd ?? session.cwd;

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
  session.abort = new AbortController();

  const ack = await tg.sendMessage(chatId, "💭 Working on it…").catch(() => undefined);
  let placeholderId: number | undefined;

  let streamer: Streamer;
  if (config.STREAM_MODE === "rich") {
    const draft = new RichDraftStreamer(tg, chatId);
    await draft.start();
    streamer = draft;
    placeholderId = ack?.message_id;
  } else if (config.STREAM_MODE === "draft") {
    const draft = new DraftStreamer(tg, chatId);
    await draft.start();
    streamer = draft;
    placeholderId = ack?.message_id;
  } else if (ack) {
    streamer = new TelegramStreamer(tg, chatId, ack.message_id);
  } else {
    const placeholder = await tg.sendMessage(chatId, "💭 Working on it…");
    streamer = new TelegramStreamer(tg, chatId, placeholder.message_id);
  }

  await tg.sendChatAction(chatId, "typing").catch(() => {});
  const typing = setInterval(() => {
    // While the turn is parked waiting on the user — either crew_ask_president or
    // an AskUserQuestion prompt — suppress the "typing…" indicator so their input
    // area isn't stuck spinning (and so a typed "Other" reply isn't masked).
    if (hasPendingAsk(chatId) || asks.hasPending(chatId)) return;
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

  const mainRun = resolveMainRun();

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
  });

  // Panel mirror: a stable assistant message id the streamed text/tools fold into.
  const mirrorMsgId = mirror ? chatBridge.mirrorStart() : "";
  let mirrorText = "";
  // Set once an autonomous loop has triggered an abort, so we only notify once.
  let loopAborted = false;

  try {
    const res = await runTurn({
      prompt,
      images,
      cwd,
      resume: session.sessionId,
      model: mainRun.model,
      env: mainRun.env,
      crew,
      pendingSuggestions,
      persona: mainRun.persona,
      language: session.language ?? mainRun.defaultLanguage,
      permissionMode: autonomy === "full" ? "bypassPermissions" : "default",
      abortController: session.abort,
      mcpServers: {
        telegram: createTelegramMcp(tg, chatId, cwd),
        memory: memoryMcp,
        tasks: createTasksMcp({ createdBy: "atlas" }),
        skills: skillsMcp,
        self_update: selfUpdateMcp,
        crew: crewMcp,
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
                `🔁 <b>Loop detected</b> — stopped an autonomous run after <b>${name}</b> ` +
                  `repeated the same call ${loop.count}× to avoid burning tokens.`,
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
    });
    if (mirror) {
      // Prefer the model's final text; fall back to the streamed accumulation.
      const finalText = res.text?.trim() || mirrorText;
      chatBridge.mirrorEnd(mirrorMsgId, finalText, {
        error: res.isError,
        costUsd: res.costUsd,
      });
    }

    await streamer.finalize();
    sessions.recordUsage(chatId, res.costUsd ?? 0, res.durationMs ?? 0);
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
      // normal chat message so the conversation stays clean.
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
      await tg.sendMessage(chatId, "⏹ Stopped.").catch(() => {});
    } else {
      log.error("Turn errored", { chatId, ms: Date.now() - startedAt, error: errText(err) });
      await tg.sendMessage(chatId, friendlyError(err)).catch(() => {});
    }
    if (mirror) {
      chatBridge.mirrorEnd(mirrorMsgId, mirrorText || (stopped ? "Stopped." : friendlyError(err)), {
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
    session.abort = undefined;
    if (mirror) chatBridge.mirrorBusy(false);
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
  const summary = (res.text ?? "").trim() || "Done.";
  const body = heading ? `**${heading}**\n\n${summary}` : summary;
  const parts: string[] = [];
  const tools = res.toolCalls?.length ?? 0;
  if (tools > 0) parts.push(`${tools} tool call${tools === 1 ? "" : "s"}`);
  if (typeof res.durationMs === "number") parts.push(fmtDuration(res.durationMs));
  const footer = parts.length ? `✅ Report · ${parts.join(" · ")}` : "✅ Report";
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

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) { const d = Math.floor(h / 24); return `${d} day${d === 1 ? "" : "s"}`; }
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Build a usage-limit message from the live probe, or null when nothing is
 * actually exhausted. `strict` only reports a genuine 100%+ limit (used to
 * explain an otherwise-opaque process exit); the lenient form also surfaces the
 * soonest non-zero limit (used when the error text already says "limit").
 */
function usageLimitMessage(strict: boolean): string | null {
  const probe = loadProbeResult();
  const now = Date.now();
  const exhausted = (probe?.limits ?? []).filter((l) => l.percent >= 100);
  const nearest = exhausted.sort((a, b) => a.resetsInMs - b.resetsInMs)[0];
  if (nearest) {
    const msLeft = Math.max(0, new Date(nearest.resetsAt).getTime() - now);
    return `📊 ${nearest.label} usage limit reached. Resets in ${fmtCountdown(msLeft)}.`;
  }
  if (strict) return null;
  const soonest = (probe?.limits ?? []).filter((l) => l.percent > 0).sort((a, b) => a.resetsInMs - b.resetsInMs)[0];
  if (soonest) {
    const msLeft = Math.max(0, new Date(soonest.resetsAt).getTime() - now);
    return `📊 Usage limit exhausted. ${soonest.label} resets in ${fmtCountdown(msLeft)}.`;
  }
  return "📊 Usage limit exhausted. Wait for the limit to reset, then retry.";
}

function friendlyError(err: unknown): string {
  const raw = errText(err);
  const low = raw.toLowerCase();
  if (/\b429\b|rate.?limit/.test(low)) {
    return "⏳ Rate limited by the API. Give it a moment and try again.";
  }
  if (/credit balance|insufficient|out of credit|quota|usage limit|limit reached|too low|daily.*limit|weekly.*limit|limit.*exceeded|reached.*limit/.test(low)) {
    return usageLimitMessage(false)!;
  }
  if (/\b529\b|overloaded/.test(low)) {
    return "🌀 The API is overloaded right now. Try again shortly.";
  }
  if (/\b401\b|unauthorized|authentication|invalid.{0,12}api.?key|oauth|not logged in|login/.test(low)) {
    return "🔑 Authentication failed. Check ANTHROPIC_API_KEY or re-run the `claude` CLI login, then restart.";
  }
  if (/abort/.test(low)) return "⏹ Stopped.";
  // A non-zero CLI exit ("process exited with code 1") is often an opaque proxy
  // for a usage limit the SDK didn't spell out. If the live probe shows a limit
  // sitting at 100%, that's almost certainly the cause — say so instead of the
  // generic failure, so the user knows to wait for the reset rather than retry.
  if (/exited with code|exit code|process (?:exited|failed)|non-?zero/.test(low)) {
    const usage = usageLimitMessage(true);
    if (usage) return usage;
  }
  const detail = raw.length > 600 ? raw.slice(0, 600) + "…" : raw;
  return `⚠️ That action failed.\n\n${detail}`;
}
