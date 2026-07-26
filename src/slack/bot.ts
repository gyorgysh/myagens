import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { App } from "@slack/bolt";
import { config, slackAllowedUserIds, slackConfigured } from "../config.js";
import { slackSessions, type SlackSession } from "./session.js";
import { SlackStreamer } from "./streamer.js";
import { SlackPermissionManager } from "./permissions.js";
import { SlackAskQuestionManager } from "./askQuestion.js";
import { parseSlackCommand, runSlackCommand, slackCommandList, type SlackCommandCtx } from "./commands.js";
import { runTurnWithFallback } from "../core/fallback.js";
import { guardCwd } from "../core/cwdGuard.js";
import { isDryRun, dryRunDescription, DRY_RUN_TOOLS, resolveMainRunFor, mainFallbackSpec } from "../core/mainSettings.js";
import { AUTO_ALLOWED_TOOLS, isStaleSession, type ImageInput } from "../claude/runner.js";
import { AUTO_UNTIL_ERROR_TOOLS } from "../session/manager.js";
import { readImageInput } from "../telegram/files.js";
import { LoopDetector } from "../core/loopDetector.js";
import { bashLeadCmd } from "../telegram/permissions.js";
import { memoryMcp } from "../mcp/memory.js";
import { createTasksMcp } from "../mcp/tasks.js";
import { skillsMcp } from "../mcp/skills.js";
import { selfUpdateMcp } from "../mcp/selfUpdate.js";
import { buildConnectorMcps } from "../mcp/connectorsMcp.js";
import { buildImageGenMcps } from "../mcp/imageGenMcp.js";
import { webhookMcps } from "../mcp/webhookMcp.js";
import { tmuxMcp } from "../mcp/tmuxMcp.js";
import { createCrewMcp } from "../mcp/crew.js";
import { workers } from "../core/workers.js";
import { suggestions } from "../core/suggestions.js";
import { agentUsage } from "../core/agentUsage.js";
import { reflectOnTurn } from "../core/reflect.js";
import { isPlanningPrompt } from "../core/planningMode.js";
import { log, preview } from "../logger.js";
import { errText, friendlyError } from "../telegram/errors.js";
import { summarizeArg, toolDiffMeta } from "../telegram/formatting.js";
import { summarizeInputMrkdwn } from "./formatting.js";
import type { PermissionResult } from "../claude/runner.js";
import type { Autonomy } from "../session/manager.js";

