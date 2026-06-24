# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram bot that exposes a real Claude Code agent over chat. A user messages the bot; the bot drives the Claude Agent SDK on the host machine, streams the reply back live, and gates risky tool calls behind inline approval buttons. **The bot can read/write/run anything on the host** — the only access control is the `ALLOWED_USER_IDS` allow-list enforced in `src/auth.ts`.

## Commands

```bash
npm run dev        # tsx watch — run locally with reload
npm run build      # tsc -> dist/
npm start          # node dist/index.js (requires build first)
npm run typecheck  # tsc --noEmit
```

There is no test suite, linter config, or single-test runner. `typecheck` (strict mode, with `noUnusedLocals`/`noUnusedParameters`) is the only automated check — run it after changes.

Requires Node >= 20. Config comes from `.env` (copy from `.env.example`); the process exits at startup with a printed list of issues if required vars are missing (see `parseConfig` in `src/config.ts`).

### Deployment scripts (`scripts/`)

`cct-install.sh` is the self-contained `curl | bash` wizard (installs prerequisites, clones, builds, configures `.env`, optionally installs the service); it does **not** assume a checkout and reads prompts from `/dev/tty` so it stays interactive when piped. The rest operate on an existing checkout: `run.sh` (launcher, also the service `ExecStart`), `update.sh` (pull + build + restart-if-service), `install-service.sh` / `uninstall-service.sh` / `agentctl.sh` (all OS-dispatchers to `linux/` = systemd, `macos/` = launchd). Keep the dispatchers thin and put platform specifics in the `linux/`/`macos/` impls. The hosted `https://gyorgy.sh/cct-install.sh` is a rewrite of the raw GitHub file — **bump both together** when changing the installer.

## Architecture

ESM throughout (`"type": "module"`), so **relative imports must use the `.js` extension** even though sources are `.ts`.

Request lifecycle for one user message (`handleUserPrompt` in `src/bot.ts`):
1. `auth.ts` middleware drops anyone not in `allowedUserIds`.
2. A per-chat `Session` (`src/session/manager.ts`) holds `sessionId` (Claude resume token), `cwd`, `busy` flag, `abort` controller, `mode`, the per-session "always allow" tool set, and `usage` counters. The durable fields (everything but `busy`/`abort`) are persisted to `STATE_FILE` (JSON, default `data/state.json`) via `src/session/store.ts` — loaded on boot, written debounced on mutation, and flushed on shutdown — so sessions survive a restart.
3. A placeholder message is sent, wrapped in a `TelegramStreamer`.
4. `runTurn` (`src/claude/runner.ts`) calls the SDK `query()` and iterates its async message stream, fanning events to callbacks: `onText` (streaming deltas), `onToolUse` (status line), `onSessionId` (capture resume token), and the final `result` (cost/duration).
5. Streamer edits the message in place (throttled) and the loop ends; `busy`/`abort` are cleared in `finally`.

