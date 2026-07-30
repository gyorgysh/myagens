/**
 * Atlas turns driven from the panel, with no chat surface involved.
 *
 * When Telegram is configured, the President's conversation is owned by
 * `bot.ts` (`handleUserPrompt`) and the panel is a window onto it. When it is
 * not, this module attaches to the same `chatBridge` and runs the turn itself,
 * against the same `Session` (`PANEL_CHAT_ID`) so cwd, autonomy, the resume
 * token and the "always allow" presets all behave identically.
 *
 * It is deliberately a smaller flow than the Telegram one rather than a
 * refactor of it: there is no streamer, no typing indicator, no voice reply and
 * no inline keyboards to build. What it does keep is everything that makes a
 * turn an Atlas turn — the full MCP server set, the crew context, autonomy-aware
 * tool gating, loop detection, usage accounting and stale-session recovery.
 *
 * Approvals go to `panelApprovals.ts` and questions to `agentAsks`, both of
 * which settle through the panel's existing queues, so the Chat view's approval
 * bar and question cards work exactly as they do alongside Telegram.
 */

import { config } from "../config.js";
import { sessions, AUTO_UNTIL_ERROR_TOOLS, type Autonomy } from "../session/manager.js";
import { chatBridge, mainChatId } from "./chatBridge.js";
import { PanelApprovalManager } from "./panelApprovals.js";
import { agentAsks } from "./agentAskQuestion.js";
import { LoopDetector } from "./loopDetector.js";
import { runTurnWithFallback } from "./fallback.js";
import { resolveMainRunFor, mainFallbackSpec, isDryRun, dryRunDescription, DRY_RUN_TOOLS } from "./mainSettings.js";
import { workers } from "./workers.js";
import { suggestions } from "./suggestions.js";
import { agentUsage } from "./agentUsage.js";
import { notifyOwner } from "./notify.js";
import { guardCwd } from "./cwdGuard.js";
import { isPlanningPrompt } from "./planningMode.js";
import { reflectOnTurn } from "./reflect.js";
import { AUTO_ALLOWED_TOOLS, isStaleSession, type ImageInput, type PermissionResult } from "../claude/runner.js";
import { memoryMcp } from "../mcp/memory.js";
import { createTasksMcp } from "../mcp/tasks.js";
import { skillsMcp } from "../mcp/skills.js";
import { selfUpdateMcp } from "../mcp/selfUpdate.js";
import { createCrewMcp } from "../mcp/crew.js";
import { tmuxMcp } from "../mcp/tmuxMcp.js";
import { buildConnectorMcps } from "../mcp/connectorsMcp.js";
import { buildImageGenMcps } from "../mcp/imageGenMcp.js";
import { webhookMcps } from "../mcp/webhookMcp.js";
import { bashLeadCmd } from "../telegram/permissions.js";
import { summarizeArg, toolDiffMeta } from "../telegram/formatting.js";
import { log, preview } from "../logger.js";

/**
 * Created by `attachPanelChatRunner()`, never at module load.
 *
 * Constructing it claims the "main" slot in the shared `approvalQueue`, which
 * is the same slot Telegram's `PermissionManager` claims. This module is
 * imported unconditionally by app.ts, so building it eagerly would register a
 * second resolver for that slot on every Telegram install and the last one to
 * attach would silently win.
 */
let approvals: PanelApprovalManager;

/**
 * Attach the panel as the President's turn runner. Called from app.ts only when
 * there is no Telegram bot to attach instead — exactly one runner owns the
 * bridge, so the two can never both drive the same session.
 */
export function attachPanelChatRunner(): void {
  approvals = new PanelApprovalManager();
  chatBridge.attach(
    (chatId, prompt, images) => {
      void runPanelTurn(chatId, prompt, { images }).catch((err) => {
        const session = sessions.get(chatId);
        session.busy = false;
        session.busySince = undefined;
        session.busyPrompt = undefined;
        session.abort = undefined;
        chatBridge.mirrorBusy(false);
        log.error("Panel turn failed", { chatId, error: errText(err) });
      });
    },
    (chatId) => sessions.get(chatId).abort?.abort(),
  );
  log.info("Panel chat runner attached (no Telegram surface)");
}

export interface PanelTurnOptions {
  images?: ImageInput[];
  /** Force bypassPermissions regardless of session autonomy (schedules, heartbeat). */
  autonomous?: boolean;
  /** Run in this directory for this turn only (does not change the session cwd). */
  cwd?: string;
}

/**
 * Run one Atlas turn against the panel session. Exported so the background
 * subsystems (schedules, heartbeat's active mode) can drive an autonomous turn
 * through the same path a panel-typed message takes.
 */
