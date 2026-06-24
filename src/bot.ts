import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { config, allowedUserIds } from "./config.js";
import { authMiddleware } from "./auth.js";
import { registerCommands } from "./commands.js";
import { AUTO_ALLOWED_TOOLS, runTurn, type PermissionResult } from "./claude/runner.js";
import { createTelegramMcp } from "./mcp/sendFile.js";
import { memoryMcp } from "./mcp/memory.js";
import { tasksMcp } from "./mcp/tasks.js";
import { TelegramStreamer, type Streamer } from "./telegram/streamer.js";
import { DraftStreamer } from "./telegram/draftStreamer.js";
import { RichDraftStreamer } from "./telegram/richDraftStreamer.js";
import { PermissionManager, bashLeadCmd } from "./telegram/permissions.js";
import { downloadIncomingFile, isViewableImage, readImageInput } from "./telegram/files.js";
import { isGitCallback, resolveGitCallback } from "./telegram/gitFlow.js";
import { isProjectCallback, resolveProjectCallback } from "./telegram/projects.js";
import { transcribeAudio, voiceEnabled, voiceSetupHint } from "./telegram/voice.js";
import { schedules, type ScheduleRunner } from "./schedule/manager.js";
import { heartbeat } from "./core/heartbeat.js";
import { resolveMainRun } from "./core/mainSettings.js";
import { escapeHtml, normalizeAgentText } from "./telegram/formatting.js";
import type { ImageInput } from "./claude/runner.js";
import { sessions } from "./session/manager.js";
import { log, preview } from "./logger.js";

export function buildBot(): Telegraf {
  const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
  const permissions = new PermissionManager(bot.telegram);

  bot.use(authMiddleware);
  registerCommands(bot);

  // --- Tool-approval button presses ---
  bot.on("callback_query", async (ctx) => {
    const data =
      "data" in ctx.callbackQuery ? (ctx.callbackQuery.data as string) : undefined;
    if (data && permissions.isApprovalCallback(data)) {
      log.debug("Approval button pressed", { chatId: ctx.chat?.id, data });
      const toast = await permissions.resolve(data);
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
      // Image documents are shown to the model inline; everything else by path.
      const images = isViewableImage(path) ? await imageInputs(path) : undefined;
      // Fire-and-forget: must NOT block the polling loop, or approval button
      // presses can never be fetched (Telegraf awaits handlers before getUpdates).
      void runUserPrompt(permissions, ctx.chat.id, prompt, ctx.telegram, { images });
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
      void runUserPrompt(permissions, ctx.chat.id, prompt, ctx.telegram, {
        images: await imageInputs(path),
      });
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
      // Echo the transcript so the user sees what was understood, then run it.
      await ctx.replyWithHTML(`🎤 <i>${escapeHtml(text)}</i>`).catch(() => {});
      void runUserPrompt(permissions, chatId, text, ctx.telegram);
    } catch (err) {
      log.error("Voice handling failed", { chatId, error: errText(err) });
      await ctx.reply(`⚠️ Voice transcription failed: ${errText(err)}`);
    }
  });

  // --- Plain text prompts ---
  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // handled by command handlers
    void runUserPrompt(permissions, ctx.chat.id, text, ctx.telegram);
  });

  bot.catch((err, ctx) => {
    log.error("Unhandled bot error", { updateType: ctx.updateType, error: errText(err) });
  });

  // --- Scheduled prompts: run due jobs as autonomous turns, pushed to the chat ---
  const runScheduled: ScheduleRunner = async (s) => {
    if (sessions.get(s.chatId).busy) return false; // busy — retry next tick
    log.info("Scheduled task firing", { chatId: s.chatId, id: s.id });
    await bot.telegram
      .sendMessage(s.chatId, `⏰ <b>Scheduled task</b>\n<i>${escapeHtml(s.prompt)}</i>`, {
        parse_mode: "HTML",
      })
      .catch(() => {});
    // Autonomous: no one is present to approve, and the user authored the job.
    runUserPrompt(permissions, s.chatId, s.prompt, bot.telegram, {
      autonomous: true,
      cwd: s.cwd,
    });
    return true;
  };
  schedules.start(runScheduled);

  // --- Heartbeat: proactive host/kanban monitoring (off unless enabled) ---
  const alertTargets = [...allowedUserIds];
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
      runUserPrompt(permissions, chatId, prompt, bot.telegram, { autonomous: true });
      return true;
    },
  });

  return bot;
}