Key cross-cutting pieces:
- **Permission flow** (`src/telegram/permissions.ts` + `canUseTool` in `bot.ts`): read-only tools in `AUTO_ALLOWED_TOOLS` (`runner.ts`) run automatically; everything else posts Approve/Deny/Always-allow buttons and the `canUseTool` promise blocks until a `callback_query` resolves it (or it times out → deny). "Always" adds the tool to `session.sessionAllowedTools`. Pending requests are keyed by a random id embedded in the callback data (`appr:<id>:<action>`).
- **Modes**: `safe` maps to SDK `permissionMode: "default"` (interactive approval); `auto` maps to `"bypassPermissions"` (no prompts). Set via `/mode`.
- **Streaming** — three backends behind `STREAM_MODE` (config), all implementing the `Streamer` interface (`appendText`/`setStatus`/`finalize`), selected in `handleUserPrompt`:
  - `rich` (default): Bot API 10.1 Rich Messages. Streams `sendRichMessageDraft` (Claude's markdown → `InputRichMessage.markdown`, Telegram parses the structure) and finalizes with `sendRichMessage`. `richDraftStreamer.ts`.
  - `draft`: Bot API 9.3 `sendMessageDraft` — plain-text animated preview, finalized as a normal formatted `sendMessage`. `draftStreamer.ts`.
  - `edit`: legacy throttled `editMessageText` of a placeholder + typing indicator. `streamer.ts`.
  - The two draft backends share `baseDraftStreamer.ts` (throttled flush + 20s keepalive so the 30s ephemeral preview doesn't lapse; stable non-zero `draft_id` so updates animate). Drafts are **private-chat only** and **ephemeral** — nothing persists until the `finalize` send. `send.ts` holds the shared final-send (markdown→HTML, 4096 split, plain-text fallback on "can't parse entities"); `formatting.ts` does the markdown→HTML conversion used by the non-rich paths.
  - Bot API 9.3/10.1 methods have no telegraf wrapper (4.16.3), so they're called raw via `tg.callApi(<method>, …)` (typed loosely as `RawApi`).
- **MCP send_file** (`src/mcp/sendFile.ts`): an in-process MCP server giving Claude a `send_file` tool to push files back to the chat. It's in `AUTO_ALLOWED_TOOLS` because it's a deliberate user-facing action.
- **Incoming files** (`src/telegram/files.ts`): uploaded docs/photos are downloaded into the session `cwd`, then a synthetic prompt tells Claude where the file landed. Images (`isViewableImage`) are additionally read back as base64 (`readImageInput`) and passed to the runner as inline vision content blocks — `runTurn` switches from a string prompt to a one-shot streaming-input `SDKUserMessage` (`imagePrompt` in `runner.ts`) when `images` are present, so the model sees the picture directly instead of via a `Read` round-trip.
- **Git review flow** (`src/git.ts` + `src/telegram/gitFlow.ts`): `/diff` renders the working-tree status+diff (sent as a `.diff` document when large) with inline Commit/Discard buttons; `/commit <msg>` stages and commits. Button presses are routed through the shared `callback_query` handler in `bot.ts` (`isGitCallback`/`resolveGitCallback`), namespaced `git:<action>`; Discard requires a second confirm press and only touches tracked files. All git calls go through `execFile` (no shell) and never throw — failures come back as `{ ok: false }`.
- **Usage tracking**: `runTurn`'s `result` cost/duration is folded into per-session lifetime + per-day buckets (`sessions.recordUsage`, persisted); `/usage` reports today + lifetime for the chat.
- **Approval presets** (`src/telegram/permissions.ts` + `canUseTool`): "Always allow" persists across restarts (it writes `session.sessionAllowedTools`, which is serialized). Bash approvals get an extra "always allow `<program>` commands" button whose leading token (`bashLeadCmd`) is stored in `session.allowedBashCmds`; `canUseTool` auto-allows a Bash call whose lead matches. `/allow`, `/allowed`, `/disallow` manage these. This is the middle tier between `safe` (prompt everything) and `auto` (prompt nothing).
- **Projects** (`src/telegram/projects.ts`): per-session list of saved cwds (`session.projects`, persisted). `/projects` posts an inline menu; `proj:` callbacks switch/add/remove and re-render the keyboard in place.
- **Voice** (`src/telegram/voice.ts` dispatcher): `TRANSCRIBE_PROVIDER` selects `openai` (download → POST to an OpenAI-compatible `/audio/transcriptions`, works with Groq too) or `vosk` (`src/telegram/vosk.ts`: ffmpeg decodes OGG/Opus → 16kHz mono PCM, fed to a lazily-loaded, cached Vosk model — `vosk` is an **optionalDependency**, imported via a non-literal specifier so the build doesn't require it). Either way the transcript is echoed and run as a normal text turn; `voiceEnabled()`/`voiceSetupHint()` gate it per provider.
- **Scheduling** (`src/schedule/`): `ScheduleManager` (singleton `schedules`) holds a persisted list (sibling `schedules.json`) and a 30s tick loop. `bot.ts` injects the runner via `schedules.start(...)`: a due job runs as an **autonomous** turn (`runUserPrompt(..., { autonomous: true, cwd })` → `bypassPermissions`) in the schedule's captured cwd, skipped (and retried next tick) if the chat is busy. `parseWhen` accepts `30m/2h/1d` (interval, ≥1m) or `HH:MM` (daily, server-local time). The per-turn `autonomous`/`cwd` overrides live on `handleUserPrompt`'s `TurnOptions`.

- **Management panel** (`src/panel/server.ts` + `src/core/` + `panel/`): an optional embedded web dashboard, off unless `PANEL_ENABLED=true` (and it refuses to start without `PANEL_TOKEN` — enforced in `config.ts`'s `superRefine`). A Fastify server started in-process from `index.ts` (`startPanel`), so its handlers read the live `sessions`/`schedules` singletons directly — no IPC. Token auth (`Bearer` header for REST, `?token=` for the WS) gates everything under `/api`/`/ws`; static SPA assets are served freely. Read-only dashboards: `/api/health` (a `systeminformation` snapshot — CPU/mem/swap/disk/IO, `src/core/health.ts`), `/api/sessions`, `/api/schedules`, `/api/usage` (views in `src/core/snapshot.ts`), `/api/audit`. Write features (all telegraf-free in `src/core/`, each persisting to its own JSON store in the data dir via `src/core/jsonStore.ts`, and appending to `audit.jsonl` via `src/core/audit.ts`): **prompt** (`playbook.ts` — view the read-only personality + read/write `work.md`), **skills** (`skills.ts` — a reusable prompt library; `claudeFiles.ts` — a scoped browser/editor for on-disk `.claude/{agents,skills,commands}/*.md` + `CLAUDE.md` under known cwds, writes refused outside those paths), **tasks** (`tasks.ts` — a Trello board with `backlog/doing/done` columns + drag-drop reorder), and **workers** (`workers.ts` — persisted sub-agents). The `WorkerManager` (singleton `workers`) runs named autonomous agents via `runTurn` directly (own `AbortController`, `bypassPermissions`, optional per-worker `systemPromptAppend` built from a skill + persona); runs are **concurrent** (one in-flight per worker, keyed in an `active` map — not gated by the per-chat `busy` flag), can be scheduled (own 30s tick reusing `parseWhen`/`nextRun`), and stream live output to all panel clients through the `PanelHub` (`src/panel/hub.ts`), which also owns the 2s health push on `/ws`. `runTurn` gained an optional `systemPromptAppend` (threaded into `systemPrompt()` in `prompt.ts`). The frontend (`panel/`) is a separate React+Vite+Tailwind v4 app (semantic theme tokens in `index.css` give light/dark) built to `panel/dist` (served by Fastify in prod; `vite dev` proxies `/api`+`/ws` in dev). `npm run build` builds the panel first, then `tsc`. Bind defaults to loopback — expose remotely only behind a reverse proxy / private network.

The SDK is configured with `settingSources: ["user", "project", "local"]` so the driven agent loads real CLAUDE.md / settings from whatever `cwd` it runs in — i.e. this bot behaves like a genuine Claude Code session in the target project, not a sandbox.

- **System prompt / personality** (`src/prompt.ts`): each turn passes `systemPrompt: { type: "preset", preset: "claude_code", append }` — keeping Claude Code's defaults while appending a fixed personality plus the contents of `work.md` (path overridable via `WORK_FILE`). `work.md` is an operator playbook (how to handle recurring ops requests — services, crontab, deploys) re-read every turn, so edits apply without a restart.

`src/claude/events.ts` holds narrow type guards over the SDK's loosely-typed message union; prefer adding/using a guard there over inline `any` casts when reading new SDK message fields.
