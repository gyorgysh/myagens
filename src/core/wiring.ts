/**
 * Background subsystem wiring, independent of any chat surface.
 *
 * Schedules, the heartbeat, self-update reports, update notices, delegated-task
 * outcomes and the suggestion inbox all used to be wired inside `buildBot()`,
 * which meant they only existed when a Telegram bot did — skipping Telegram
 * silently switched off half the product. They live here instead: started once
 * from `app.ts`, reporting through `notifyOwner()` so whichever surfaces are
 * running (Telegram, Slack, the panel, or none but the log) receive them, and
 * driving turns through a `TurnRunner` the caller supplies.
 *
 * The Telegram surface passes a runner that streams into the chat; a
 * panel-only install passes the panel one. Neither is referenced from here.
 */

import { schedules, type ScheduleRunner } from "../schedule/manager.js";
import { heartbeat } from "./heartbeat.js";
import { selfUpdate } from "./selfUpdate.js";
import { taskDelegator } from "./taskRunner.js";
import { createTask, startRecurrenceTicker } from "./tasks.js";
import { suggestions } from "./suggestions.js";
import { startUpdateNotify } from "./updateNotify.js";
import { consumeUpdateMarker, currentPackageVersion } from "./updateControl.js";
import { notifyOwner } from "./notify.js";
import { sessions } from "../session/manager.js";
import { mainChatId } from "./chatBridge.js";
import { escapeHtml } from "../telegram/formatting.js";
import { log } from "../logger.js";

/** Drives one autonomous turn on a session. Supplied by whichever surface owns it. */
export type TurnRunner = (
  chatId: number,
  prompt: string,
  opts: { autonomous?: boolean; cwd?: string; webhook?: unknown },
) => void;

export interface WiringOptions {
  runTurn: TurnRunner;
  /**
   * Surface-specific enrichment of a delegated-task outcome notice — the
   * Telegram path adds an inline Retry button and a formatted summary report.
   * Returning true means the surface handled the notice itself and the generic
   * one should be skipped.
   */
  reportTask?: (report: TaskReport) => Promise<boolean>;
}

/** The shape `taskDelegator.onReport` hands us, narrowed to what wiring needs. */
type TaskReport = Parameters<Parameters<typeof taskDelegator.onReport>[0]>[0];

/**
 * When a chat is busy at a schedule's firing time we don't drop the job: the
 * scheduler retries every tick (~30s). If it is still busy after this long, the
 * run moves to a background Kanban card so a long conversation never silently
 * swallows a scheduled run.
 */
const SCHED_BUSY_FALLBACK_MS = 5 * 60_000;