export interface SlackBotInstance {
  app: App;
  permissions: SlackPermissionManager;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function buildSlackBot(): SlackBotInstance | undefined {
  if (!slackConfigured || !config.SLACK_BOT_TOKEN || !config.SLACK_APP_TOKEN) {
    log.info("Slack surface disabled — tokens or allowed users not configured");
    return undefined;
  }

  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    socketMode: true,
  });

  const permissions = new SlackPermissionManager(app.client, slackAllowedUserIds);
  const asks = new SlackAskQuestionManager(app.client);

  // Handle interactive approval button clicks from Block Kit
  app.action(/^approval_.+$/, async ({ action, body, ack }) => {
    await ack();
    const actionId = (action as { action_id?: string }).action_id;
    const userId = body.user.id;
    log.debug("Slack block action received", { kind: "approval", actionId, userId });
    if (actionId && userId) {
      permissions.handleAction(actionId, userId);
    }
  });

  // Handle interactive AskUserQuestion button clicks from Block Kit
  app.action(/^askq_.+$/, async ({ action, body, ack }) => {
    await ack();
    const actionId = (action as { action_id?: string }).action_id;
    const userId = body.user.id;
    log.debug("Slack block action received", { kind: "askq", actionId, userId });
    if (!actionId || !userId) return;
    if (!slackAllowedUserIds.has(userId)) {
      log.warn("Ask button ignored — user not allowed (Slack)", { userId, actionId });
      return;
    }
    await asks.handleAction(actionId);
  });

  // Handle incoming messages (DM only)
  app.message(async ({ message, say }) => {
    // Allow file_share messages (image/file uploads); ignore other subtypes
    if (message.subtype && message.subtype !== "file_share") return;

    // Direct message channel IDs start with 'D'
    const isDm = message.channel_type === "im" || message.channel.startsWith("D");
    if (!isDm) return;

    const msgObj = message as unknown as { user?: string; channel: string; text?: string; files?: Array<{ url_private_download?: string; url_private?: string; name?: string; mimetype?: string }> };
    const userId = msgObj.user;
    if (!userId || !slackAllowedUserIds.has(userId)) {
      log.warn("Slack message rejected — user not allowed", { userId, channel: msgObj.channel });
      return;
    }

    let text = msgObj.text?.trim() ?? "";
    const images: ImageInput[] = [];

    const cmdCtx: SlackCommandCtx = {
      userId,
      channel: msgObj.channel,
      say: (t) => say(t),
      asks,
      permissions,
    };

    // Commands run before everything else, including the busy guard: `!stop`
    // is the escape hatch from a wedged turn, so it must work while busy.
    const cmd = text ? parseSlackCommand(text) : undefined;
    if (cmd && (await runSlackCommand(cmd.name, cmd.args, cmdCtx))) return;

    // A turn parked on a question or an approval is blocked on a promise no
    // message can reach, so consume the reply as the answer rather than
    // starting a new turn (the asking turn still holds busy=true). Buttons
    // only reach us when the Slack app has Interactivity enabled — typing is
    // the path that always works.
    if (text && asks.hasPending(msgObj.channel) && asks.answerTyped(msgObj.channel, text)) return;
    if (text && permissions.hasPending(msgObj.channel) && permissions.answerTyped(msgObj.channel, text) !== undefined) {
      return;
    }

    // Process attached files / images
    if (msgObj.files && msgObj.files.length > 0 && config.SLACK_BOT_TOKEN) {
      const session = slackSessions.get(userId);
      const uploadsDir = join(session.cwd, "uploads");
      await mkdir(uploadsDir, { recursive: true });

      for (const file of msgObj.files) {
        const downloadUrl = file.url_private_download || file.url_private;
        if (!downloadUrl) continue;

        try {
          const res = await fetch(downloadUrl, {
            headers: { Authorization: `Bearer ${config.SLACK_BOT_TOKEN}` },
          });
          if (!res.ok) continue;

          const fileName = (file.name || `file_${Date.now()}`).replace(/[^\w.\-]+/g, "_");
          const localPath = join(uploadsDir, fileName);
          const buffer = Buffer.from(await res.arrayBuffer());
          await writeFile(localPath, buffer);

          const imageInput = await readImageInput(localPath);
          if (imageInput) {
            images.push(imageInput);
          } else {
            text += `\n[Attached file saved to: ${localPath}]`;
          }
        } catch (err) {
          log.error("Failed to download Slack file attachment", { error: errText(err) });
        }
      }
    }

    if (!text && images.length === 0) return;

    // Handle user prompt in background turn execution
    void handleSlackPrompt(permissions, asks, userId, msgObj.channel, text || "What's in this image?", say, images);
  });

  // Slash commands only arrive when the workspace admin declared them on the
  // Slack app under "Slash Commands"; the `!name` form above needs no setup.
  for (const { name } of slackCommandList()) {
    app.command(`/${name}`, async ({ command, ack, respond }) => {
      await ack();
      const userId = command.user_id;
      if (!slackAllowedUserIds.has(userId)) {
        log.warn("Slack command rejected — user not allowed", { userId, command: name });
        return;
      }
      await runSlackCommand(name, (command.text ?? "").trim(), {
        userId,
        channel: command.channel_id,
        // Slash-command output goes back through respond() so it lands in the
        // channel the command was typed in, even outside a DM.
        say: (text) => respond({ text, response_type: "in_channel" }),
        asks,
        permissions,
      });
    });
  }

  return {
    app,
    permissions,
    start: async () => {
      await app.start();
      log.info("Slack surface started (Socket Mode)");
    },
    stop: async () => {
      permissions.destroy();
      await app.stop();
      log.info("Slack surface stopped");
    },
  };
}

