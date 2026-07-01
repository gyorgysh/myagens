import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Telegraf, Telegram } from "telegraf";
import { mainSettingsView, setMainSettings } from "./core/mainSettings.js";
import { config } from "./config.js";
import { AGENT_LANGUAGES, isValidLanguage, languageName } from "./core/languages.js";
import { runCouncil, formatCouncilTelegram } from "./core/council.js";
import { gatherDigest, isDigestEmpty, type DigestData } from "./core/digest.js";
import { sessions } from "./session/manager.js";
import { sendDiff } from "./telegram/gitFlow.js";
import { sendProjectsMenu } from "./telegram/projects.js";
import { sendInbox } from "./telegram/inboxFlow.js";
import { schedules, parseWhen, describeSpec } from "./schedule/manager.js";
import { listTemplates, templateVariables } from "./core/templates.js";
import * as git from "./git.js";
import { escapeHtml } from "./telegram/formatting.js";
import type { UsageStat } from "./session/store.js";
import { loadProbeResult, runProbe } from "./core/usageProbe.js";
import { getPlanSettings, billingPeriodStart, daysUntilReset } from "./core/planSettings.js";
import { checkForUpdate, runUpdate, runRestore, isUpdating } from "./core/updateControl.js";
import { isActive } from "./core/activity.js";
import { serviceInstalled } from "./core/agentControl.js";
import { listProviders } from "./core/providers.js";
import { fetchProviderModels } from "./core/providerModels.js";
import { resolveSecret } from "./core/vault.js";
import { tunnelManager } from "./core/tunnelManager.js";
import { ttsEnabled, ttsSetupHint } from "./telegram/tts.js";
import { t, langForChat, type TranslationKey } from "./telegram/i18n/index.js";
import { log } from "./logger.js";

// ---------------------------------------------------------------------------
// /model command helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Named shortcut buttons — short labels keep callback_data well under 64 B.
// ---------------------------------------------------------------------------
const MODEL_SHORTCUTS: { label: string; model: string }[] = [
  { label: "Opus 4.8",   model: "claude-opus-4-8" },
  { label: "Sonnet 5",   model: "claude-sonnet-5" },
  { label: "Haiku 4.5",  model: "claude-haiku-4-5-20251001" },
  { label: "Opus 4.5",   model: "claude-opus-4-5-20251101" },
  { label: "Sonnet 4.5", model: "claude-sonnet-4-5-20250929" },
];

const MODEL_CB_PREFIX = "mdl:";

export function isModelCallback(data: string): boolean {
  return data.startsWith(MODEL_CB_PREFIX);
}

/** Handle a shortcut-button press: apply model, refresh the message. */
export async function resolveModelCallback(
  tg: Telegram,
  chatId: number,
  messageId: number | undefined,
  data: string,
): Promise<string> {
  const model = data.slice(MODEL_CB_PREFIX.length);
  setMainSettings({ model, providerId: "" });
  log.info("Model changed via Telegram", { chatId, model });
  if (messageId) {
    await sendModelMenu(tg, chatId, messageId).catch(() => {});
  }
  return t("cmd_model_set", langForChat(chatId), { model });
}

