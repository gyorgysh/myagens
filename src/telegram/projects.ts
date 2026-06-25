import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Markup, type Telegram } from "telegraf";
import { sessions, type Session } from "../session/manager.js";
import { log } from "../logger.js";
import { escapeHtml } from "./formatting.js";

const HEADER = "<b>📁 Projects</b>\nTap a directory to switch the working dir.";

/** Build the projects keyboard: one row per saved dir (switch + remove), plus add. */
function projectsKeyboard(s: Session) {
  const rows = s.projects.map((dir, i) => {
    const here = dir === s.cwd ? "✓ " : "";
    return [
      Markup.button.callback(`${here}📂 ${basename(dir) || dir}`, `proj:go:${i}`),
      Markup.button.callback("🗑", `proj:rm:${i}`),
    ];
  });
  const saved = s.projects.includes(s.cwd);
  rows.push([
    Markup.button.callback(
      saved ? "➕ Save another (use /cd first)" : "➕ Save current dir",
      "proj:add",
    ),
  ]);
  return Markup.inlineKeyboard(rows);
}

/** Reply to /projects with the switch menu. */
export async function sendProjectsMenu(tg: Telegram, chatId: number): Promise<void> {
  const s = sessions.get(chatId);
  const body =
    s.projects.length === 0
      ? `${HEADER}\n\nNo saved projects yet. <code>/cd</code> into a directory, then tap “Save current dir”.`
      : `${HEADER}\n\nCurrent: <code>${escapeHtml(s.cwd)}</code>`;
  await tg.sendMessage(chatId, body, { parse_mode: "HTML", ...projectsKeyboard(s) });
}

export function isProjectCallback(data: string): boolean {
  return data.startsWith("proj:");
}

/** Resolve a /projects button press; returns a short toast for answerCbQuery. */
export async function resolveProjectCallback(
  tg: Telegram,
  chatId: number,
  data: string,
  messageId: number | undefined,
): Promise<string> {
  const [, action, idxRaw] = data.split(":");
  const s = sessions.get(chatId);
  const idx = Number(idxRaw);
  let toast = "";

  if (action === "add") {
    if (s.projects.includes(s.cwd)) {
      toast = "Already saved";
    } else {
      s.projects.push(s.cwd);
      sessions.save();
      log.info("Project saved", { chatId, cwd: s.cwd });
      toast = `Saved ${basename(s.cwd)}`;
    }
  } else if (action === "rm" && Number.isInteger(idx) && s.projects[idx]) {
    const [removed] = s.projects.splice(idx, 1);
    sessions.save();
    log.info("Project removed", { chatId, dir: removed });
    toast = `Removed ${basename(removed)}`;
  } else if (action === "go" && Number.isInteger(idx) && s.projects[idx]) {
    const dir = s.projects[idx];
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      return "Gone (that directory no longer exists)";
    }
    s.cwd = dir;
    sessions.save();
    log.info("Project switched", { chatId, cwd: dir });
    toast = `Now in ${basename(dir)}`;
  } else {
    return "";
  }

  // Re-render the menu in place to reflect the change.
  if (messageId !== undefined) {
    await tg
      .editMessageReplyMarkup(chatId, messageId, undefined, projectsKeyboard(s).reply_markup)
      .catch(() => {});
  }
  return toast;
}
