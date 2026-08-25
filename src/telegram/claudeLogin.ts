import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import type { Telegram } from "telegraf";
import { claudeAuthStatus } from "../setup/claude.js";
import { log } from "../logger.js";

const CLAUDE_CLI = process.platform === "win32" ? "claude.cmd" : "claude";
const URL_RE = /https:\/\/[^\s\x1b"'<>)\]]+/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

type Pty = { kill(): void };

/** One machine-wide local Claude OAuth flow. No prompt is sent to an LLM. */
class TelegramClaudeLogin {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pty: Pty | null = null;
  private running = false;
  private output = "";
  private urlSent = false;
  private timeout?: ReturnType<typeof setTimeout>;

  async start(tg: Telegram, chatId: number): Promise<void> {
    const auth = await claudeAuthStatus();
    if (!auth.cliInstalled) {
      await tg.sendMessage(chatId, "⚠️ Claude Code CLI is not installed or is not on PATH.");
      return;
    }
    if (auth.loggedIn) {
      await tg.sendMessage(chatId, `✅ Claude is already signed in${auth.email ? ` as ${auth.email}` : ""}.`);
      return;
    }
    if (this.running) {
      await tg.sendMessage(chatId, "⏳ A Claude login is already in progress on this machine. Finish it in the browser, or use /claude_login cancel.");
      return;
    }

    this.running = true;
    this.output = "";
    this.urlSent = false;
    await tg.sendMessage(chatId, "🔐 Starting Claude login locally (no LLM involved)…");
    this.timeout = setTimeout(() => {
      this.stopProcess();
      void tg.sendMessage(chatId, "⚠️ Claude login timed out after 10 minutes. Run /claude_login to try again.").catch(() => {});
    }, LOGIN_TIMEOUT_MS);

    const consume = (chunk: string) => {
      this.output = (this.output + chunk).slice(-65_536);
      if (this.urlSent) return;
      const match = this.output.replace(ANSI_RE, "").match(URL_RE);
      if (!match) return;
      this.urlSent = true;
      void tg.sendMessage(chatId, "Open this page and complete the Claude sign-in. The local terminal session will finish automatically.", {
        reply_markup: { inline_keyboard: [[{ text: "Continue with Claude", url: match[0] }]] },
      }).catch((err) => log.warn("Could not send Claude login URL", { error: String(err) }));
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

  async cancel(tg: Telegram, chatId: number): Promise<void> {
    if (!this.running) {
      await tg.sendMessage(chatId, "No Claude login is currently running.");
      return;
    }
    this.stopProcess();
    await tg.sendMessage(chatId, "Cancelled the local Claude login.");
  }

  private async finish(tg: Telegram, chatId: number, code: number | null): Promise<void> {
    if (!this.running) return;
    this.clear();
    const auth = await claudeAuthStatus();
    if (auth.loggedIn) {
      await tg.sendMessage(chatId, `✅ Claude login complete${auth.email ? ` as ${auth.email}` : ""}. New Claude turns can run now.`).catch(() => {});
      return;
    }
    const detail = code === null ? "could not be started" : `exited with code ${code}`;
    await tg.sendMessage(chatId, `⚠️ Claude login ${detail} before sign-in completed. Run /claude_login to retry.`).catch(() => {});
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
    this.pty = null;
    this.child = null;
  }
}

const flow = new TelegramClaudeLogin();

export async function handleClaudeLoginCommand(tg: Telegram, chatId: number, text: string): Promise<void> {
  const arg = text.split(/\s+/)[1]?.toLowerCase();
  if (arg === "cancel") await flow.cancel(tg, chatId);
  else await flow.start(tg, chatId);
}