/** Send (or edit) the model-picker message. */
export async function sendModelMenu(
  tg: Telegram,
  chatId: number,
  editMessageId?: number,
): Promise<void> {
  const view = mainSettingsView();
  const effectiveLabel = view.effectiveModel + (view.providerName ? ` (${view.providerName})` : "");

  // Two shortcut buttons per row.
  type Btn = { text: string; callback_data: string };
  const rows: Btn[][] = [];
  for (let i = 0; i < MODEL_SHORTCUTS.length; i += 2) {
    const pair = MODEL_SHORTCUTS.slice(i, i + 2).map((s) => ({
      text: view.model === s.model && !view.providerId ? `✓ ${s.label}` : s.label,
      callback_data: `${MODEL_CB_PREFIX}${s.model}`,
    }));
    rows.push(pair);
  }

  // List available provider/local models as plain text so the user can type
  // /model <name> to switch to one without needing buttons.
  const providers = listProviders();
  const providerLines: string[] = [];
  for (const p of providers) {
    let models: string[] = [];
    try {
      models = await fetchProviderModels(p.baseUrl, resolveSecret(p.authToken));
    } catch {
      /* provider unreachable — skip */
    }
    if (models.length === 0) continue;
    providerLines.push(`\n<b>${escapeHtml(p.name)}</b>`);
    for (const m of models) {
      const active = view.model === m && view.providerId === p.id ? " ✓" : "";
      providerLines.push(`  <code>${escapeHtml(m)}</code>${active}`);
    }
  }

  const lang = langForChat(chatId);
  const localSection = providerLines.length
    ? t("cmd_model_local_header", lang) + providerLines.join("\n")
    : "";

  const text = t("cmd_model_menu", lang, { model: escapeHtml(effectiveLabel) }) + localSection;

  if (editMessageId) {
    await tg
      .editMessageText(chatId, editMessageId, undefined, text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: rows },
      })
      .catch(() => {});
  } else {
    await tg.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    });
  }
}

function buildStart(firstName: string | undefined, lang: string): string {
  const greeting = firstName
    ? t("cmd_start_greeting_named", lang, { name: escapeHtml(firstName) })
    : t("cmd_start_greeting_anon", lang);
  return t("cmd_start", lang, {
    greeting,
    agent: escapeHtml(config.ATLAS_NAME),
    brand: escapeHtml(config.BRAND_NAME),
  });
}

function buildHelp(lang: string): string {
  return t("cmd_help", lang, { agent: escapeHtml(config.ATLAS_NAME) });
}

