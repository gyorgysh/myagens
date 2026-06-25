import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Telegraf } from "telegraf";
import { mainSettingsView } from "./core/mainSettings.js";
import { config } from "./config.js";
import { AGENT_LANGUAGES, isValidLanguage, languageName } from "./core/languages.js";
import { runCouncil, formatCouncilTelegram } from "./core/council.js";
import { sessions } from "./session/manager.js";
import { sendDiff } from "./telegram/gitFlow.js";
import { sendProjectsMenu } from "./telegram/projects.js";
import { schedules, parseWhen, describeSpec } from "./schedule/manager.js";
import * as git from "./git.js";
import { escapeHtml } from "./telegram/formatting.js";
import type { UsageStat } from "./session/store.js";
import { loadProbeResult, runProbe } from "./core/usageProbe.js";
import { getPlanSettings, billingPeriodStart, daysUntilReset } from "./core/planSettings.js";
import { checkForUpdate, runUpdate, isUpdating } from "./core/updateControl.js";
import { serviceInstalled } from "./core/agentControl.js";
import { log } from "./logger.js";

function buildStart(firstName?: string): string {
  const A = config.ATLAS_NAME;
  const B = config.BRAND_NAME;
  const hey = firstName ? `Hey ${escapeHtml(firstName)}` : "Hey";
  return `👋 <b>${hey}! I'm ${A}, your ${B} coordinator.</b>

I run as a real Claude Code agent on this machine. I can read files, write code, run commands, check services, and ship things. Replies stream live as I work. Anything that writes or executes pauses for your approval first.

<b>Talk to me like a person:</b>
<i>"What's eating all the disk space?"</i>
<i>"Deploy the site and let me know when it's done."</i>
<i>"Summarize any errors from the last hour of logs."</i>

I coordinate a crew of specialist Leads (DevOps, Finance, Research, whatever you configure). Use /council to put a decision to a full team vote, or message a Lead directly if they have their own bot.

You can send me files and photos (I see images inline) and voice notes (transcribed and run as prompts).

/help for the full command list.`;
}

function buildHelp(): string {
  const A = config.ATLAS_NAME;
  return `🤖 <b>${escapeHtml(A)}: Commands</b>

<b>Conversation</b>
/new: fresh context (clear session)
/stop: abort the running request

<b>Files &amp; Git</b>
/cd &lt;path&gt;: change working directory
/pwd: current directory
/projects: switch between saved working dirs
/diff: review the working-tree diff with Commit / Discard buttons
/commit &lt;message&gt;: stage all changes and commit

<b>Autonomy</b>
/mode supervised|standard|full: approval level for this chat
/allow &lt;Tool&gt; · /allowed · /disallow &lt;Tool|all&gt;: persistent tool allow-rules

<b>Crew</b>
/council &lt;idea&gt;: put a proposal to a full Lead council vote

<b>Scheduling</b>
/schedule add &lt;when&gt; | &lt;prompt&gt;: timed autonomous run (<code>30m</code>, <code>2h</code>, <code>HH:MM</code>)
/schedule list · /schedule rm &lt;id&gt;

<b>Info</b>
/status: session info (cwd, model, autonomy, session id)
/usage: plan, subscription limits, and API spend
/update [now]: check for a new version, or apply it with <code>/update now</code>
/lang [code]: show or set response language (e.g. <code>/lang hu</code>)
/help: this message

Send files or photos (seen inline as vision input), or voice notes (transcribed and run as prompts).`;
}