/**
 * Fire-and-forget wrapper around handleUserPrompt. The Telegram update handler
 * must return promptly so the long-polling loop keeps fetching updates (notably
 * approval button presses); the actual turn runs detached here. Guards against
 * unhandled rejections since no caller awaits it.
 */
interface TurnOptions {
  /** Images to include inline (vision). */
  images?: ImageInput[];
  /** Force bypassPermissions regardless of session mode (scheduled/unattended). */
  autonomous?: boolean;
  /** Run in this directory for this turn only (does not change session cwd). */
  cwd?: string;
}

function runUserPrompt(
  permissions: PermissionManager,
  chatId: number,
  prompt: string,
  tg: Telegraf["telegram"],
  opts: TurnOptions = {},
): void {
  handleUserPrompt(permissions, chatId, prompt, tg, opts).catch((err) => {
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
  chatId: number,
  prompt: string,
  tg: Telegraf["telegram"],
  opts: TurnOptions = {},
): Promise<void> {
  const { images, autonomous = false } = opts;
  const session = sessions.get(chatId);
  if (session.busy) {
    log.info("Prompt rejected — chat busy", { chatId });
    await tg.sendMessage(chatId, "⏳ Still working on the previous request. Send /stop to cancel.");
    return;
  }
  const cwd = opts.cwd ?? session.cwd;

  log.info("Prompt received", {
    chatId,
    mode: session.mode,
    resume: Boolean(session.sessionId),
    cwd: session.cwd,
    text: preview(prompt),
  });
  const startedAt = Date.now();

  session.busy = true;
  session.abort = new AbortController();

  // Immediate "Working on it…" ack so the chat shows the turn was accepted
  // before the first token arrives. In edit mode this very message becomes the
  // streamed reply; in the draft modes (whose final reply is a fresh message)
  // it is a standalone placeholder that we delete once the turn finishes.
  const ack = await tg.sendMessage(chatId, "💭 Working on it…").catch(() => undefined);
  let placeholderId: number | undefined;

  // rich/draft modes stream a native ephemeral preview; edit mode edits the ack
  // message in place.
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

  // Native "typing…" indicator for the whole turn (it expires after ~5s, so
  // refresh it). Runs in every mode, including before the first streamed token.
  await tg.sendChatAction(chatId, "typing").catch(() => {});
  const typing = setInterval(() => {
    void tg.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    const lead = toolName === "Bash" ? bashLeadCmd(input) : undefined;
    if (
      AUTO_ALLOWED_TOOLS.has(toolName) ||
      session.sessionAllowedTools.has(toolName) ||
      (lead !== undefined && session.allowedBashCmds.has(lead))
    ) {
      log.debug("Tool auto-allowed", { chatId, tool: toolName });
      return { behavior: "allow", updatedInput: input };
    }
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

  // Runtime model/provider override for the main agent (panel-configurable).
  const mainRun = resolveMainRun();

  try {
    const res = await runTurn({
      prompt,
      images,
      cwd,
      resume: session.sessionId,
      model: mainRun.model,
      env: mainRun.env,
      permissionMode: autonomous || session.mode === "auto" ? "bypassPermissions" : "default",
      abortController: session.abort,
      mcpServers: { telegram: createTelegramMcp(tg, chatId, cwd), memory: memoryMcp, tasks: tasksMcp },
      canUseTool,
      onText: (delta) => streamer.appendText(normalizeAgentText(delta)),
      onToolUse: (name, input) => {
        log.info("Tool use", { chatId, tool: name, arg: preview(summarizeArg(input), 80) });
        streamer.setStatus(`🔧 <i>${name}</i> ${summarizeInput(input)}`);
      },
      onSessionId: (id) => {
        log.debug("Session id", { chatId, sessionId: id });
        session.sessionId = id;
      },
    });

    // Timing is still tracked (logged below), just no longer shown in the reply.
    await streamer.finalize();
    sessions.recordUsage(chatId, res.costUsd ?? 0, res.durationMs ?? 0);
    log.info("Turn complete", {
      chatId,
      ms: Date.now() - startedAt,
      sdkMs: res.durationMs ?? null,
      isError: res.isError,
      chars: res.text?.length ?? 0,
    });
  } catch (err) {
    // Flush whatever streamed so far, then send the notice as its own message —
    // finalize() drops empty content, so an early failure would otherwise be silent.
    await streamer.finalize().catch(() => {});
    if (session.abort?.signal.aborted) {
      log.info("Turn stopped by user", { chatId, ms: Date.now() - startedAt });
      await tg.sendMessage(chatId, "⏹ Stopped.").catch(() => {});
    } else {
      log.error("Turn errored", { chatId, ms: Date.now() - startedAt, error: errText(err) });
      await tg.sendMessage(chatId, friendlyError(err)).catch(() => {});
    }
  } finally {
    clearInterval(typing);
    // Drop the standalone "Working on it…" ack (draft modes); in edit mode it
    // became the reply, so placeholderId is left unset and nothing is deleted.
    if (placeholderId !== undefined) {
      await tg.deleteMessage(chatId, placeholderId).catch(() => {});
    }
    session.busy = false;
    session.abort = undefined;
  }
}

/** Read a saved image into the inline-vision payload; undefined if unreadable. */
async function imageInputs(path: string): Promise<ImageInput[] | undefined> {
  try {
    const img = await readImageInput(path);
    return img ? [img] : undefined;
  } catch (err) {
    log.error("Failed to read image for vision", { path, error: errText(err) });
    return undefined;
  }
}

/** Raw, log-friendly summary of a tool's most relevant argument. */
function summarizeArg(input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  return String(obj.command ?? obj.file_path ?? obj.pattern ?? obj.path ?? "");
}

function summarizeInput(input: unknown): string {
  const s = summarizeArg(input);
  return s ? `<code>${escapeHtml(s.slice(0, 80))}</code>` : "";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turn a raw SDK/CLI error into a clear notice for the admin. The raw text now
 * includes the CLI's stderr tail (see runner.ts), so usage/credit/auth issues
 * are matchable and surfaced plainly instead of "process exited with code 1".
 */
function friendlyError(err: unknown): string {
  const raw = errText(err);
  const low = raw.toLowerCase();
  if (/\b429\b|rate.?limit/.test(low)) {
    return "⏳ Rate limited by the API. Give it a moment and try again.";
  }
  if (/credit balance|insufficient|out of credit|quota|usage limit|limit reached|too low/.test(low)) {
    return "💳 Usage limit / credits exhausted. Top up or wait for the limit to reset, then retry.";
  }
  if (/\b529\b|overloaded/.test(low)) {
    return "🌀 The API is overloaded right now. Try again shortly.";
  }
  if (/\b401\b|unauthorized|authentication|invalid.{0,12}api.?key|oauth|not logged in|login/.test(low)) {
    return "🔑 Authentication failed. Check ANTHROPIC_API_KEY or re-run the `claude` CLI login, then restart.";
  }
  if (/abort/.test(low)) return "⏹ Stopped.";
  const detail = raw.length > 600 ? raw.slice(0, 600) + "…" : raw;
  return `⚠️ That action failed.\n\n${detail}`;
}