export function registerCommands(bot: Telegraf): void {
  bot.start(async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    await ctx.replyWithHTML(buildStart(ctx.from?.first_name, lang));
  });

  bot.help(async (ctx) => {
    await ctx.replyWithHTML(buildHelp(langForChat(ctx.chat.id)));
  });

  bot.command("new", async (ctx) => {
    sessions.reset(ctx.chat.id);
    log.info("Command /new", { chatId: ctx.chat.id });
    await ctx.reply(t("cmd_new_done", langForChat(ctx.chat.id)));
  });

  bot.command("pwd", async (ctx) => {
    const s = sessions.get(ctx.chat.id);
    await ctx.replyWithHTML(`📂 <code>${s.cwd}</code>`);
  });

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
    log.info("Command /cd", { chatId: ctx.chat.id, cwd: target });
    await ctx.replyWithHTML(t("cmd_cd_done", lang, { path: target }));
  });

  bot.command("diff", async (ctx) => {
    log.info("Command /diff", { chatId: ctx.chat.id });
    await sendDiff(ctx.telegram, ctx.chat.id);
  });

  bot.command("commit", async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    const s = sessions.get(ctx.chat.id);
    const message = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
    if (!message) {
      await ctx.reply(t("cmd_commit_usage", lang));
      return;
    }
    if (!(await git.isRepo(s.cwd))) {
      await ctx.reply(t("cmd_commit_not_repo", lang, { cwd: s.cwd }));
      return;
    }
    const res = await git.commitAll(s.cwd, message);
    log.info("Command /commit", { chatId: ctx.chat.id, ok: res.ok });
    await ctx.replyWithHTML(
      res.ok
        ? t("git_committed", lang, { out: escapeHtml(res.out) })
        : t("git_commit_failed", lang, { out: escapeHtml(res.out) }),
    );
  });

  bot.command("projects", async (ctx) => {
    log.info("Command /projects", { chatId: ctx.chat.id });
    await sendProjectsMenu(ctx.telegram, ctx.chat.id);
  });

  bot.command("allow", async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    const s = sessions.get(ctx.chat.id);
    const tool = ctx.message.text.split(/\s+/)[1];
    if (!tool) {
      await ctx.reply(t("cmd_allow_usage", lang));
      return;
    }
    s.sessionAllowedTools.add(tool);
    sessions.save();
    log.info("Command /allow", { chatId: ctx.chat.id, tool });
    await ctx.replyWithHTML(t("cmd_allow_done", lang, { tool: escapeHtml(tool) }));
  });

  bot.command("disallow", async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    const s = sessions.get(ctx.chat.id);
    const arg = ctx.message.text.split(/\s+/)[1];
    if (!arg) {
      await ctx.reply(t("cmd_disallow_usage", lang));
      return;
    }
    if (arg === "all") {
      s.sessionAllowedTools.clear();
      s.allowedBashCmds.clear();
      sessions.save();
      await ctx.reply(t("cmd_disallow_cleared", lang));
      return;
    }
    const had = s.sessionAllowedTools.delete(arg) || s.allowedBashCmds.delete(arg);
    sessions.save();
    log.info("Command /disallow", { chatId: ctx.chat.id, arg, had });
    await ctx.replyWithHTML(
      had
        ? t("cmd_disallow_removed", lang, { tool: escapeHtml(arg) })
        : t("cmd_disallow_not_found", lang, { tool: escapeHtml(arg) }),
    );
  });

  bot.command("allowed", async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    const s = sessions.get(ctx.chat.id);
    const tools = [...s.sessionAllowedTools];
    const cmds = [...s.allowedBashCmds];
    if (tools.length === 0 && cmds.length === 0) {
      await ctx.replyWithHTML(t("cmd_allowed_empty", lang));
      return;
    }
    const toolList = tools.map((tool) => `<code>${escapeHtml(tool)}</code>`).join(", ");
    const cmdList = cmds.map((c) => `<code>${escapeHtml(c)}</code>`).join(", ");
    await ctx.replyWithHTML(
      t("cmd_allowed_header", lang) + "\n" +
        (tools.length ? t("cmd_allowed_tools", lang, { list: toolList }) + "\n" : "") +
        (cmds.length ? t("cmd_allowed_bash", lang, { list: cmdList }) + "\n" : "") +
        t("cmd_allowed_footer", lang),
    );
  });

  bot.command("schedule", async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    const s = sessions.get(ctx.chat.id);
    const raw = ctx.message.text.replace(/^\/schedule(@\S+)?\s*/, "");
    const [sub, ...rest] = raw.split(/\s+/);

    // /schedule  | /schedule list
    if (!sub || sub === "list") {
      const list = schedules.list(ctx.chat.id);
      if (list.length === 0) {
        await ctx.replyWithHTML(t("cmd_sched_empty", lang));
        return;
      }
      const lines = list.map(
        (x) =>
          `• <code>${x.id}</code>: ${escapeHtml(describeSpec(x.spec))}, ${x.enabled === false ? t("cmd_sched_paused", lang) : t("cmd_sched_next", lang, { when: new Date(x.nextRunAt).toLocaleString() })}\n  <i>${escapeHtml(x.prompt.slice(0, 80))}</i>`,
      );
      await ctx.replyWithHTML(
        t("cmd_sched_header", lang) + "\n" + lines.join("\n") + t("cmd_sched_footer", lang),
      );
      return;
    }

    // /schedule rm <id>
    if (sub === "rm" || sub === "remove" || sub === "del") {
      const id = rest[0];
      if (!id) {
        await ctx.reply(t("cmd_sched_rm_usage", lang));
        return;
      }
      await ctx.reply(
        schedules.remove(ctx.chat.id, id)
          ? t("cmd_sched_rm_done", lang, { id })
          : t("cmd_sched_rm_not_found", lang, { id }),
      );
      return;
    }

    // /schedule add <when> | <prompt>
    if (sub === "add") {
      const body = rest.join(" ");
      const pipe = body.indexOf("|");
      if (pipe === -1) {
        await ctx.reply(t("cmd_sched_add_usage", lang));
        return;
      }
      const when = body.slice(0, pipe).trim();
      const prompt = body.slice(pipe + 1).trim();
      const spec = parseWhen(when);
      if (!spec) {
        await ctx.reply(t("cmd_sched_add_bad_when", lang, { when }));
        return;
      }
      if (!prompt) {
        await ctx.reply(t("cmd_sched_add_empty_prompt", lang));
        return;
      }
      const sched = schedules.add(ctx.chat.id, s.cwd, prompt, spec);
      log.info("Command /schedule add", { chatId: ctx.chat.id, id: sched.id });
      await ctx.replyWithHTML(
        t("cmd_sched_add_done", lang, {
          id: sched.id,
          desc: escapeHtml(describeSpec(spec)),
          when: new Date(sched.nextRunAt).toLocaleString(),
          cwd: escapeHtml(s.cwd),
        }),
      );
      return;
    }

    await ctx.reply(t("cmd_sched_usage", lang));
  });

  bot.command("usage", async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    const s = sessions.get(ctx.chat.id);
    const today = new Date().toISOString().slice(0, 10);
    const probe = loadProbeResult();
    const plan = getPlanSettings();

    // Kick off a background refresh if data is absent or older than 5 minutes.
    const probeAgeMs = probe ? Date.now() - new Date(probe.probedAt).getTime() : Infinity;
    const stale = probeAgeMs > 5 * 60_000;
    if (stale) void runProbe().catch(() => {});

    const lines: string[] = [t("cmd_usage_header", lang)];

    // Plan + account — probe data wins; planSettings is the fallback.
    // Track whether this is a subscription user so we skip the API budget block.
    let isSubscriber = plan.plan === "pro" || plan.plan === "max";
    if (probe?.account) {
      isSubscriber = probe.account.hasPro || probe.account.hasMax;
      const planLabel = probe.account.hasMax
        ? "Claude Max"
        : probe.account.hasPro
          ? "Claude Pro"
          : "API (pay-per-token)";
      const email = probe.account.email
        ? ` · <tg-spoiler>${escapeHtml(probe.account.email)}</tg-spoiler>`
        : "";
      lines.push(t("cmd_usage_plan", lang, { label: planLabel }) + email);
    } else {
      const planLabel = plan.plan === "max" ? "Claude Max" : plan.plan === "pro" ? "Claude Pro" : "API (pay-per-token)";
      lines.push(t("cmd_usage_plan", lang, { label: planLabel }));
    }

    // Subscription limits — only shown when the OAuth probe has real data.
    if (probe?.source === "oauth" && probe.limits.length > 0) {
      lines.push(t("cmd_usage_limits_header", lang));
      for (const lim of probe.limits) {
        const msLeft = Math.max(0, new Date(lim.resetsAt).getTime() - Date.now());
        const sev = lim.severity === "critical" ? "🔴" : lim.severity === "warning" ? "🟡" : "🟢";
        lines.push(`${sev} ${lim.label}   <b>${lim.percent}%</b>  ${fmtBar(lim.percent)}  ${t("cmd_usage_resets_in", lang, { countdown: fmtCountdown(msLeft) })}`);
      }
    }

    // This chat
    lines.push(t("cmd_usage_chat_header", lang));
    lines.push(t("cmd_usage_today", lang, { usage: fmtUsage(s.usage.daily[today]) }));
    lines.push(t("cmd_usage_lifetime", lang, { usage: fmtUsage(s.usage.total) }));

    // API budget — only for confirmed API users with a cap set.
    if (!isSubscriber && plan.monthlyCap > 0) {
      const periodStart = billingPeriodStart(plan.billingDay);
      const periodSpend = sessions.all().reduce((sum, sess) => {
        for (const [d, stat] of Object.entries(sess.usage.daily)) {
          if (d >= periodStart) sum += stat.costUsd;
        }
        return sum;
      }, 0);
      const pct = Math.round((periodSpend / plan.monthlyCap) * 100);
      const daysLeft = daysUntilReset(plan.billingDay);
      lines.push(t("cmd_usage_budget_header", lang));
      lines.push(t("cmd_usage_budget_period", lang, {
        spend: periodSpend.toFixed(2),
        cap: plan.monthlyCap.toFixed(2),
        pct: String(pct),
        bar: fmtBar(pct),
      }));
      lines.push(t("cmd_usage_budget_reset", lang, { days: String(daysLeft), s: daysLeft === 1 ? "" : "s" }));
    }

    // Activity from stats-cache
    if (probe?.activity) {
      const a = probe.activity;
      lines.push(t("cmd_usage_activity_header", lang));
      lines.push(t("cmd_usage_activity", lang, { today: String(a.messageCount), week: String(a.weeklyMessageCount) }));
    }

    // Freshness footer
    if (probe) {
      const ageMin = Math.round(probeAgeMs / 60_000);
      const aged = ageMin < 2 ? t("cmd_usage_fresh_just_now", lang) : t("cmd_usage_fresh_ago", lang, { n: String(ageMin) });
      lines.push(t("cmd_usage_fresh", lang, { age: aged, refreshing: stale ? t("cmd_usage_refreshing", lang) : "" }));
    } else {
      lines.push(t("cmd_usage_no_data", lang));
    }

    await ctx.replyWithHTML(lines.join("\n"));
  });

  bot.command("digest", async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    const data = gatherDigest();
    log.info("Command /digest", { chatId: ctx.chat.id });
    await ctx.replyWithHTML(formatDigest(data, lang));
  });

  bot.command("status", async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    const s = sessions.get(ctx.chat.id);
    const lines = [
      `<b>Status</b>`,
      `📂 <code>${s.cwd}</code>`,
      `🧠 ${config.ATLAS_NAME} · <code>${mainSettingsView().effectiveModel}</code>`,
      `🔒 autonomy: <b>${s.autonomy}</b>`,
      `🔗 session: <code>${s.sessionId ?? t("cmd_status_new_session", lang)}</code>`,
      `⚙️ ${s.busy ? t("cmd_status_running", lang) : t("cmd_status_idle", lang)}`,
    ];

    // Remote access tunnel — show the provider + public link when it's live so
    // the user can open the panel from their phone.
    const tv = tunnelManager.view();
    if (tv.enabled) {
      const provider = tv.provider === "cloudflare" ? "Cloudflare" : "ngrok";
      if (tv.state === "running" && tv.url) {
        lines.push(t("cmd_status_tunnel_running", lang, { provider, url: escapeHtml(tv.url) }));
        if (tv.basicAuth && tv.hasPassword) {
          const pw = tunnelManager.revealPassword();
          lines.push(
            t("cmd_status_tunnel_login", lang, {
              user: escapeHtml(tv.basicAuthUser),
              pass: pw ? escapeHtml(pw) : "",
            }),
          );
        }
      } else if (tv.state === "starting") {
        lines.push(t("cmd_status_tunnel_starting", lang, { provider }));
      } else {
        lines.push(t("cmd_status_tunnel_off", lang, { provider }));
      }
    }

    await ctx.replyWithHTML(lines.join("\n"));
  });

  bot.command("update", async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
    if (isUpdating()) {
      await ctx.reply(t("cmd_update_running", lang));
      return;
    }
    await ctx.reply(t("cmd_update_checking", lang));
    const st = await checkForUpdate();
    if (st.error) {
      await ctx.reply(t("cmd_update_check_failed", lang, { error: st.error }));
      return;
    }
    if (!st.available) {
      await ctx.replyWithHTML(t("cmd_update_up_to_date", lang, { version: st.current, branch: st.branch }));
      return;
    }
    const list = st.commits.slice(0, 10).map((c) => `• ${escapeHtml(c)}`).join("\n");
    // Only auto-run when the user confirmed with "now"; otherwise just report.
    if (arg !== "now") {
      const busyNote = isActive() ? t("cmd_update_busy_warn", lang) : "";
      const restart = serviceInstalled() ? t("cmd_update_confirm_restart", lang) : "";
      await ctx.replyWithHTML(
        t("cmd_update_available", lang, { n: String(st.behindBy), branch: st.branch, list }) +
          busyNote +
          t("cmd_update_confirm", lang, { restart }),
      );
      return;
    }
    const updateNote = serviceInstalled()
      ? t("cmd_update_starting_service", lang)
      : t("cmd_update_starting_manual", lang);
    await ctx.replyWithHTML(`🚀 Updating (${st.behindBy} commit${st.behindBy === 1 ? "" : "s"})…\n${updateNote}`);
    log.warn("Update triggered from Telegram", { chatId: ctx.chat.id });
    // Fire-and-forget: on a serviced host this process is replaced mid-run.
    void runUpdate((line) => log.info(`[update] ${line}`)).then(async (r) => {
      // This only reaches the user on non-serviced hosts (we survive the run).
      if (!serviceInstalled()) {
        await ctx.reply(r.ok ? t("cmd_update_done", lang) : t("cmd_update_failed", lang)).catch(() => {});
      }
    }).catch(() => {});
  });

  bot.command("restore", async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
    if (isUpdating()) {
      await ctx.reply(t("cmd_restore_running", lang));
      return;
    }
    // Destructive: discards local code edits. Require an explicit confirm so it
    // can't fire by accident — this is the recovery path, not a routine action.
    if (arg !== "confirm" && arg !== "now") {
      const busyNote = isActive() ? t("cmd_update_busy_warn", lang) : "";
      const restart = serviceInstalled() ? t("cmd_restore_confirm_restart", lang) : "";
      await ctx.replyWithHTML(
        t("cmd_restore_info", lang) + busyNote + t("cmd_restore_confirm", lang, { restart }),
      );
      return;
    }
    const restoreNote = serviceInstalled()
      ? t("cmd_restore_starting_service", lang)
      : t("cmd_restore_starting_manual", lang);
    await ctx.replyWithHTML(t("cmd_restore_starting", lang, { note: restoreNote }));
    log.warn("Restore triggered from Telegram", { chatId: ctx.chat.id });
    // Fire-and-forget: on a serviced host this process is replaced mid-run.
    void runRestore((line) => log.info(`[restore] ${line}`)).then(async (r) => {
      if (!serviceInstalled()) {
        await ctx.reply(r.ok ? t("cmd_restore_done", lang) : t("cmd_restore_failed", lang)).catch(() => {});
      }
    }).catch(() => {});
  });

  bot.command("stop", async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    const s = sessions.get(ctx.chat.id);
    if (s.busy && s.abort) {
      s.abort.abort();
      log.info("Command /stop: aborting turn", { chatId: ctx.chat.id });
      await ctx.reply(t("bot_stopping", lang));
    } else {
      await ctx.reply(t("bot_nothing_running", lang));
    }
  });

  bot.command("mode", async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    const s = sessions.get(ctx.chat.id);
    const raw = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
    // Accept a few friendly aliases for the auto-until-error mode.
    const arg =
      raw === "autoerror" || raw === "auto-error" || raw === "until-error" ? "auto_until_error" : raw;
    if (
      arg === "supervised" ||
      arg === "standard" ||
      arg === "full" ||
      arg === "auto_until_error"
    ) {
      s.autonomy = arg;
      s.escalation = undefined; // clear any stale escalation when switching modes
      sessions.save();
      log.info("Command /mode", { chatId: ctx.chat.id, autonomy: arg });
      const modeKey: Record<string, TranslationKey> = {
        supervised: "cmd_mode_supervised",
        standard: "cmd_mode_standard",
        full: "cmd_mode_full",
        auto_until_error: "cmd_mode_auto_until_error",
      };
      await ctx.reply(t(modeKey[arg], lang));
    } else if (arg === "safe") {
      s.autonomy = "standard";
      sessions.save();
      await ctx.reply(t("cmd_mode_compat_safe", lang));
    } else if (arg === "auto") {
      s.autonomy = "full";
      sessions.save();
      await ctx.reply(t("cmd_mode_compat_auto", lang));
    } else {
      await ctx.reply(t("cmd_mode_current", lang, { autonomy: s.autonomy }));
    }
  });

  bot.command("model", async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    const arg = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
    if (arg) {
      // /model <name> — set directly without opening the menu.
      setMainSettings({ model: arg, providerId: "" });
      log.info("Command /model set", { chatId: ctx.chat.id, model: arg });
      await ctx.replyWithHTML(t("cmd_model_set", lang, { model: escapeHtml(arg) }));
    } else {
      log.info("Command /model", { chatId: ctx.chat.id });
      await sendModelMenu(ctx.telegram, ctx.chat.id);
    }
  });

  bot.command("lang", async (ctx) => {
    const s = sessions.get(ctx.chat.id);
    const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
    // Use the current (pre-change) lang for error/list messages, new lang for confirmation.
    const currentLang = langForChat(ctx.chat.id);

    if (!arg) {
      const current = s.language ?? config.DEFAULT_LANGUAGE;
      const list = Object.entries(AGENT_LANGUAGES)
        .map(([k, v]) => `<code>${k}</code> ${v}`)
        .join("  ·  ");
      await ctx.replyWithHTML(
        t("cmd_lang_list", currentLang, { name: languageName(current), code: current, list }),
      );
      return;
    }

    if (!isValidLanguage(arg)) {
      await ctx.reply(t("cmd_lang_unknown", currentLang, { code: arg }));
      return;
    }

    s.language = arg;
    sessions.save();
    log.info("Command /lang", { chatId: ctx.chat.id, language: arg });
    // Confirm in the new language so the user immediately sees their choice worked.
    await ctx.reply(
      arg === "en"
        ? t("cmd_lang_set_en", arg)
        : t("cmd_lang_set", arg, { name: languageName(arg) }),
    );
  });

  bot.command("voice", async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    const s = sessions.get(ctx.chat.id);
    const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
    const want = arg === "on" ? true : arg === "off" ? false : !s.voiceReply;
    s.voiceReply = want || undefined;
    sessions.save();
    log.info("Command /voice", { chatId: ctx.chat.id, voiceReply: want });
    if (want && !ttsEnabled()) {
      await ctx.reply(t("cmd_voice_on_no_tts", lang, { hint: ttsSetupHint() }));
    } else {
      await ctx.reply(want ? t("cmd_voice_on", lang) : t("cmd_voice_off", lang));
    }
  });

  bot.command("inbox", async (ctx) => {
    log.info("Command /inbox", { chatId: ctx.chat.id });
    await sendInbox(ctx.telegram, ctx.chat.id);
  });

  bot.command("templates", async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    log.info("Command /templates", { chatId: ctx.chat.id });
    const templates = listTemplates();
    if (templates.length === 0) {
      await ctx.replyWithHTML(t("cmd_templates_empty", lang));
      return;
    }
    const lines = templates.map((tpl) => {
      const vars = templateVariables(tpl.body);
      const varList = vars.length ? " · " + vars.map((v) => `<code>{{${escapeHtml(v)}}}</code>`).join(" ") : "";
      const desc = tpl.description ? `\n  <i>${escapeHtml(tpl.description)}</i>` : "";
      return `• <b>${escapeHtml(tpl.name)}</b>${varList}${desc}\n<pre>${escapeHtml(tpl.body)}</pre>`;
    });
    await ctx.replyWithHTML(t("cmd_templates_header", lang) + "\n" + lines.join("\n"));
  });

  bot.command("council", async (ctx) => {
    const lang = langForChat(ctx.chat.id);
    const proposal = ctx.message.text.replace(/^\/council(@\S+)?\s*/, "").trim();
    if (!proposal) {
      await ctx.reply(t("cmd_council_usage", lang));
      return;
    }
    log.info("Command /council", { chatId: ctx.chat.id, proposal: proposal.slice(0, 80) });
    const ack = await ctx.replyWithHTML(t("cmd_council_ack", lang, { proposal: escapeHtml(proposal.slice(0, 120)) }));
    try {
      const session = await runCouncil(proposal);
      const msg = formatCouncilTelegram(session);
      // Delete the ack and send the full result.
      await ctx.telegram.deleteMessage(ctx.chat.id, ack.message_id).catch(() => {});
      await ctx.replyWithHTML(
        msg
          .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
          .replace(/_(.+?)_/g, "<i>$1</i>"),
      );
    } catch (err) {
      log.error("Council command failed", { chatId: ctx.chat.id, error: err instanceof Error ? err.message : String(err) });
      await ctx.telegram.deleteMessage(ctx.chat.id, ack.message_id).catch(() => {});
      await ctx.reply(t("cmd_council_failed", lang));
    }
  });
}