export function registerCommands(bot: Telegraf): void {
  bot.start(async (ctx) => {
    await ctx.replyWithHTML(buildStart(ctx.from?.first_name));
  });

  bot.help(async (ctx) => {
    await ctx.replyWithHTML(buildHelp());
  });

  bot.command("new", async (ctx) => {
    sessions.reset(ctx.chat.id);
    log.info("Command /new", { chatId: ctx.chat.id });
    await ctx.reply("🆕 Started a fresh conversation.");
  });

  bot.command("pwd", async (ctx) => {
    const s = sessions.get(ctx.chat.id);
    await ctx.replyWithHTML(`📂 <code>${s.cwd}</code>`);
  });

  bot.command("cd", async (ctx) => {
    const s = sessions.get(ctx.chat.id);
    const arg = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
    if (!arg) {
      await ctx.reply("Usage: /cd <path>");
      return;
    }
    const target = isAbsolute(arg) ? arg : resolve(s.cwd, arg);
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      await ctx.reply(`⚠️ Not a directory: ${target}`);
      return;
    }
    s.cwd = target;
    sessions.save();
    log.info("Command /cd", { chatId: ctx.chat.id, cwd: target });
    await ctx.replyWithHTML(`📂 Now in <code>${target}</code>`);
  });

  bot.command("diff", async (ctx) => {
    log.info("Command /diff", { chatId: ctx.chat.id });
    await sendDiff(ctx.telegram, ctx.chat.id);
  });

  bot.command("commit", async (ctx) => {
    const s = sessions.get(ctx.chat.id);
    const message = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
    if (!message) {
      await ctx.reply("Usage: /commit <message>");
      return;
    }
    if (!(await git.isRepo(s.cwd))) {
      await ctx.reply(`⚠️ Not a git repository: ${s.cwd}`);
      return;
    }
    const res = await git.commitAll(s.cwd, message);
    log.info("Command /commit", { chatId: ctx.chat.id, ok: res.ok });
    await ctx.replyWithHTML(
      res.ok
        ? `✅ Committed.\n<pre>${escapeHtml(res.out)}</pre>`
        : `⚠️ Commit failed.\n<pre>${escapeHtml(res.out)}</pre>`,
    );
  });

  bot.command("projects", async (ctx) => {
    log.info("Command /projects", { chatId: ctx.chat.id });
    await sendProjectsMenu(ctx.telegram, ctx.chat.id);
  });

  bot.command("allow", async (ctx) => {
    const s = sessions.get(ctx.chat.id);
    const tool = ctx.message.text.split(/\s+/)[1];
    if (!tool) {
      await ctx.reply("Usage: /allow <Tool>  (e.g. /allow Bash, /allow Write)");
      return;
    }
    s.sessionAllowedTools.add(tool);
    sessions.save();
    log.info("Command /allow", { chatId: ctx.chat.id, tool });
    await ctx.replyWithHTML(`♾️ Always allowing <b>${escapeHtml(tool)}</b> (no prompt).`);
  });

  bot.command("disallow", async (ctx) => {
    const s = sessions.get(ctx.chat.id);
    const arg = ctx.message.text.split(/\s+/)[1];
    if (!arg) {
      await ctx.reply("Usage: /disallow <Tool|all>");
      return;
    }
    if (arg === "all") {
      s.sessionAllowedTools.clear();
      s.allowedBashCmds.clear();
      sessions.save();
      await ctx.reply("🔒 Cleared all always-allow rules. Tools will prompt again.");
      return;
    }
    const had = s.sessionAllowedTools.delete(arg) || s.allowedBashCmds.delete(arg);
    sessions.save();
    log.info("Command /disallow", { chatId: ctx.chat.id, arg, had });
    await ctx.replyWithHTML(
      had ? `🔒 Removed <b>${escapeHtml(arg)}</b> from always-allow.` : `Not in the allow-list: ${escapeHtml(arg)}`,
    );
  });

  bot.command("allowed", async (ctx) => {
    const s = sessions.get(ctx.chat.id);
    const tools = [...s.sessionAllowedTools];
    const cmds = [...s.allowedBashCmds];
    if (tools.length === 0 && cmds.length === 0) {
      await ctx.replyWithHTML(
        "No always-allow rules. Risky tools prompt every time (safe mode).\n" +
          "Add one with <code>/allow &lt;Tool&gt;</code> or the “Always allow” buttons.",
      );
      return;
    }
    await ctx.replyWithHTML(
      `<b>♾️ Always allowed (no prompt)</b>\n` +
        (tools.length ? `Tools: ${tools.map((t) => `<code>${escapeHtml(t)}</code>`).join(", ")}\n` : "") +
        (cmds.length ? `Bash: ${cmds.map((c) => `<code>${escapeHtml(c)}</code>`).join(", ")}\n` : "") +
        `\nClear with <code>/disallow &lt;name&gt;</code> or <code>/disallow all</code>.`,
    );
  });

  bot.command("schedule", async (ctx) => {
    const s = sessions.get(ctx.chat.id);
    const raw = ctx.message.text.replace(/^\/schedule(@\S+)?\s*/, "");
    const [sub, ...rest] = raw.split(/\s+/);

    // /schedule  | /schedule list
    if (!sub || sub === "list") {
      const list = schedules.list(ctx.chat.id);
      if (list.length === 0) {
        await ctx.replyWithHTML(
          "No schedules. Add one:\n" +
            "<code>/schedule add 2h | check disk space and warn if &gt;90%</code>\n" +
            "<code>/schedule add 09:00 | summarize yesterday's logs</code>",
        );
        return;
      }
      const lines = list.map(
        (x) =>
          `• <code>${x.id}</code>: ${escapeHtml(describeSpec(x.spec))}, next ${new Date(x.nextRunAt).toLocaleString()}\n  <i>${escapeHtml(x.prompt.slice(0, 80))}</i>`,
      );
      await ctx.replyWithHTML(
        `<b>⏰ Schedules</b>\n${lines.join("\n")}\n\nRemove with <code>/schedule rm &lt;id&gt;</code>.`,
      );
      return;
    }

    // /schedule rm <id>
    if (sub === "rm" || sub === "remove" || sub === "del") {
      const id = rest[0];
      if (!id) {
        await ctx.reply("Usage: /schedule rm <id>");
        return;
      }
      await ctx.reply(schedules.remove(ctx.chat.id, id) ? `🗑 Removed ${id}.` : `No schedule with id ${id}.`);
      return;
    }

    // /schedule add <when> | <prompt>
    if (sub === "add") {
      const body = rest.join(" ");
      const pipe = body.indexOf("|");
      if (pipe === -1) {
        await ctx.reply("Usage: /schedule add <when> | <prompt>\nwhen = 30m|2h|1d or HH:MM (24h, server time)");
        return;
      }
      const when = body.slice(0, pipe).trim();
      const prompt = body.slice(pipe + 1).trim();
      const spec = parseWhen(when);
      if (!spec) {
        await ctx.reply(`Couldn't parse “${when}”. Use 30m / 2h / 1d, or HH:MM (min interval 1m).`);
        return;
      }
      if (!prompt) {
        await ctx.reply("The prompt (after |) is empty.");
        return;
      }
      const sched = schedules.add(ctx.chat.id, s.cwd, prompt, spec);
      log.info("Command /schedule add", { chatId: ctx.chat.id, id: sched.id });
      await ctx.replyWithHTML(
        `⏰ Scheduled <code>${sched.id}</code>: ${escapeHtml(describeSpec(spec))}.\n` +
          `First run ${new Date(sched.nextRunAt).toLocaleString()} in <code>${escapeHtml(s.cwd)}</code>.\n` +
          `<i>Runs autonomously (no approval prompts).</i>`,
      );
      return;
    }

    await ctx.reply("Usage: /schedule [list] | /schedule add <when> | <prompt> | /schedule rm <id>");
  });

  bot.command("usage", async (ctx) => {
    const s = sessions.get(ctx.chat.id);
    const today = new Date().toISOString().slice(0, 10);
    const probe = loadProbeResult();
    const plan = getPlanSettings();

    // Kick off a background refresh if data is absent or older than 5 minutes.
    const probeAgeMs = probe ? Date.now() - new Date(probe.probedAt).getTime() : Infinity;
    const stale = probeAgeMs > 5 * 60_000;
    if (stale) void runProbe().catch(() => {});

    const lines: string[] = ["<b>📊 Usage</b>"];

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
      lines.push(`\n<b>Plan</b>  ${planLabel}${email}`);
    } else {
      const planLabel = plan.plan === "max" ? "Claude Max" : plan.plan === "pro" ? "Claude Pro" : "API (pay-per-token)";
      lines.push(`\n<b>Plan</b>  ${planLabel}`);
    }

    // Subscription limits — only shown when the OAuth probe has real data.
    if (probe?.source === "oauth" && probe.limits.length > 0) {
      lines.push("\n<b>Subscription limits</b>");
      for (const lim of probe.limits) {
        const msLeft = Math.max(0, new Date(lim.resetsAt).getTime() - Date.now());
        const sev = lim.severity === "critical" ? "🔴" : lim.severity === "warning" ? "🟡" : "🟢";
        lines.push(`${sev} ${lim.label}   <b>${lim.percent}%</b>  ${fmtBar(lim.percent)}  resets in ${fmtCountdown(msLeft)}`);
      }
    }

    // This chat
    lines.push("\n<b>This chat</b>");
    lines.push(`Today     ${fmtUsage(s.usage.daily[today])}`);
    lines.push(`Lifetime  ${fmtUsage(s.usage.total)}`);

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
      lines.push(`\n<b>API budget</b>`);
      lines.push(`Period spend  <b>$${periodSpend.toFixed(2)}</b> / $${plan.monthlyCap.toFixed(2)} (${pct}%)  ${fmtBar(pct)}`);
      lines.push(`Billing resets in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`);
    }

    // Activity from stats-cache
    if (probe?.activity) {
      const a = probe.activity;
      lines.push(`\n<b>Activity</b>`);
      lines.push(`Messages  today ${a.messageCount}  ·  this week ${a.weeklyMessageCount}`);
    }

    // Freshness footer
    if (probe) {
      const ageMin = Math.round(probeAgeMs / 60_000);
      const aged = ageMin < 2 ? "just now" : `${ageMin}m ago`;
      lines.push(`\n<i>Subscription data from ${aged}${stale ? " · refreshing" : ""}</i>`);
    } else {
      lines.push(`\n<i>No subscription data yet · checking now</i>`);
    }

    await ctx.replyWithHTML(lines.join("\n"));
  });

  bot.command("status", async (ctx) => {
    const s = sessions.get(ctx.chat.id);
    await ctx.replyWithHTML(
      `<b>Status</b>\n` +
        `📂 <code>${s.cwd}</code>\n` +
        `🧠 ${config.ATLAS_NAME} · <code>${mainSettingsView().effectiveModel}</code>\n` +
        `🔒 autonomy: <b>${s.autonomy}</b>\n` +
        `🔗 session: <code>${s.sessionId ?? "(new)"}</code>\n` +
        `⚙️ ${s.busy ? "running…" : "idle"}`,
    );
  });

  bot.command("update", async (ctx) => {
    const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
    if (isUpdating()) {
      await ctx.reply("⏳ An update is already running.");
      return;
    }
    await ctx.reply("🔍 Checking for updates…");
    const st = await checkForUpdate();
    if (st.error) {
      await ctx.reply(`⚠️ Update check failed: ${st.error}`);
      return;
    }
    if (!st.available) {
      await ctx.replyWithHTML(`✓ Already up to date (<code>${st.current}</code> on <b>${st.branch}</b>).`);
      return;
    }
    const list = st.commits.slice(0, 10).map((c) => `• ${escapeHtml(c)}`).join("\n");
    // Only auto-run when the user confirmed with "now"; otherwise just report.
    if (arg !== "now") {
      await ctx.replyWithHTML(
        `⬆️ <b>${st.behindBy}</b> update(s) available on <b>${st.branch}</b>:\n${list}\n\n` +
          `Send <code>/update now</code> to apply (fetch, rebuild${serviceInstalled() ? ", and restart" : ""}).`,
      );
      return;
    }
    await ctx.replyWithHTML(
      `🚀 Updating (${st.behindBy} commit${st.behindBy === 1 ? "" : "s"})…\n` +
        (serviceInstalled()
          ? "The bot will restart when the build finishes."
          : "Restart your manual run afterward to pick up the new code."),
    );
    log.warn("Update triggered from Telegram", { chatId: ctx.chat.id });
    // Fire-and-forget: on a serviced host this process is replaced mid-run.
    void runUpdate((line) => log.info(`[update] ${line}`)).then(async (r) => {
      // This only reaches the user on non-serviced hosts (we survive the run).
      if (!serviceInstalled()) {
        await ctx.reply(r.ok ? "✓ Update complete. Restart to apply." : "⚠️ Update failed — check /logs.").catch(() => {});
      }
    }).catch(() => {});
  });

  bot.command("stop", async (ctx) => {
    const s = sessions.get(ctx.chat.id);
    if (s.busy && s.abort) {
      s.abort.abort();
      log.info("Command /stop: aborting turn", { chatId: ctx.chat.id });
      await ctx.reply("⏹ Stopping…");
    } else {
      await ctx.reply("Nothing is running.");
    }
  });

  bot.command("mode", async (ctx) => {
    const s = sessions.get(ctx.chat.id);
    const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
    if (arg === "supervised" || arg === "standard" || arg === "full") {
      s.autonomy = arg;
      sessions.save();
      log.info("Command /mode", { chatId: ctx.chat.id, autonomy: arg });
      const msg: Record<string, string> = {
        supervised: "🔒 Supervised: all tools require approval, no auto-allow.",
        standard: "⚖️ Standard: safe tools auto-allowed, risky tools prompt.",
        full: "⚠️ Full: all tools run without approval (autonomous).",
      };
      await ctx.reply(msg[arg]);
    } else if (arg === "safe") {
      s.autonomy = "standard";
      sessions.save();
      await ctx.reply("⚖️ Standard mode (was: safe). Safe tools auto-allowed, risky tools prompt.");
    } else if (arg === "auto") {
      s.autonomy = "full";
      sessions.save();
      await ctx.reply("⚠️ Full mode (was: auto). Tools run without approval.");
    } else {
      await ctx.reply(
        `Current autonomy: ${s.autonomy}. Usage: /mode supervised|standard|full`,
      );
    }
  });

  bot.command("lang", async (ctx) => {
    const s = sessions.get(ctx.chat.id);
    const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();

    if (!arg) {
      const current = s.language ?? config.DEFAULT_LANGUAGE;
      const list = Object.entries(AGENT_LANGUAGES)
        .map(([k, v]) => `<code>${k}</code> ${v}`)
        .join("  ·  ");
      await ctx.replyWithHTML(
        `🌐 Current language: <b>${languageName(current)}</b> (<code>${current}</code>)\n\n` +
          `Available:\n${list}\n\nUsage: <code>/lang hu</code>`,
      );
      return;
    }

    if (!isValidLanguage(arg)) {
      await ctx.reply(`Unknown language code: ${arg}. Send /lang to see available codes.`);
      return;
    }

    s.language = arg;
    sessions.save();
    log.info("Command /lang", { chatId: ctx.chat.id, language: arg });
    await ctx.reply(
      arg === "en"
        ? `🌐 Language set to English.`
        : `🌐 Language set to ${languageName(arg)}. The agent will respond in ${languageName(arg)} from now on.`,
    );
  });

  bot.command("council", async (ctx) => {
    const proposal = ctx.message.text.replace(/^\/council(@\S+)?\s*/, "").trim();
    if (!proposal) {
      await ctx.reply("Usage: /council <your idea or proposal>\nExample: /council Should we migrate the database to PostgreSQL?");
      return;
    }
    log.info("Command /council", { chatId: ctx.chat.id, proposal: proposal.slice(0, 80) });
    const ack = await ctx.replyWithHTML(`🗳 <b>Calling the council…</b>\n<i>${escapeHtml(proposal.slice(0, 120))}</i>`);
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
      await ctx.reply("⚠️ Council vote failed. Check that you have enabled Lead workers configured.");
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
