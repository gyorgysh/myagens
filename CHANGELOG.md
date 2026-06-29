# Changelog

All notable changes to MyHQ are documented here, grouped by release.
Commit links point to `github.com/gyorgysh/myhq`.

## [0.5.5] - 2026-06-29

### Added
- **Agent avatars**: pick an avatar from a curated set (13 flat-illustration assets) for any worker/Lead; avatars show on Crew/Workers cards and in chat bubbles, and each Lead bot's Telegram profile photo is set automatically on startup. ([a9367b4](https://github.com/gyorgysh/myhq/commit/a9367b4), [187b7bc](https://github.com/gyorgysh/myhq/commit/187b7bc), [569a097](https://github.com/gyorgysh/myhq/commit/569a097), [db6df2e](https://github.com/gyorgysh/myhq/commit/db6df2e))
- **Run Agent modal**: the worker cards' Run Agent button opens a confirmation modal with the agent name, role, working directory, and a one-shot editable prompt (prefilled, never mutating the saved worker). ([13c822d](https://github.com/gyorgysh/myhq/commit/13c822d))
- **Autonomy level selector in Chat**: choose supervised/standard/full per panel chat from the toolbar, replacing the removed `PANEL_CHAT_BYPASS` env flag. ([5f98335](https://github.com/gyorgysh/myhq/commit/5f98335), [6bec138](https://github.com/gyorgysh/myhq/commit/6bec138))
- **Interactive AskUserQuestion widgets** in panel chat, backed by `GET /api/asks` and `POST /api/asks/resolve`. ([78b7f7b](https://github.com/gyorgysh/myhq/commit/78b7f7b))
- **Chat permissions indicator** with browser-resolvable approvals. ([abac35c](https://github.com/gyorgysh/myhq/commit/abac35c))
- **PLANNING badge** shown in chat instead of the raw planning preamble. ([cd80443](https://github.com/gyorgysh/myhq/commit/cd80443))

### Security
- **`crew_delegate` privilege-escalation fix**: the delegated child run's autonomy is now capped at the caller's (only `full`/`auto_until_error` callers grant bypass), and a planning turn files the delegation to the suggestion inbox for explicit approval instead of firing real work. ([26f929c](https://github.com/gyorgysh/myhq/commit/26f929c))

## [0.5.4] - 2026-06-29

### Added
- **Semantic search for tasks and skills**: new `task_search` and `skill_search` MCP tools (auto-allowed) let agents find existing cards and skills by meaning before creating duplicates, via a shared cosine + keyword blend with keyword-only fallback when embeddings are off. ([75c0a08](https://github.com/gyorgysh/myhq/commit/75c0a08))
- **In-panel changelog viewer**: the Updates view fetches the public CHANGELOG, shows a collapsible "What's new" section for releases newer than the installed version, a year-grouped Release history, and falls back to the locally served changelog when GitHub is unreachable. ([edd2240](https://github.com/gyorgysh/myhq/commit/edd2240), [6fcb9fa](https://github.com/gyorgysh/myhq/commit/6fcb9fa), [b049ddb](https://github.com/gyorgysh/myhq/commit/b049ddb))
- **Update-first nudge on Feedback**: a soft, non-blocking callout links to the Updates tab when the deployment is behind. ([edd2240](https://github.com/gyorgysh/myhq/commit/edd2240))
- **Version badge and changelog link in Setup**: the bot identity step shows the running version (amber when an update is available) alongside a link to the changelog. ([c2898cb](https://github.com/gyorgysh/myhq/commit/c2898cb))
- **Bulk-delegate Tasks to a chosen Lead**: the board's bulk-select now includes a Lead picker, queuing the selected cards as autonomous runs under that Lead (or auto-routed). ([0a45c1e](https://github.com/gyorgysh/myhq/commit/0a45c1e))
- **Expand/collapse markdown notes** on every Kanban card, not just done cards, for long or multi-line notes. ([1697319](https://github.com/gyorgysh/myhq/commit/1697319))
- **Markdown link rendering** (`[text](url)`) in the panel Markdown component, and a local `GET /api/update/changelog` route. ([b049ddb](https://github.com/gyorgysh/myhq/commit/b049ddb))

### Improved
- **Agent chat resume token** now persists per-agent to `agentChat.json`, so a panel chat with a Lead survives a restart instead of starting cold. ([b1703f2](https://github.com/gyorgysh/myhq/commit/b1703f2))
- **Planning/Execution toggle** remembers its last state per agent in localStorage instead of resetting to Execution on every mount. ([0025d0c](https://github.com/gyorgysh/myhq/commit/0025d0c))
- Documented that each Lead bot's session already survives restarts and updates (resume token in `data/lead-<id>-state.json`, untouched by `update.sh`). ([803b15e](https://github.com/gyorgysh/myhq/commit/803b15e))

## [0.5.3] - 2026-06-29

### Added
- **Planning mode for Lead chat**: the Execution/Planning toggle now works in every Lead/worker panel chat session, not just Atlas. Leads stay conversational and propose backlog cards instead of taking real actions. ([c5c26d1](https://github.com/gyorgysh/myhq/commit/c5c26d1), [d910ced](https://github.com/gyorgysh/myhq/commit/d910ced))
- **Inbox "Run as one task" bulk action**: select multiple suggestions and delegate them as a single merged task. ([be39693](https://github.com/gyorgysh/myhq/commit/be39693))
- **Inbox multi-select** with bulk park / delegate / dismiss and delegate-as-Lead. ([7b1cd95](https://github.com/gyorgysh/myhq/commit/7b1cd95))
- **Embeddings probe chip**: panel now shows which embedding backend is live and lets you manually override auto-probe mode. ([2af6d17](https://github.com/gyorgysh/myhq/commit/2af6d17))
- **Markdown card notes** in Tasks, Lucide icon set across nav, chat role labels, Crew role chips. ([d910ced](https://github.com/gyorgysh/myhq/commit/d910ced), [1ca66e0](https://github.com/gyorgysh/myhq/commit/1ca66e0))
- **Semantic colour tokens** for the Logs activity feed and memory tier indicators. ([69455c8](https://github.com/gyorgysh/myhq/commit/69455c8))

### Improved
- **`auto_until_error` escalation state** is now persisted across restarts. ([7b98dc8](https://github.com/gyorgysh/myhq/commit/7b98dc8))
- **Schedules**: busy-chat fallback behaviour improved, errors surfaced in the panel. ([ee8028e](https://github.com/gyorgysh/myhq/commit/ee8028e))
- **Panel bundle split**: main chunk down from 647 kB to 250 kB (roughly 61% smaller) via `React.lazy` for 20 tabs and separate vendor chunks for React, Lucide, and xterm. ([731ebd7](https://github.com/gyorgysh/myhq/commit/731ebd7))

### Fixed
- Loopback addresses now exempt from panel auth lockout. ([6ba3ea3](https://github.com/gyorgysh/myhq/commit/6ba3ea3))
- Keyboard navigation for clickable Task cards. ([cf7f5fa](https://github.com/gyorgysh/myhq/commit/cf7f5fa))
- Workers wizard "Done" button missing i18n string. ([bb2c418](https://github.com/gyorgysh/myhq/commit/bb2c418))
- Stale agent chat empty-state copy (claimed sessions were stateless when they are not). ([5de9df2](https://github.com/gyorgysh/myhq/commit/5de9df2))

## [0.5.2] - 2026-06-29

### Added
- **Agent identity + diff rendering** in panel agent chat: tool calls show which agent ran them and a mini diff for file edits. ([86fd81c](https://github.com/gyorgysh/myhq/commit/86fd81c))
- **Web Chat badge** on Crew/Agents cards: one click opens a panel chat session with that Lead. ([34d8580](https://github.com/gyorgysh/myhq/commit/34d8580))
- **Command palette** (Cmd+K / Ctrl+K): keyboard-first navigation across all panel views. ([067e13a](https://github.com/gyorgysh/myhq/commit/067e13a))
- **Mobile UX pass**: searchable More drawer, bottom nav, Kanban scroll-snap, Health status strip, Chat FAB. ([64dd8c4](https://github.com/gyorgysh/myhq/commit/64dd8c4))
- **3-tier nav, Command Hub, unified Settings**: desktop sidebar reorganised into three groups; chat and terminal share a hub. ([e541b97](https://github.com/gyorgysh/myhq/commit/e541b97))

### Improved
- Default `PANEL_RATE_LIMIT` raised from 30 to 120 req/min. ([12a4dd2](https://github.com/gyorgysh/myhq/commit/12a4dd2))
- Delegation log secrets redacted; hot-tier memory hardened against injection. ([1bf53f5](https://github.com/gyorgysh/myhq/commit/1bf53f5))
- Schedule prompts capped/sanitised; mutating API routes rate-limited. ([1747a31](https://github.com/gyorgysh/myhq/commit/1747a31))

### Fixed
- Multiple nav categorisation and icon alignment fixes across desktop and mobile sidebar. ([90db310](https://github.com/gyorgysh/myhq/commit/90db310), [192efb6](https://github.com/gyorgysh/myhq/commit/192efb6), [c8facad](https://github.com/gyorgysh/myhq/commit/c8facad), [7f931db](https://github.com/gyorgysh/myhq/commit/7f931db))
- Crew/Agents status badge redesign. ([93d5fe1](https://github.com/gyorgysh/myhq/commit/93d5fe1))

## [0.5.1] - 2026-06-29

### Added
- **Encrypted backup and restore**: one-click export/import of all fleet state (memory, tasks, skills, vault, schedules). ([c5ea8b6](https://github.com/gyorgysh/myhq/commit/c5ea8b6))
- **Spoken TTS replies** via OpenAI or local Piper. ([09f4564](https://github.com/gyorgysh/myhq/commit/09f4564))
- **Calendar-aware heartbeat**: proactive assistant with quiet hours tied to calendar availability. ([d64b5bf](https://github.com/gyorgysh/myhq/commit/d64b5bf))
- **Global dry-run mode**: mutating tools (write/edit/bash) silently no-op for safe exploration. ([1e07257](https://github.com/gyorgysh/myhq/commit/1e07257))
- **Web Push notifications** and panel approval queue. ([ece1aca](https://github.com/gyorgysh/myhq/commit/ece1aca))
- **Guided setup wizard** for first-run onboarding. ([f3f1a11](https://github.com/gyorgysh/myhq/commit/f3f1a11))
- **Tasks**: blocked-by dependencies, newest-first sort, live run timer, queue pause/clear, session resume on retry. ([973c991](https://github.com/gyorgysh/myhq/commit/973c991), [822d3f4](https://github.com/gyorgysh/myhq/commit/822d3f4), [465ddea](https://github.com/gyorgysh/myhq/commit/465ddea))
- **Rate-limit auto-fallback** to a local provider when the primary is throttled. ([a7a01bb](https://github.com/gyorgysh/myhq/commit/a7a01bb))
- **i18n**: all user-facing strings in bot.ts, commands.ts, and leadBot.ts translated; panel footer and bulk-selected count localised. ([8d53c6b](https://github.com/gyorgysh/myhq/commit/8d53c6b), [9bbb863](https://github.com/gyorgysh/myhq/commit/9bbb863))

### Fixed
- Usage bar charts collapsing to zero height. ([492a327](https://github.com/gyorgysh/myhq/commit/492a327))
- Drag-drop insertion indicator and themed Logs date select. ([e2c678e](https://github.com/gyorgysh/myhq/commit/e2c678e))

## [0.5.0] - 2026-06-28

### Added
- **Agent chat** in the panel: interactive multi-turn sessions with any Lead or worker. ([cc5c06f](https://github.com/gyorgysh/myhq/commit/cc5c06f))
- **Feedback panel**: in-app feedback relay with optional email. ([cc5c06f](https://github.com/gyorgysh/myhq/commit/cc5c06f))
- **Per-agent and per-category usage tracking**: token and cost breakdown by agent and role. ([66dd083](https://github.com/gyorgysh/myhq/commit/66dd083), [2a15962](https://github.com/gyorgysh/myhq/commit/2a15962))
- **Windows support**: PowerShell installer wizard, NSSM service, update/uninstall scripts. ([7478b05](https://github.com/gyorgysh/myhq/commit/7478b05) and multiple follow-up fixes)
- **Connection banner**: sticky panel banner on backend outage with auto-reload on recovery. ([167aeda](https://github.com/gyorgysh/myhq/commit/167aeda), [fdc3a56](https://github.com/gyorgysh/myhq/commit/fdc3a56))
- **Process uptime**, connector scope toggles, task log filter. ([60e05d2](https://github.com/gyorgysh/myhq/commit/60e05d2))
- **GitHub Actions CI**: typecheck and build on every push. ([18e2f84](https://github.com/gyorgysh/myhq/commit/18e2f84))
- **Granular cache-control** for panel static assets. ([9582968](https://github.com/gyorgysh/myhq/commit/9582968))
- **Auto-detect local providers** (Ollama, LM Studio), one-click panel login link from installer. ([ed8aa26](https://github.com/gyorgysh/myhq/commit/ed8aa26))

### Fixed
- Memory crash on lone UTF-16 surrogates in Claude CLI output. ([b2a3f8c](https://github.com/gyorgysh/myhq/commit/b2a3f8c))

## [0.4.1] - 2026-06-28

### Added
- **Gmail, Google Drive, Apple Calendar, Apple Mail connectors.** ([1c87983](https://github.com/gyorgysh/myhq/commit/1c87983))
- **PWA support**: installable on iOS and Android with offline caching. ([b51c2df](https://github.com/gyorgysh/myhq/commit/b51c2df))
- **Toast notifications** and skeleton loaders across the panel. ([b51c2df](https://github.com/gyorgysh/myhq/commit/b51c2df))
- **Onboarding art** and sidebar hints for empty states. ([b51c2df](https://github.com/gyorgysh/myhq/commit/b51c2df))
- **Try agent** button, portfolio truncation, task ID surfaced in logs and cards. ([ae655ce](https://github.com/gyorgysh/myhq/commit/ae655ce))

### Fixed
- Skip project/local `settingSources` for autonomous runs to avoid picking up wrong CLAUDE.md. ([08e9974](https://github.com/gyorgysh/myhq/commit/08e9974))
- Installer browser open, Windows PATH, and update reliability improvements. ([bcd806b](https://github.com/gyorgysh/myhq/commit/bcd806b))

## [0.4.0] - 2026-06-27

### Added
- **Secret vault**: AES-256-GCM encrypted secrets, macOS Keychain or key-file on Linux, rotation and backup/restore. ([b8c72ee](https://github.com/gyorgysh/myhq/commit/b8c72ee))
- **Crew hierarchy**: Lead bots with their own Telegram tokens, `crew_delegate`, `crew_report`, `crew_ask_president`, `crew_suggest`. ([b8c72ee](https://github.com/gyorgysh/myhq/commit/b8c72ee))
- **Kanban task board** with delegation to autonomous runs, WIP limits, drag-drop, bulk select, blocked-by ordering. ([b8c72ee](https://github.com/gyorgysh/myhq/commit/b8c72ee))
- **Council votes**: `/council <proposal>` runs all Leads as one-shot SUPPORT/OPPOSE voters. ([b8c72ee](https://github.com/gyorgysh/myhq/commit/b8c72ee))
- **Suggestion inbox**: Leads file non-urgent ideas via `crew_suggest`; president triages from the panel. ([9b0ab54](https://github.com/gyorgysh/myhq/commit/9b0ab54))
- **Remote access / tunnel relay**: ngrok or cloudflared child process, Basic Auth gate, auto-start. ([5ab31d1](https://github.com/gyorgysh/myhq/commit/5ab31d1))
- **AskUserQuestion** rendered as inline Telegram buttons. ([158298e](https://github.com/gyorgysh/myhq/commit/158298e))
- **Agentic loop detector**: SHA-256 hashes tool+input, prompts or aborts at threshold. ([60a6555](https://github.com/gyorgysh/myhq/commit/60a6555))
- **Per-chat turn rate limiter** in the Telegram bot. ([5e016ff](https://github.com/gyorgysh/myhq/commit/5e016ff))
- **SSRF guard** (`safeFetch`, `assertSafeUrl`) on all server-side outbound fetches. ([b5b655c](https://github.com/gyorgysh/myhq/commit/b5b655c))
- Task concurrency queue, provider probe diagnostics, hot-memory shorten threshold. ([b5b655c](https://github.com/gyorgysh/myhq/commit/b5b655c), [c5c0e52](https://github.com/gyorgysh/myhq/commit/c5c0e52))
- Activity feed shows crew tool calls with meaningful detail. ([955301b](https://github.com/gyorgysh/myhq/commit/955301b))

### Security (0.3.x batch included here)
- Panel token brute-force hardening and URL-leakage fix. ([502b687](https://github.com/gyorgysh/myhq/commit/502b687))
- Provider authToken never returned in plaintext. ([7e957e2](https://github.com/gyorgysh/myhq/commit/7e957e2))
- Panel terminal gated behind a flag; env sanitised. ([a9880dc](https://github.com/gyorgysh/myhq/commit/a9880dc))
- Log lines redacted before persistence. ([8a2f04c](https://github.com/gyorgysh/myhq/commit/8a2f04c))
- SSRF guard on all outbound fetches. ([5d84440](https://github.com/gyorgysh/myhq/commit/5d84440))
- Symlink-escape fix for `claudeFiles` path canonicalisation. ([cf931fa](https://github.com/gyorgysh/myhq/commit/cf931fa))
- Private-chat enforcement on Lead bots. ([1cffb5a](https://github.com/gyorgysh/myhq/commit/1cffb5a))
- Data dir `chmod 0700`, proto-pollution reviver, Vite bumped. ([0eb24ff](https://github.com/gyorgysh/myhq/commit/0eb24ff))

## [0.3.1] - 2026-06-27

### Added
- **Memory maintenance**: deterministic tier decay, Haiku consolidation pass, shorten-verbose pass; interval-based scheduler. ([b7118db](https://github.com/gyorgysh/myhq/commit/b7118db), [3e71117](https://github.com/gyorgysh/myhq/commit/3e71117))
- **Maintenance dry-run preview** before compaction runs. ([fdf67e9](https://github.com/gyorgysh/myhq/commit/fdf67e9))
- **Council votes from Crew view** in the panel. ([ef63fc3](https://github.com/gyorgysh/myhq/commit/ef63fc3))
- **Lead protocol** injected into Lead system prompts; delegation log expand. ([ca7ed6d](https://github.com/gyorgysh/myhq/commit/ca7ed6d))
- **Lead bot AskUserQuestion** inline buttons. ([147bbb1](https://github.com/gyorgysh/myhq/commit/147bbb1))
- **Restore button** on archived task cards. ([9f12012](https://github.com/gyorgysh/myhq/commit/9f12012))
- Lead bot splits final reply on `---` separator, matching main bot UX. ([41d5d21](https://github.com/gyorgysh/myhq/commit/41d5d21))
- Persona-aware inbox delegation. ([158298e](https://github.com/gyorgysh/myhq/commit/158298e))
- Memory stats overview grid. ([4fa23a2](https://github.com/gyorgysh/myhq/commit/4fa23a2))

### Fixed
- `crew_ask_president` now works inside Lead bots. ([64663a8](https://github.com/gyorgysh/myhq/commit/64663a8))
- Hot memory entries can decay; steered toward terse memories. ([7f4cff0](https://github.com/gyorgysh/myhq/commit/7f4cff0))

## [0.3.0] - 2026-06-26

### Added
- **Three-tab Logs view**: human-readable activity feed, raw logs, analytics. ([5d00416](https://github.com/gyorgysh/myhq/commit/5d00416))
- **Remote Access**: tunnel relay (ngrok/cloudflared) with HTTP Basic Auth gate and auto-start. ([5ab31d1](https://github.com/gyorgysh/myhq/commit/5ab31d1))
- **Auto-heal weak PANEL_TOKEN**: generates a secure token and DMs it via Telegram. ([c611f51](https://github.com/gyorgysh/myhq/commit/c611f51))
- Lifecycle events surfaced in the activity feed. ([de644c1](https://github.com/gyorgysh/myhq/commit/de644c1))
- Blurred locked-terminal placeholder when terminal is disabled. ([41852da](https://github.com/gyorgysh/myhq/commit/41852da))

### Security
- Full SEC-1 through SEC-8 hardening pass (see the 0.4.0 section above for details).

## [0.2.0] - 2026-06-26

### Added
- **Management panel**: embedded Fastify SPA with health dashboard, workers, tasks, memory, vault, logs, usage, settings, and more.
- **Crew / Lead bots**: initial multi-agent infrastructure.
- **Scheduling**: persisted timed prompts run as autonomous turns.
- **Voice transcription**: OpenAI-compatible endpoint or local Vosk backend.
- **Projects**: saved cwds with `/projects` inline menu.
- **Approval presets**: persistent always-allow per tool and per bash command.
- **Image vision**: inline photo handling and `send_file` back to Telegram.
- **Git review flow**: `/diff` with Commit/Discard buttons, `/commit`.
- **Usage tracking**: per-session lifetime and per-day token buckets.
- **Session persistence** across restarts (resume token, cwd, autonomy, usage).
- Install wizard (`myhq-install.sh`), update, and uninstall scripts.

## [0.1.0] - 2026-06-24

Initial release. A Telegram bot driving the Claude Agent SDK on the host machine, with streamed replies, inline tool-approval buttons, and an allowed-user allow-list.