export async function runPanelTurn(
  chatId: number,
  prompt: string,
  opts: PanelTurnOptions = {},
): Promise<void> {
  const { images, autonomous = false } = opts;
  const session = sessions.get(chatId);
  if (autonomous) sessions.markSeen(chatId);
  if (session.busy) {
    log.info("Panel prompt rejected, chat busy", { chatId });
    return;
  }

  const requestedCwd = opts.cwd ?? session.cwd;
  const cwd = guardCwd(requestedCwd, { chatId });
  if (cwd !== requestedCwd && !opts.cwd) {
    session.cwd = cwd;
    sessions.save();
  }

  const mirror = chatBridge.isEnabled() && chatId === mainChatId();
  // An autonomous turn is mirrored too: the panel Chat view is the only place
  // the President would otherwise see a scheduled or heartbeat run happen.
  if (mirror) {
    chatBridge.mirrorUser(prompt);
    chatBridge.mirrorBusy(true);
  }

  log.info("Prompt received", {
    chatId,
    surface: "panel",
    autonomy: session.autonomy,
    resume: Boolean(session.sessionId),
    cwd,
    text: preview(prompt),
  });
  const startedAt = Date.now();

  session.busy = true;
  session.busySince = startedAt;
  session.busyPrompt = prompt.slice(0, 120);
  session.abort = new AbortController();
  let retryStale = false;

  const mainRun = resolveMainRunFor({ autonomous, interactive: true });
  const autonomy: Autonomy = autonomous ? "full" : session.autonomy;
  if (autonomy === "auto_until_error") sessions.resetEscalation(chatId);

  const loopDetector = new LoopDetector(config.LOOP_THRESHOLD);

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    if (toolName === "AskUserQuestion") {
      log.info("AskUserQuestion intercepted, prompting user", { chatId, surface: "panel" });
      // undefined agentId → renders in the main Chat view, not an agent pane.
      const answer = await agentAsks.ask(undefined, input);
      return { behavior: "deny", message: answer };
    }

    if (isDryRun() && DRY_RUN_TOOLS.includes(toolName as (typeof DRY_RUN_TOOLS)[number])) {
      const what = dryRunDescription(toolName, input);
      log.info("Dry-run: skipped mutating tool", { chatId, tool: toolName, what });
      return {
        behavior: "deny",
        message: `[dry-run] Skipped — would have ${what}. Dry-run mode is on, so this was not executed. Continue narrating the remaining intended steps; do not retry this tool.`,
      };
    }

    const lead = toolName === "Bash" ? bashLeadCmd(input) : undefined;

    // Loop guard first, so a runaway retry is caught even for auto-allowed
    // tools. With no chat surface there is no Skip / Approve-once prompt to
    // show, so a detected loop denies the repeat and tells the model why.
    const loop = loopDetector.record(toolName, input);
    if (loop.isLoop) {
      log.warn("Loop detected, denying repeat", { chatId, tool: toolName, count: loop.count });
      loopDetector.silence(loop.hash);
      return {
        behavior: "deny",
        message: `This exact ${toolName} call has already run ${loop.count} times this turn with no progress. Stop retrying it and try a different approach, or explain what is blocking you.`,
      };
    }

    if (autonomy === "standard") {
      if (
        AUTO_ALLOWED_TOOLS.has(toolName) ||
        session.sessionAllowedTools.has(toolName) ||
        (lead !== undefined && session.allowedBashCmds.has(lead))
      ) {
        return { behavior: "allow", updatedInput: input };
      }
    } else if (autonomy === "auto_until_error") {
      const cooldown = session.escalation?.cooldown ?? 0;
      if (cooldown > 0) {
        session.escalation = { cooldown: cooldown - 1 };
        log.info("auto_until_error: escalated to prompt", { chatId, tool: toolName, cooldown });
      } else if (
        AUTO_ALLOWED_TOOLS.has(toolName) ||
        AUTO_UNTIL_ERROR_TOOLS.includes(toolName as (typeof AUTO_UNTIL_ERROR_TOOLS)[number]) ||
        session.sessionAllowedTools.has(toolName) ||
        (lead !== undefined && session.allowedBashCmds.has(lead))
      ) {
        return { behavior: "allow", updatedInput: input };
      }
    }
    // supervised: always prompt.

    log.info("Approval requested", { chatId, tool: toolName, surface: "panel" });
    const choice = await approvals.request(chatId, toolName, input);
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

  const pendingItems = suggestions.pending();
  const pendingSuggestions =
    pendingItems.length > 0
      ? [
          ...pendingItems
            .slice(0, 10)
            .map((s) => `- ${s.id} · ${s.fromAgentName}${s.category ? ` [${s.category}]` : ""}: ${s.title}`),
          pendingItems.length > 10 ? `…and ${pendingItems.length - 10} more` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : undefined;

  const crewMcp = createCrewMcp({
    notify: async (text: string) => notifyOwner({ text }),
    primaryChatId: chatId,
    fromAgentId: "atlas",
    callerAutonomy: autonomy,
    callerPlanning: isPlanningPrompt(prompt),
  });

  const mirrorMsgId = mirror ? chatBridge.mirrorStart() : "";
  let mirrorText = "";
  let loopAborted = false;
  /** What the turn actually did, handed to the post-turn reflection pass. */
  const toolCalls: Array<{ name: string; input: unknown }> = [];

  const onFallback = (name: string) => {
    if (mirror) {
      chatBridge.mirrorDelta(mirrorMsgId, `\n_Primary model unavailable, retrying via ${name}…_\n`);
    }
  };

  try {
    const res = await runTurnWithFallback(
      mainRun.backendId,
      {
        prompt,
        images,
        cwd,
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
          // No `telegram` server here: send_file has no chat to push a file to.
          // The panel's own file views are how a produced file is retrieved.
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
          if (mirror) {
            mirrorText += delta;
            chatBridge.mirrorDelta(mirrorMsgId, delta);
          }
        },
        onToolUse: (name, input) => {
          toolCalls.push({ name, input });
          const diff = toolDiffMeta(name, input);
          log.info("Tool use", { chatId, tool: name, arg: preview(summarizeArg(input), 300), ...(diff ?? {}) });
          if (mirror) chatBridge.mirrorTool(mirrorMsgId, name, preview(summarizeArg(input), 120));

          // In "full" autonomy the SDK runs in bypassPermissions and never calls
          // canUseTool, so the gate above can't fire. Catch the runaway here and
          // abort, so an unattended run can't burn tokens retrying forever.
          if (autonomy === "full" && !loopAborted) {
            const loop = loopDetector.record(name, input);
            if (loop.isLoop) {
              loopAborted = true;
              log.warn("Loop detected in autonomous run, aborting", { chatId, tool: name, count: loop.count });
              void notifyOwner({
                text: `Aborted a run: ${name} repeated ${loop.count} times with no progress.`,
              });
              session.abort?.abort();
            }
          }
        },
        onSessionId: (id) => {
          session.sessionId = id;
        },
        onToolResult: (isError) => {
          if (isError && autonomy === "auto_until_error") {
            sessions.noteToolError(chatId);
            log.info("auto_until_error: tool error, escalating to supervised", { chatId });
          }
        },
      },
      mainFallbackSpec(),
      onFallback,
    );

    if (mirror) {
      chatBridge.mirrorEnd(mirrorMsgId, res.text?.trim() || mirrorText, {
        error: res.isError,
        costUsd: res.costUsd,
      });
    }

    const turnUsage = {
      costUsd: res.costUsd ?? 0,
      durationMs: res.durationMs ?? Date.now() - startedAt,
      inputTokens: res.tokens?.inputTokens ?? 0,
      outputTokens: res.tokens?.outputTokens ?? 0,
      cacheReadTokens: res.tokens?.cacheReadTokens ?? 0,
      cacheWriteTokens: res.tokens?.cacheWriteTokens ?? 0,
    };
    sessions.recordUsage(chatId, turnUsage);
    agentUsage.record("Atlas", "atlas", turnUsage);

    // Post-turn reflection (memory + skill distillation), same gating as the
    // Telegram path — it decides internally whether the turn was worth it.
    void reflectOnTurn(
      prompt,
      toolCalls,
      { text: res.text, costUsd: res.costUsd, durationMs: turnUsage.durationMs },
      chatId,
    ).catch((err) => log.debug("Reflection failed", { error: errText(err) }));
  } catch (err) {
    const stopped = session.abort?.signal.aborted ?? false;
    if (!stopped && isStaleSession(err) && session.sessionId) {
      // The stored resume token is gone (a CLI restart, an expired session).
      // Drop it and silently re-run the same prompt fresh, exactly as the
      // Telegram path does, rather than making the user resend.
      log.warn("Stale session, clearing resume token and retrying fresh", { chatId });
      session.sessionId = undefined;
      sessions.save();
      retryStale = true;
      session.busy = false;
      session.abort = undefined;
      await runPanelTurn(chatId, prompt, opts);
      return;
    }
    const text = stopped ? mirrorText : mirrorText || errText(err);
    if (mirror) chatBridge.mirrorEnd(mirrorMsgId, text, { error: !stopped });
    if (!stopped) log.error("Turn failed", { chatId, error: errText(err) });
  } finally {
    if (!retryStale) {
      session.busy = false;
      session.busySince = undefined;
      session.busyPrompt = undefined;
      session.abort = undefined;
      sessions.save();
      if (mirror) chatBridge.mirrorBusy(false);
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
