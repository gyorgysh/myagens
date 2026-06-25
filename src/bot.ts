import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { config, allowedUserIds } from "./config.js";
import { authMiddleware } from "./auth.js";
import { registerCommands } from "./commands.js";
import { AUTO_ALLOWED_TOOLS, runTurn, type PermissionResult } from "./claude/runner.js";
import { createTelegramMcp } from "./mcp/sendFile.js";
import { memoryMcp } from "./mcp/memory.js";
import { tasksMcp } from "./mcp/tasks.js";
import { skillsMcp } from "./mcp/skills.js";
import { selfUpdateMcp } from "./mcp/selfUpdate.js";
import { selfUpdate } from "./core/selfUpdate.js";
import { createCrewMcp } from "./mcp/crew.js";
import { TelegramStreamer, type Streamer } from "./telegram/streamer.js";
import { DraftStreamer } from "./telegram/draftStreamer.js";
import { RichDraftStreamer } from "./telegram/richDraftStreamer.js";
import { sendFormattedMarkdown, sendRichMarkdown, sendExpandableQuote } from "./telegram/send.js";
import { PermissionManager, bashLeadCmd } from "./telegram/permissions.js";
import { downloadIncomingFile, isViewableImage, readImageInput } from "./telegram/files.js";
import { isGitCallback, resolveGitCallback } from "./telegram/gitFlow.js";
import { isProjectCallback, resolveProjectCallback } from "./telegram/projects.js";
import { isModelCallback, resolveModelCallback } from "./commands.js";
import { transcribeAudio, voiceEnabled, voiceSetupHint } from "./telegram/voice.js";
import { schedules, type ScheduleRunner } from "./schedule/manager.js";
import { heartbeat } from "./core/heartbeat.js";
import { taskDelegator } from "./core/taskRunner.js";
import { resolveMainRun } from "./core/mainSettings.js";
import { workers } from "./core/workers.js";
import { escapeHtml, normalizeAgentText } from "./telegram/formatting.js";
import { resolveAsk, hasPendingAsk } from "./core/crewAsk.js";
import { reflectOnTurn } from "./core/reflect.js";
import type { ImageInput, RunResult } from "./claude/runner.js";
import type { Autonomy } from "./session/manager.js";
import { sessions } from "./session/manager.js";
import { log, preview } from "./logger.js";
import { loadProbeResult } from "./core/usageProbe.js";

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
      const toast = await permissions.resolve(data, ctx.chat?.id);
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
    } else if (data && isModelCallback(data) && ctx.chat) {
      if (data.startsWith("mdl:noop")) {
        await ctx.answerCbQuery().catch(() => {});
      } else {
        log.debug("Model button pressed", { chatId: ctx.chat.id, data });
        const messageId = ctx.callbackQuery.message?.message_id;
        const toast = await resolveModelCallback(ctx.telegram, ctx.chat.id, messageId, data);
        await ctx.answerCbQuery(toast.slice(0, 200)).catch(() => {});
      }
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
    // If a crew agent is waiting for the president's reply, resolve it.
    if (hasPendingAsk(ctx.chat.id)) {
      if (resolveAsk(ctx.chat.id, text)) {
        log.info("crew_ask resolved by user", { chatId: ctx.chat.id });
        return;
      }
    }
    void runUserPrompt(permissions, ctx.chat.id, text, ctx.telegram);
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
    runUserPrompt(permissions, s.chatId, s.prompt, bot.telegram, {
      autonomous: true,
      cwd: s.cwd,
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
      runUserPrompt(permissions, chatId, prompt, bot.telegram, { autonomous: true });
      return true;
    },
  });

  // Delegated kanban cards run via runTurn (not handleUserPrompt), so they have
  // no Telegram path of their own — report their outcome to the president here.
  taskDelegator.onReport(async (r) => {
    const chatId = alertTargets[0];
    if (chatId === undefined) return;
    if (r.status === "ok" && r.res) {
      await sendSummaryReport(bot.telegram, chatId, r.res, `Task: ${r.title}`).catch(() => {});
      return;
    }
    const notice =
      r.status === "stopped"
        ? `⏹ Task stopped — ${r.title}`
        : `⚠️ Task failed — ${r.title}${r.error ? `: ${r.error}` : ""}`;
    await bot.telegram
      .sendMessage(chatId, `<i>${escapeHtml(notice)}</i>`, { parse_mode: "HTML" })
      .catch(() => {});
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
    void tg.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);

  // Effective autonomy for this turn.
  const autonomy: Autonomy = autonomous ? "full" : session.autonomy;

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    const lead = toolName === "Bash" ? bashLeadCmd(input) : undefined;

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
              `- ${w.name}${w.portfolio ? ` (${w.portfolio} Lead)` : ""}${w.systemPrompt ? `: ${w.systemPrompt.split("\n")[0]}` : ""}`,
          )
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

  try {
    const res = await runTurn({
      prompt,
      images,
      cwd,
      resume: session.sessionId,
      model: mainRun.model,
      env: mainRun.env,
      crew,
      persona: mainRun.persona,
      language: session.language ?? mainRun.defaultLanguage,
      permissionMode: autonomy === "full" ? "bypassPermissions" : "default",
      abortController: session.abort,
      mcpServers: {
        telegram: createTelegramMcp(tg, chatId, cwd),
        memory: memoryMcp,
        tasks: tasksMcp,
        skills: skillsMcp,
        self_update: selfUpdateMcp,
        crew: crewMcp,
      },
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
  } catch (err) {
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
    if (placeholderId !== undefined) {
      await tg.deleteMessage(chatId, placeholderId).catch(() => {});
    }
    session.busy = false;
    session.abort = undefined;
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

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) { const d = Math.floor(h / 24); return `${d} day${d === 1 ? "" : "s"}`; }
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function friendlyError(err: unknown): string {
  const raw = errText(err);
  const low = raw.toLowerCase();
  if (/\b429\b|rate.?limit/.test(low)) {
    return "⏳ Rate limited by the API. Give it a moment and try again.";
  }
  if (/credit balance|insufficient|out of credit|quota|usage limit|limit reached|too low|daily.*limit|weekly.*limit|limit.*exceeded|reached.*limit/.test(low)) {
    const probe = loadProbeResult();
    const now = Date.now();
    const exhausted = probe?.limits.filter((l) => l.percent >= 100) ?? [];
    const nearest = exhausted.sort((a, b) => a.resetsInMs - b.resetsInMs)[0];
    if (nearest) {
      const msLeft = Math.max(0, new Date(nearest.resetsAt).getTime() - now);
      return `📊 ${nearest.label} usage limit reached. Resets in ${fmtCountdown(msLeft)}.`;
    }
    const soonest = probe?.limits.filter((l) => l.percent > 0).sort((a, b) => a.resetsInMs - b.resetsInMs)[0];
    if (soonest) {
      const msLeft = Math.max(0, new Date(soonest.resetsAt).getTime() - now);
      return `📊 Usage limit exhausted. ${soonest.label} resets in ${fmtCountdown(msLeft)}.`;
    }
    return "📊 Usage limit exhausted. Wait for the limit to reset, then retry.";
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
