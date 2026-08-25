import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { Telegram } from "telegraf";
import { claudeAuthStatus } from "../setup/claude.js";
import { runClaudePromptTest } from "../core/claudeDoctor.js";
import { log } from "../logger.js";
import { t, langForChat } from "./i18n/index.js";
import { escapeHtml } from "./formatting.js";

const execFileAsync = promisify(execFile);
const CLAUDE_CLI = process.platform === "win32" ? "claude.cmd" : "claude";
const CLAUDE_EXEC_OPTS = { shell: process.platform === "win32" } as const;
const URL_RE = /https:\/\/[^\s\x1b"'<>)\]]+/;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const CODE_RE = /paste|code here|authorization code/i;
const ENTER_RE = /login successful|press enter to continue/i;

type Pty = { kill(): void; write(data: string): void };

/** One machine-wide local Claude OAuth flow. No prompt is sent to an LLM. */
class TelegramClaudeLogin {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pty: Pty | null = null;
  private running = false;
  private waitingForCode = false;
  private output = "";
  private urlSent = false;
  private codePromptSent = false;
  private enterSent = false;
  private timeout?: ReturnType<typeof setTimeout>;

  isRunning(): boolean {
    return this.running;
  }

  canAcceptCode(text?: string): boolean {
    if (!this.running) return false;
    if (this.waitingForCode) return true;
    if (!this.urlSent) return false;
    if (!text) return true;
    return looksLikeAuthCode(text);
  }

  async start(tg: Telegram, chatId: number, force = false): Promise<void> {
    const lang = langForChat(chatId);
    const auth = await claudeAuthStatus();
    if (!auth.cliInstalled) {
      await tg.sendMessage(chatId, t("claude_login_no_cli", lang));
      return;
    }
    if (auth.loggedIn && !force) {
      const who = auth.email
        ? t("claude_login_as", lang, { email: escapeHtml(auth.email) })
        : "";
      await tg.sendMessage(chatId, t("claude_login_already", lang, { who }), { parse_mode: "HTML" });
      return;
    }
    if (this.running) {
      await tg.sendMessage(chatId, t("claude_login_in_progress", lang), { parse_mode: "HTML" });
      return;
    }

    if (force && auth.loggedIn) {
      try {
        await execFileAsync(CLAUDE_CLI, ["auth", "logout"], { timeout: 15_000, ...CLAUDE_EXEC_OPTS });
      } catch (err) {
        log.warn("claude auth logout failed before retry", { error: String(err) });
      }
    }

    this.running = true;
    this.waitingForCode = false;
    this.output = "";
    this.urlSent = false;
    this.codePromptSent = false;
    this.enterSent = false;
    await tg.sendMessage(chatId, t("claude_login_starting", lang));
    this.timeout = setTimeout(() => {
      this.stopProcess();
      void tg.sendMessage(chatId, t("claude_login_timeout", langForChat(chatId))).catch(() => {});
    }, LOGIN_TIMEOUT_MS);

    const consume = (chunk: string) => {
      this.output = (this.output + chunk).slice(-65_536);
      const clean = this.output.replace(ANSI_RE, "");
      if (!this.urlSent) {
        const match = clean.match(URL_RE);
        if (match) {
          this.urlSent = true;
          void tg
            .sendMessage(chatId, t("claude_login_open_url", langForChat(chatId)), {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [[{ text: t("claude_login_btn", langForChat(chatId)), url: match[0] }]],
              },
            })
            .catch((err) => log.warn("Could not send Claude login URL", { error: String(err) }));
        }
      }
      if (!this.codePromptSent && CODE_RE.test(clean)) {
        this.codePromptSent = true;
        this.waitingForCode = true;
        void tg
          .sendMessage(chatId, t("claude_login_need_code", langForChat(chatId)), { parse_mode: "HTML" })
          .catch(() => {});
      }
      if (!this.enterSent && ENTER_RE.test(clean)) {
        this.enterSent = true;
        this.writeEnter();
      }
    };
    const finish = (code: number | null) => void this.finish(tg, chatId, code);

    try {
      const { spawn: ptySpawn } = await import("node-pty");
      const pty = ptySpawn(CLAUDE_CLI, ["auth", "login", "--claudeai"], {
        name: "xterm-256color",
        cols: 200,
        rows: 50,
        cwd: homedir(),
        env: process.env as Record<string, string>,
      });
      this.pty = pty;
      pty.onData(consume);
      pty.onExit(({ exitCode }: { exitCode: number }) => finish(exitCode));
      return;
    } catch {
      /* optional node-pty unavailable; current Claude builds also support pipes */
    }

    try {
      const child = spawn(CLAUDE_CLI, ["auth", "login", "--claudeai"], {
        cwd: homedir(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      this.child = child;
      child.stdout.on("data", (data: Buffer) => consume(data.toString("utf8")));
      child.stderr.on("data", (data: Buffer) => consume(data.toString("utf8")));
      child.on("error", (err) => {
        log.warn("Claude login process failed", { error: err.message });
        finish(null);
      });
      child.on("exit", finish);
    } catch (err) {
      log.warn("Could not start Claude login", { error: String(err) });
      finish(null);
    }
  }

  async sendCode(tg: Telegram, chatId: number, code: string): Promise<void> {
    const lang = langForChat(chatId);
    const trimmed = code.trim();
    if (!this.running) {
      await tg.sendMessage(chatId, t("claude_login_no_flow", lang));
      return;
    }
    if (!trimmed) {
      await tg.sendMessage(chatId, t("claude_login_need_code", lang), { parse_mode: "HTML" });
      return;
    }
    if (!this.writeLine(trimmed)) {
      await tg.sendMessage(chatId, t("claude_login_no_flow", lang));
      return;
    }
    this.waitingForCode = false;
    await tg.sendMessage(chatId, t("claude_login_code_sent", lang));
  }

  async cancel(tg: Telegram, chatId: number): Promise<void> {
    const lang = langForChat(chatId);
    if (!this.running) {
      await tg.sendMessage(chatId, t("claude_login_no_flow", lang));
      return;
    }
    this.stopProcess();
    await tg.sendMessage(chatId, t("claude_login_cancelled", lang));
  }

  private async finish(tg: Telegram, chatId: number, code: number | null): Promise<void> {
    if (!this.running) return;
    this.clear();
    const lang = langForChat(chatId);
    const auth = await claudeAuthStatus();
    if (auth.loggedIn) {
      const who = auth.email ? t("claude_login_as", lang, { email: escapeHtml(auth.email) }) : "";
      await tg
        .sendMessage(chatId, t("claude_login_complete", lang, { who }), { parse_mode: "HTML" })
        .catch(() => {});
      const probe = await runClaudePromptTest(45_000);
      if (probe.ok) {
        await tg.sendMessage(chatId, t("claude_login_verified", lang)).catch(() => {});
      } else {
        const empty = !probe.stdout.trim() && !probe.stderr.trim();
        const detail = empty
          ? `exit ${probe.code ?? "timeout"}, no output`
          : clipDetail(probe.stderr || probe.stdout);
        await tg
          .sendMessage(chatId, t("claude_login_verify_failed", lang, { detail: escapeHtml(detail) }), {
            parse_mode: "HTML",
          })
          .catch(() => {});
      }
      return;
    }
    const detail =
      code === null
        ? t("claude_login_failed_started", lang)
        : t("claude_login_failed_exited", lang, { code: String(code) });
    await tg.sendMessage(chatId, t("claude_login_failed", lang, { detail })).catch(() => {});
  }

  private writeLine(line: string): boolean {
    return this.pty ? this.write(`${line}\r`) : this.write(`${line}\n`);
  }

  private writeEnter(): boolean {
    return this.pty ? this.write("\r") : this.write("\n");
  }

  private write(data: string): boolean {
    try {
      if (this.pty) {
        this.pty.write(data);
        return true;
      }
      if (this.child?.stdin.writable) {
        this.child.stdin.write(data);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private stopProcess(): void {
    try {
      this.pty?.kill();
      this.child?.kill();
    } catch {
      /* already exited */
    }
    this.clear();
  }

  private clear(): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    this.running = false;
    this.waitingForCode = false;
    this.pty = null;
    this.child = null;
  }
}

function looksLikeAuthCode(text: string): boolean {
  const s = text.trim();
  if (s.length < 8 || s.length > 512) return false;
  if (/\s/.test(s)) return false;
  if (s.startsWith("/")) return false;
  return true;
}

function clipDetail(s: string, max = 400): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function parseLoginArg(text: string): string {
  return text.replace(/^\/claude[_-]login(?:@\S+)?\s*/i, "").trim();
}

const flow = new TelegramClaudeLogin();

export function isClaudeLoginRunning(): boolean {
  return flow.isRunning();
}

/** Consume a free-text paste as the OAuth code when a login is waiting. */
export async function consumeClaudeLoginText(
  tg: Telegram,
  chatId: number,
  text: string,
): Promise<boolean> {
  if (!flow.canAcceptCode(text)) return false;
  await flow.sendCode(tg, chatId, text);
  return true;
}

export async function handleClaudeLoginCommand(tg: Telegram, chatId: number, text: string): Promise<void> {
  const arg = parseLoginArg(text);
  const lower = arg.toLowerCase();
  if (lower === "cancel") await flow.cancel(tg, chatId);
  else if (lower === "retry" || lower === "force") await flow.start(tg, chatId, true);
  else if (arg) await flow.sendCode(tg, chatId, arg);
  else await flow.start(tg, chatId, false);
}
