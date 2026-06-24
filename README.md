# claude-code-telegram

Remote access to **Claude Code** over Telegram. Message a bot from your phone and it drives a real Claude Code agent on your machine — streaming the reply back live, asking for approval before it runs anything risky.

> ⚠️ **This bot can read, write, and run commands on the machine it runs on.** Access is gated only by a Telegram user-id allow-list. Keep `ALLOWED_USER_IDS` tight, and prefer running it somewhere disposable.

## Why

The usual loop for touching a server is: open a terminal, SSH in, run something, close the session. This replaces that with a chat. It's something already running on the box that knows the system — it can check on services, restart things, set up a crontab, read logs, deploy — driven from natural-language messages. When a service falls over at 2am you get a Telegram ping and fix it from your phone, no SSH client required. Read the [full write-up →](https://gyorgy.sh/blog/claude-code-telegram).

## Screenshots

| | |
| --- | --- |
| ![Upload a photo, ask a question, and approve a command](images/tg-claude-1.webp) | ![Live-streaming a reply as it's written](images/tg-claude-2.webp) |
| Upload files & photos (Claude can *see* images), then drive the host — here approving a `Bash` call inline. | Replies stream back live as they're written, then land as a clean, formatted message. |
| ![Inline approval buttons for a Write](images/tg-claude-4.webp) | ![A denied request, answered inline instead](images/tg-claude-5.webp) |
| Every non-read-only tool call pauses for **✅ Approve · ❌ Deny · ♾️ Always allow**. | Deny it and Claude adapts — here handing back the script inline instead of writing the file. |

![A full task: writing and running a script, with formatted code output](images/tg-claude-3.webp)

*Asking for a script, approving the write, and getting formatted code with notes back — a full task end to end.*

## Features

- **Live streaming, the native way** — uses Telegram's streaming APIs: **Rich Messages** (Bot API 10.1) and **message drafts** (Bot API 9.3) so replies stream in as an animated preview and land as cleanly formatted, structured messages. A legacy edit-in-place mode is available as a fallback. See [Streaming modes](#streaming-modes).
- **Permission-first** — nothing runs without your say-so. Read-only tools (Read/Glob/Grep…) run automatically; anything that touches the system (`Bash`/`Write`/`Edit`…) pauses for **✅ Approve · ❌ Deny · ♾️ Always allow** inline buttons. "Always allow" whitelists that tool for the rest of the session; approvals auto-deny on timeout so nothing hangs.
- **A capable, on-task personality** — smart, resourceful, and concise for a phone screen, with the occasional joke but work first, fun later. Tunable in `src/prompt.ts`.
- **Operator playbook (`work.md`)** — define how recurring jobs should be done ("restart Apache", crontab edits, deploys, schedules) once, and the bot follows your conventions every time. See [work.md](#workmd--your-operator-playbook).
- **Session continuity** — context carries across messages; `/new` resets it. Sessions (resume token, cwd, mode, allow-list, cost totals) are **persisted to disk**, so they survive a restart.
- **Git review from chat** — `/diff` shows the working-tree diff (as a `.diff` file when large) with inline **Commit / Discard** buttons; `/commit <message>` stages and commits.
- **Cost & usage tracking** — `/usage` reports turns, spend, and time for the chat (today + lifetime).
- **Voice notes** — send a voice message and it's transcribed and run as a prompt. Two backends via `TRANSCRIBE_PROVIDER`: an OpenAI-compatible API (OpenAI, or Groq's free tier), or fully local **Vosk** (offline, English, needs `ffmpeg`).
- **Scheduled prompts** — `/schedule add 2h | check disk space` runs a prompt on a timer (interval or daily), autonomously, and pushes the result back to the chat.
- **Multi-project switching** — `/projects` saves working dirs and switches between them with inline buttons.
- **Persistent approval presets** — “Always allow” remembers a tool (or a specific Bash program like `git`) across restarts; manage with `/allow`, `/allowed`, `/disallow`. A middle ground between fully interactive `safe` and hands-off `auto`.
- **Working directory control** — `/cd`, `/pwd`, `/status`.
- **File send/receive** — upload files/photos (Claude *sees* images inline); Claude can send files back via a built-in `send_file` tool (images arrive as photos).
- **Quiet by default** — messages from anyone not on the allow-list are silently ignored (no reply, no trace).

## Platforms

Runs anywhere Node.js 20+ runs — **Linux**, **macOS**, and **Windows** — using the npm scripts (`npm install`, `npm run dev` / `npm run build && npm start`).

Authentication for Claude itself reuses your existing `claude` CLI login, or set `ANTHROPIC_API_KEY` in `.env`. Uses long polling, so no public webhook or open port is needed.

## Quick install (one-liner)

On a fresh **Linux** or **macOS** box, the wizard installs everything for you — Homebrew (macOS), Node 20+, git, and the Claude Code CLI — checks RAM (and offers to add swap on small Linux boxes), clones the repo, builds it, walks you through `.env`, and offers to set it up as a background service:

```bash
curl -fsSL https://gyorgy.sh/cct-install.sh | bash
```

You'll still need a [bot token](#setup) and your numeric user id to hand it (it prompts for both). Prefer to read before you run? The script is [`scripts/cct-install.sh`](scripts/cct-install.sh).

> The wizard is interactive — it reads your answers from the terminal even when piped through `curl`. For an unattended run, set `CCT_TOKEN`, `CCT_USER_IDS`, and `CCT_MODE=service|manual` (and `CCT_YES=1`) in the environment.

## Setup (manual)

1. **Create a bot**: message [@BotFather](https://t.me/BotFather), run `/newbot`, copy the token.
2. **Find your user id**: message [@userinfobot](https://t.me/userinfobot).
3. **Configure**:
   ```bash
   cp .env.example .env
   # edit .env: TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, WORKDIR
   ```
4. **Install & run**:
   ```bash
   npm install
   npm run dev         # watch mode (reloads on change)
   # or: npm run build && npm start
   ```

## Run as a service (Linux & macOS)

For an always-on deployment, install the bot as an OS service. The same commands work on both platforms — they dispatch to **systemd** on Linux and **launchd** on macOS:

```bash
./scripts/install-service.sh        # builds, installs + starts the service
./scripts/agentctl.sh status        # start | stop | restart | status | logs
./scripts/agentctl.sh logs          # follow logs
```

- **Linux** — a systemd unit (`telegram-agent`). The installer also adds a scoped, passwordless sudoers rule for just this service.
- **macOS** — a per-user LaunchAgent (`sh.gyorgy.telegram-agent`) that runs in your login session (where the `claude` CLI login lives); no sudo needed.

Either way you can **ask the agent to restart itself** ("restart yourself" → `./scripts/agentctl.sh restart`); the management commands are documented in `work.md`. The launcher `scripts/run.sh` can also be run directly without any service manager.

### Update & uninstall

```bash
./scripts/update.sh                 # git pull + npm install + build, restarts the service if installed
./scripts/uninstall-service.sh      # remove the service (leaves the checkout, .env and data/ intact)
```

`update.sh` refuses to run with uncommitted changes and only restarts when a service is actually installed, so it's safe whether you run as a service or by hand.

```
scripts/
  cct-install.sh         # one-liner bootstrap wizard (curl | bash)
  run.sh                 # launcher (build if needed, then run)
  update.sh              # pull + rebuild + restart
  install-service.sh     # installer    → dispatches by OS
  uninstall-service.sh   # uninstaller  → dispatches by OS
  agentctl.sh            # manager       → dispatches by OS
  linux/                 # systemd implementation
  macos/                 # launchd implementation
```

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | Token from @BotFather |
| `ALLOWED_USER_IDS` | yes | Comma-separated numeric Telegram user ids (the allow-list) |
| `WORKDIR` | no | Directory Claude starts in (default: the gitignored `data/` folder, so agent-created files stay out of the repo) |
| `STATE_FILE` | no | Where session + usage state is persisted across restarts (default `data/state.json`) |
| `CLAUDE_MODEL` | no | Model id (default `claude-opus-4-8`) |
| `ANTHROPIC_API_KEY` | no | API key; omit to use `claude` CLI login |
| `APPROVAL_TIMEOUT_MS` | no | Approval wait before auto-deny (default 300000) |
| `STREAM_MODE` | no | `rich` (default), `draft`, or `edit` — see below |
| `TRANSCRIBE_PROVIDER` | no | Voice backend: `openai` (default) or `vosk` (local) |
| `OPENAI_API_KEY` | no | API key for the `openai` voice backend (OpenAI, Groq, …) |
| `TRANSCRIBE_MODEL` | no | Transcription model for `openai` (default `whisper-1`) |
| `TRANSCRIBE_BASE_URL` | no | OpenAI-compatible base URL (default `https://api.openai.com/v1`) |
| `VOSK_MODEL_PATH` | no | Path to an unpacked Vosk model dir (enables the `vosk` backend) |
| `FFMPEG_PATH` | no | ffmpeg binary used to decode voice notes for Vosk (default `ffmpeg`) |
| `LOG_LEVEL` | no | `error` \| `warn` \| `info` (default) \| `debug` |
| `WORK_FILE` | no | Path to the operator playbook (default `work.md`) |

### Streaming modes

| Mode | How it streams | Notes |
| --- | --- | --- |
| `rich` | Bot API 10.1 Rich Messages (`sendRichMessageDraft` → `sendRichMessage`) | Default. Structured formatting; sent as safe escaped HTML so code (`<…>`, `#`, `$`) never breaks the parser. Private chats only. |
| `draft` | Bot API 9.3 `sendMessageDraft` → `sendMessage` | Plain animated preview, finalized as a formatted message. Private chats only. |
| `edit` | Throttled `editMessageText` of a placeholder | Most battle-tested fallback; works in any chat. |

### Voice transcription

Send a voice note and it's transcribed, then run like a typed prompt. Choose a backend with `TRANSCRIBE_PROVIDER`:

- **`openai`** (default) — any OpenAI-compatible `/audio/transcriptions` host. Use OpenAI directly, or **Groq's free tier** by setting `TRANSCRIBE_BASE_URL=https://api.groq.com/openai/v1`, `TRANSCRIBE_MODEL=whisper-large-v3-turbo`, and `OPENAI_API_KEY` to a Groq key.
- **`vosk`** — fully local and offline, no API. One-time setup:
  ```bash
  npm install vosk                 # optional native dependency
  # install ffmpeg via your package manager (brew/apt/…)
  # download + unpack a model from https://alphacephei.com/vosk/models
  #   e.g. vosk-model-small-en-us-0.15 (~40MB)
  ```
  Then set `VOSK_MODEL_PATH=/path/to/vosk-model-small-en-us-0.15` and `TRANSCRIBE_PROVIDER=vosk`. ffmpeg decodes Telegram's OGG/Opus to the 16kHz PCM Vosk expects. The small English model is fast on a CPU; larger models trade speed for accuracy.

## Permissions

The bot never runs commands on its own. For every non-read-only tool call you get an inline prompt showing exactly what Claude wants to do:

- **✅ Approve** — run it once.
- **❌ Deny** — refuse it.
- **♾️ Always allow `<Tool>`** — stop asking for that tool for the rest of this session (until `/new` or a restart).

To run without prompts entirely, switch a chat to autonomous mode with `/mode auto` (and back with `/mode safe`). Read-only tools always run automatically.

## work.md — your operator playbook

`work.md` is a plain-markdown file the bot appends to Claude's system prompt **on every turn** (so edits apply instantly, no restart). Use it to define how common, recurring tasks should be done so they happen the same way each time — for example:

- "restart Apache" → the exact command and a config test first
- editing **crontab** safely (diff, back up, non-interactive install) and scheduling jobs
- deploy steps for your projects
- ground rules (confirm destructive actions, prefer non-interactive commands)

A starter template ships in `work.md`; replace the examples with what's true for your machine. Point `WORK_FILE` elsewhere to use a different file.

## Commands

| Command | Action |
| --- | --- |
| `/new` | Start a fresh conversation |
| `/cd <path>` | Change working directory |
| `/pwd` | Show current directory |
| `/status` | Show session info (cwd, model, mode, session id) |
| `/projects` | Saved working dirs; switch/add/remove via inline buttons |
| `/diff` | Review the working-tree diff, then commit or discard inline |
| `/commit <message>` | Stage all changes and commit |
| `/usage` | Show cost & activity for this chat (today + lifetime) |
| `/allow <Tool>` · `/allowed` · `/disallow <Tool\|all>` | Manage persistent always-allow rules |
| `/schedule [list]` · `/schedule add <when> \| <prompt>` · `/schedule rm <id>` | Timed autonomous prompts (`when` = `30m`/`2h`/`1d` or `HH:MM`) |
| `/stop` | Abort the running request |
| `/mode safe\|auto` | Interactive approval (default) or autonomous |
| `/help` | Show help |

You can also send a **voice note** (transcribed and run as a prompt) or upload **files/photos** (Claude sees images inline).

## Architecture

```
src/
  index.ts            entry: load config, build bot, set commands, launch
  config.ts           env parse + validation (zod)
  auth.ts             allow-list middleware (silently drops non-admins)
  logger.ts           tiny timestamped structured logger (LOG_LEVEL)
  prompt.ts           personality + work.md -> system prompt (per turn)
  bot.ts              Telegraf wiring + per-turn orchestration
  commands.ts         /new /cd /pwd /status /projects /diff /commit /usage /allow /schedule /stop /mode /help
  git.ts              shell-free git helpers (status, diff, commit, restore)
  session/
    manager.ts        per-chat state (sessionId, cwd, busy, mode, allow-lists, projects, usage)
    store.ts          JSON persistence of session + usage state across restarts
  schedule/
    manager.ts        schedule parsing, next-run math, tick loop running autonomous turns
    store.ts          JSON persistence of schedules (sibling of the state file)
  claude/
    runner.ts         wraps the Agent SDK query(); fans events to callbacks; inline image vision
    events.ts         narrow type guards over SDK messages
  telegram/
    streamer.ts          edit-in-place streaming backend ("edit")
    baseDraftStreamer.ts  shared draft machinery (throttle + keepalive)
    draftStreamer.ts      Bot API 9.3 sendMessageDraft backend ("draft")
    richDraftStreamer.ts  Bot API 10.1 Rich Messages backend ("rich")
    send.ts            shared final-message sender (markdown -> HTML, splitting)
    formatting.ts      markdown -> Telegram HTML (headings, bold, code, quotes)
    permissions.ts     approval keyboards (incl. per-Bash-command preset) + registry
    gitFlow.ts         /diff rendering + commit/discard buttons + callbacks
    projects.ts        /projects switch menu + callbacks
    voice.ts           voice-note transcription dispatcher (openai | vosk)
    vosk.ts            local offline transcription (ffmpeg decode + Vosk)
    files.ts           incoming file downloads + image decoding for vision
  mcp/sendFile.ts     in-process MCP tool so Claude can send files back
```

Built on [`telegraf`](https://github.com/telegraf/telegraf) and [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

## Support & troubleshooting

- **Bot doesn't respond at all** — confirm your numeric id is in `ALLOWED_USER_IDS`; unknown users are ignored silently. Check the console logs (raise detail with `LOG_LEVEL=debug`).
- **`npm start` shows stale behavior** — `npm start` runs the compiled `dist/`; rebuild with `npm run build` first.
- **Rich formatting looks off** — try `STREAM_MODE=draft` or `STREAM_MODE=edit` in `.env`. Rich/draft modes require a **private** chat.
- **Approvals never resolve** — make sure only **one** instance is polling; two pollers split updates and cause conflicts.

## Credits

Created by **Gyorgy** — [gyorgy.sh](https://gyorgy.sh) · [github.com/gyorgysh](https://github.com/gyorgysh).

> 🤖 **Fun fact:** this project was built hand-in-hand with Claude — which is fitting, since the whole thing exists to put Claude Code in your pocket. Claude helped write the bot that lets you talk to Claude. Turtles all the way down.

## License

MIT