export function startBackgroundWiring(opts: WiringOptions): void {
  const { runTurn, reportTask } = opts;

  // --- Scheduled prompts ---
  const runScheduled: ScheduleRunner = async (s) => {
    if (sessions.get(s.chatId).busy) {
      const waited = s.busySince ? Date.now() - s.busySince : 0;
      if (waited < SCHED_BUSY_FALLBACK_MS) return "busy"; // retry next tick
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
        log.warn("Scheduled fallback delegate failed; will retry chat", { id: s.id, error: r.error });
        return "busy";
      }
      await notifyOwner({
        text: `Chat was busy, so I moved the scheduled run to a background task: ${s.prompt}`,
        telegram: { i18n: { key: "bot_scheduled_deferred", params: { prompt: escapeHtml(s.prompt) } } },
      });
      return "deferred";
    }
    log.info("Scheduled task firing", { chatId: s.chatId, id: s.id });
    await notifyOwner({
      text: `Running scheduled prompt: ${s.prompt}`,
      telegram: { i18n: { key: "bot_scheduled", params: { prompt: escapeHtml(s.prompt) } } },
    });
    runTurn(s.chatId, s.prompt, {
      autonomous: true,
      cwd: s.cwd,
      webhook: s.webhookUrl
        ? { url: s.webhookUrl, source: "schedule", title: s.prompt.slice(0, 120), id: s.id }
        : undefined,
    });
    return "started";
  };
  schedules.start(runScheduled);

  // Recurring kanban templates spawn fresh backlog copies on their own cadence,
  // independently of the panel; onRecurrenceFire pushes a live board refresh
  // when the panel happens to be up.
  startRecurrenceTicker();

  // Cards left "queued"/"running" by a crash have no in-memory run state left,
  // so mark them as a stale error the user can retry rather than leaving them
  // stuck on the board forever.
  const recovered = taskDelegator.reconcileStuck();
  if (recovered) log.info("Reconciled stuck tasks on boot", { count: recovered });

  // --- Self-update build/restart reports ---
  selfUpdate.start(async (text) => {
    await notifyOwner({ text });
  });

  // --- Heartbeat: proactive host/kanban monitoring (off unless enabled) ---
  heartbeat.start({
    notify: async (text) => {
      await notifyOwner({
        text,
        push: { title: "MyAgens heartbeat", kind: "heartbeat", tag: "heartbeat" },
      });
    },
    runActive: async (prompt) => {
      const chatId = mainChatId();
      if (sessions.get(chatId).busy) return false;
      runTurn(chatId, prompt, { autonomous: true });
      return true;
    },
  });

  // --- "New version available" notice ---
  startUpdateNotify();

  // --- "Back online" confirmation after an update/reload/self-update restart ---
  const appliedUpdate = consumeUpdateMarker();
  if (appliedUpdate) {
    const to = currentPackageVersion() ?? "?";
    const from = appliedUpdate.fromVersion;
    log.info("Update restart confirmed", { mode: appliedUpdate.mode, from, to });
    void notifyOwner({
      text: from && from !== to ? `Updated from v${from} to v${to}, back online.` : `v${to} is back online.`,
      telegram: {
        i18n:
          from && from !== to
            ? { key: "updatenotify_applied", params: { from, to } }
            : { key: "updatenotify_applied_same", params: { to } },
      },
      push: { title: "MyAgens updated", kind: "update", tag: "update" },
    });
  }

  // --- Delegated kanban card outcomes ---
  // These run via runTurn (not a chat turn), so they have no surface of their
  // own — report the outcome to the President here.
  taskDelegator.onReport(async (r) => {
    const by = r.leadName ? ` (${r.leadName})` : "";
    if (reportTask && (await reportTask(r).catch(() => false))) return;
    const notice =
      r.status === "ok"
        ? `Task done${by}: ${r.title}`
        : r.status === "stopped"
          ? `Task stopped${by}: ${r.title}`
          : `Task failed${by}: ${r.title}${r.error ? `: ${r.error}` : ""}`;
    await notifyOwner({
      text: notice,
      telegram: {
        i18n:
          r.status === "stopped"
            ? { key: "bot_task_stopped", params: { title: r.title, by } }
            : r.status === "error"
              ? { key: "bot_task_failed", params: { title: r.title, by, error: r.error ? `: ${r.error}` : "" } }
              : undefined,
      },
      push: {
        title: r.status === "ok" ? "Task done" : r.status === "stopped" ? "Task stopped" : "Task failed",
        kind: "task",
        tag: `task-${r.taskId}`,
        url: "/tasks",
      },
    });
  });

  // --- New inbox suggestion filed by an agent ---
  // A light ping so nothing waits unseen; the real triage happens in the inbox.
  suggestions.onAdd(async (s) => {
    const n = suggestions.pendingCount();
    const cat = s.category ? ` [${s.category}]` : "";
    await notifyOwner({
      text: `${s.fromAgentName}${cat} filed a suggestion: ${s.title} (${n} pending)`,
      telegram: {
        i18n: {
          key: "bot_inbox_suggestion",
          params: {
            agent: escapeHtml(s.fromAgentName),
            category: escapeHtml(cat),
            title: escapeHtml(s.title),
            count: n,
          },
        },
      },
    });
  });
}