async function handleSlackPrompt(
  permissions: SlackPermissionManager,
  asks: SlackAskQuestionManager,
  userId: string,
  channel: string,
  prompt: string,
  say: (text: string) => Promise<unknown>,
  images?: ImageInput[],
): Promise<void> {
  const session = slackSessions.get(userId);

  if (session.busy) {
    log.info("Slack prompt rejected — user session busy", { userId });
    // Say what the turn is stuck on: a turn parked on a question or approval
    // looks identical to a slow one from the outside, and the way out differs.
    const blockedOn = asks.hasPending(channel)
      ? "I'm waiting on your answer to the question above — reply to it, or `!stop` to abort."
      : permissions.hasPending(channel)
        ? "I'm waiting on your approval above — reply `yes` / `no`, or `!stop` to abort."
        : "I'm currently busy working on another task. `!stop` aborts it.";
    await say(`_${blockedOn}_`).catch(() => {});
    return;
  }

  const cwd = guardCwd(session.cwd, { userId });
  if (cwd !== session.cwd) {
    session.cwd = cwd;
    slackSessions.save();
  }

  log.info("Slack prompt received", {
    userId,
    channel,
    autonomy: session.autonomy,
    resume: Boolean(session.sessionId),
    cwd: session.cwd,
    text: preview(prompt),
  });

  const startedAt = Date.now();
  const turnSeq = (session.turnSeq = (session.turnSeq ?? 0) + 1);
  session.busy = true;
  session.busySince = startedAt;
  session.busyPrompt = prompt;
  session.abort = new AbortController();

  const mainRun = resolveMainRunFor({ autonomous: false, interactive: true });
  const workingText = mainRun.fallbackBackendActive
    ? `:information_source: _Primary model usage is over the threshold, switching to fallback model for this turn..._`
    : `_Working on it..._`;

  const streamer = new SlackStreamer(permissions.webClient, channel);
  await streamer.start(workingText);

  const autonomy: Autonomy = session.autonomy;
  if (autonomy === "auto_until_error") slackSessions.resetEscalation(userId);

  const loopDetector = new LoopDetector(config.LOOP_THRESHOLD);

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    // AskUserQuestion has a TUI-native picker with no Slack equivalent, so we
    // intercept it: render the questions as Block Kit buttons (with a
    // free-text fallback), then hand the collected answers back to the model
    // as the tool result via a deny message. Runs in every autonomy mode.
    if (toolName === "AskUserQuestion") {
      log.info("AskUserQuestion intercepted — prompting user (Slack)", { userId });
      await streamer.breakForInterrupt();
      const answer = await asks.ask(channel, input);
      return { behavior: "deny", message: answer };
    }

    if (isDryRun() && DRY_RUN_TOOLS.includes(toolName as (typeof DRY_RUN_TOOLS)[number])) {
      const what = dryRunDescription(toolName, input);
      log.info("Dry-run: skipped mutating tool (Slack)", { userId, tool: toolName, what });
      return {
        behavior: "deny",
        message: `[dry-run] Skipped — would have ${what}. Dry-run mode is on, so this was not executed. Continue narrating the remaining intended steps; do not retry this tool.`,
      };
    }

    const lead = toolName === "Bash" ? bashLeadCmd(input) : undefined;
    const loop = loopDetector.record(toolName, input);
    if (loop.isLoop) {
      log.warn("Loop detected in Slack turn — stopping call", { userId, tool: toolName, count: loop.count });
      return { behavior: "deny", message: "Skipped repeated call (loop detected)." };
    }

    if (autonomy === "standard") {
      if (
        AUTO_ALLOWED_TOOLS.has(toolName) ||
        session.sessionAllowedTools.has(toolName) ||
        (lead !== undefined && session.allowedBashCmds.has(lead))
      ) {
        log.debug("Tool auto-allowed (Slack)", { userId, tool: toolName });
        return { behavior: "allow", updatedInput: input };
      }
    } else if (autonomy === "auto_until_error") {
      const cooldown = session.escalation?.cooldown ?? 0;
      if (cooldown > 0) {
        session.escalation = { cooldown: cooldown - 1 };
      } else if (
        AUTO_ALLOWED_TOOLS.has(toolName) ||
        AUTO_UNTIL_ERROR_TOOLS.includes(toolName as (typeof AUTO_UNTIL_ERROR_TOOLS)[number]) ||
        session.sessionAllowedTools.has(toolName) ||
        (lead !== undefined && session.allowedBashCmds.has(lead))
      ) {
        return { behavior: "allow", updatedInput: input };
      }
    }

    log.info("Slack approval requested", { userId, tool: toolName });
    await streamer.breakForInterrupt();
    const choice = await permissions.request(channel, toolName, input);
    log.info("Slack approval resolved", { userId, tool: toolName, choice });

    if (choice === "always") {
      session.sessionAllowedTools.add(toolName);
      slackSessions.save();
      return { behavior: "allow", updatedInput: input };
    }
    if (choice === "alwayscmd" && lead) {
      session.allowedBashCmds.add(lead);
      slackSessions.save();
      return { behavior: "allow", updatedInput: input };
    }
    if (choice === "allow" || choice === "alwayscmd") {
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: "User denied this action." };
  };



  const leads = workers.list().filter((w) => w.role === "lead" && w.enabled);
  const crew =
    leads.length > 0
      ? leads
          .map((w) => `- ${w.name}${w.portfolio ? ` (${w.portfolio} Lead)` : ""}`)
          .join("\n")
      : undefined;

  const pendingItems = suggestions.pending();
  const pendingSuggestions =
    pendingItems.length > 0
      ? pendingItems.slice(0, 10).map((s) => `- ${s.id} · ${s.fromAgentName}: ${s.title}`).join("\n")
      : undefined;

  const crewMcp = createCrewMcp({
    notify: async (text) => {
      await permissions.webClient.chat.postMessage({ channel, text: `_${text}_` }).catch(() => {});
    },
    primaryChatId: 0,
    fromAgentId: "atlas",
    callerAutonomy: autonomy,
    callerPlanning: isPlanningPrompt(prompt),
  });

  try {
    const res = await runTurnWithFallback(mainRun.backendId, {
      prompt,
      images,
      cwd,
      // Drop the resume token when the threshold fallback switched to another
      // backend (a Claude resume UUID means nothing to Grok/Codex/Ollama).
      resume: mainRun.fallbackBackendActive ? undefined : session.sessionId,
      model: mainRun.model,
      env: mainRun.env,
      crew,
      pendingSuggestions,
      knownPaths: mainRun.knownPaths,
      persona: mainRun.persona,
      promptExclude: mainRun.promptExclude,
      cursorTools: mainRun.cursorTools,
      tmux: mainRun.tmux,
      language: session.language ?? mainRun.defaultLanguage,
      permissionMode: autonomy === "full" && !isDryRun() ? "bypassPermissions" : "default",
      abortController: session.abort,
      mcpServers: {
        memory: memoryMcp,
        tasks: createTasksMcp({ createdBy: "atlas" }),
        skills: skillsMcp,
        self_update: selfUpdateMcp,
        crew: crewMcp,
        tmux: tmuxMcp,
        ...buildConnectorMcps(),
        ...buildImageGenMcps(),
        ...webhookMcps(),
      },
      canUseTool,
      onText: (delta) => {
        streamer.appendText(delta);
      },
      onToolUse: (name, input) => {
        const diff = toolDiffMeta(name, input);
        log.info("Tool use (Slack)", { userId, tool: name, arg: preview(summarizeArg(input), 300), ...(diff ?? {}) });
        streamer.setStatus(`:wrench: _${name}_ ${summarizeInputMrkdwn(input)}`);
      },
      onSessionId: (id) => {
        session.sessionId = id;
      },
      onToolResult: (isError) => {
        if (isError && autonomy === "auto_until_error") {
          slackSessions.noteToolError(userId);
        }
      },
    }, mainFallbackSpec());

    await streamer.finalize();

    const turnUsage = {
      costUsd: res.costUsd ?? 0,
      durationMs: res.durationMs ?? 0,
      inputTokens: res.tokens?.inputTokens ?? 0,
      outputTokens: res.tokens?.outputTokens ?? 0,
      cacheReadTokens: res.tokens?.cacheReadTokens ?? 0,
      cacheWriteTokens: res.tokens?.cacheWriteTokens ?? 0,
    };
    slackSessions.recordUsage(userId, turnUsage);
    agentUsage.record(config.ATLAS_NAME, "atlas", turnUsage);

    if (!res.isError && res.toolCalls?.length) {
      void reflectOnTurn(prompt, res.toolCalls, res, 0);
    }
  } catch (err) {
    await streamer.finalize().catch(() => {});
    if (isStaleSession(err) && session.sessionId) {
      session.sessionId = undefined;
      slackSessions.save();
      await say("_Session expired. Retrying on a fresh conversation..._").catch(() => {});
      // Release the turn before re-dispatching — the retry goes through the
      // same busy guard, and this turn's `finally` is skipped by the turnSeq
      // check once the retry claims the session.
      releaseTurn(session, turnSeq);
      void handleSlackPrompt(permissions, asks, userId, channel, prompt, say, images);
      return;
    }
    log.error("Slack turn errored", { userId, error: errText(err) });
    await say(`:warning: ${friendlyError(err)}`).catch(() => {});
  } finally {
    releaseTurn(session, turnSeq);
  }
}

/**
 * Clear the busy flags, unless a newer turn (or the stop command) already claimed the
 * session — a stale turn finishing late must not unlock its replacement.
 */
function releaseTurn(session: SlackSession, turnSeq: number): void {
  if (session.turnSeq !== turnSeq) return;
  session.busy = false;
  session.busySince = undefined;
  session.busyPrompt = undefined;
  session.abort = undefined;
}