function fmtUsage(stat: UsageStat | undefined): string {
  if (!stat || stat.turns === 0) return "-";
  const secs = Math.round(stat.durationMs / 1000);
  const time = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  return `${stat.turns} turn${stat.turns === 1 ? "" : "s"} · $${stat.costUsd.toFixed(2)} · ${time}`;
}

function fmtBar(pct: number): string {
  const filled = Math.min(10, Math.round(pct / 10));
  return "▓".repeat(filled) + "░".repeat(10 - filled);
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Render a 24h digest as a tight Telegram HTML block. */
function formatDigest(d: DigestData, lang: string): string {
  const lines: string[] = [t("cmd_digest_header", lang)];

  if (isDigestEmpty(d)) {
    lines.push(t("cmd_digest_empty", lang));
    return lines.join("\n");
  }

  if (d.tasksCompleted.length > 0) {
    // Inline up to 3 titles, then a "+N" tail, to keep it a tight paragraph.
    const shown = d.tasksCompleted.slice(0, 3).map((x) => escapeHtml(x.title));
    const extra = d.tasksCompleted.length - shown.length;
    let titles = shown.length ? ` — ${shown.join(", ")}` : "";
    if (extra > 0) titles += ` +${extra}`;
    lines.push(t("cmd_digest_tasks", lang, {
      n: d.tasksCompleted.length,
      s: d.tasksCompleted.length === 1 ? "" : "s",
      titles,
    }));
  }

  if (d.runsOk > 0 || d.runsError > 0) {
    lines.push(t("cmd_digest_runs", lang, {
      ok: d.runsOk,
      oks: d.runsOk === 1 ? "" : "s",
      err: d.runsError,
    }));
  }

  if (d.memoriesWritten > 0) {
    lines.push(t("cmd_digest_memories", lang, {
      n: d.memoriesWritten,
      y: d.memoriesWritten === 1 ? "y" : "ies",
    }));
  }

  if (d.skillsSaved.length > 0) {
    const names = d.skillsSaved.slice(0, 3).map((x) => escapeHtml(x.name)).join(", ");
    const extra = d.skillsSaved.length - Math.min(3, d.skillsSaved.length);
    lines.push(t("cmd_digest_skills", lang, {
      n: d.skillsSaved.length,
      s: d.skillsSaved.length === 1 ? "" : "s",
      names: extra > 0 ? `${names} +${extra}` : names,
    }));
  }

  if (d.turns > 0 || d.costUsd > 0) {
    lines.push(t("cmd_digest_cost", lang, {
      cost: d.costUsd.toFixed(2),
      turns: d.turns,
      s: d.turns === 1 ? "" : "s",
    }));
  }

  if (d.alerts.length > 0) {
    const first = escapeHtml(d.alerts[0].text);
    const more = d.alerts.length > 1
      ? t("cmd_digest_alerts_more", lang, { n: d.alerts.length - 1 })
      : "";
    lines.push(t("cmd_digest_alerts", lang, {
      n: d.alerts.length,
      s: d.alerts.length === 1 ? "" : "s",
      first: first + more,
    }));
  }

  return lines.join("\n");
}
