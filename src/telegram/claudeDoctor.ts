import type { Telegram } from "telegraf";
import { runClaudeDoctor, type DoctorCheck, type DoctorReport } from "../core/claudeDoctor.js";
import { isClaudeLoginRunning } from "./claudeLogin.js";
import { t, langForChat } from "./i18n/index.js";
import { escapeHtml } from "./formatting.js";
import { log } from "../logger.js";

const TG_LIMIT = 3500;
let doctorRunning = false;

function lineFor(check: DoctorCheck, lang: string): string {
  const text = escapeHtml(check.text);
  const key =
    check.level === "ok"
      ? "cmd_doctor_ok"
      : check.level === "fail"
        ? "cmd_doctor_fail"
        : check.level === "warn"
          ? "cmd_doctor_warn"
          : "cmd_doctor_info";
  let line = t(key, lang, { text });
  if (check.output?.trim()) {
    line += "\n" + t("cmd_doctor_output", lang, { text: escapeHtml(check.output.trim()) });
  }
  return line;
}

function nextStep(report: DoctorReport, lang: string): string {
  if (report.promptOk && report.sdkOk) return t("cmd_doctor_next_ok", lang);
  if (!report.loggedIn) return t("cmd_doctor_next_login", lang);
  return t("cmd_doctor_next_fail", lang);
}

function chunkMessages(parts: string[]): string[] {
  const out: string[] = [];
  let buf = "";
  for (const part of parts) {
    if (buf && buf.length + 1 + part.length > TG_LIMIT) {
      out.push(buf);
      buf = part;
    } else {
      buf = buf ? `${buf}\n${part}` : part;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function formatDoctorTelegram(report: DoctorReport, lang: string): string[] {
  const parts = [
    t("cmd_doctor_header", lang),
    t("cmd_doctor_platform", lang, { platform: escapeHtml(report.platform), node: escapeHtml(report.node) }),
    ...report.checks.map((c) => lineFor(c, lang)),
    "",
    nextStep(report, lang),
  ];
  return chunkMessages(parts);
}

export async function handleDoctorCommand(tg: Telegram, chatId: number): Promise<void> {
  const lang = langForChat(chatId);
  if (isClaudeLoginRunning()) {
    await tg.sendMessage(chatId, t("cmd_doctor_login_block", lang));
    return;
  }
  if (doctorRunning) {
    await tg.sendMessage(chatId, t("cmd_doctor_busy", lang));
    return;
  }
  doctorRunning = true;
  await tg.sendMessage(chatId, t("cmd_doctor_running", lang));
  void (async () => {
    try {
      const report = await runClaudeDoctor();
      for (const chunk of formatDoctorTelegram(report, lang)) {
        await tg.sendMessage(chatId, chunk, { parse_mode: "HTML" }).catch(() => {});
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.warn("Claude doctor failed", { error: detail });
      await tg
        .sendMessage(chatId, t("bot_action_failed", lang, { detail: escapeHtml(detail) }), {
          parse_mode: "HTML",
        })
        .catch(() => {});
    } finally {
      doctorRunning = false;
    }
  })();
}
