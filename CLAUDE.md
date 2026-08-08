# CLAUDE.md

Guidance for Claude Code working in this repository. Keep it short: it is injected into every turn. Add a line here only for something that would waste time to rediscover or is easy to get wrong. Anything you could learn by reading the code does not belong here.

## What this is

A multi-agent platform that runs real coding agents on the host machine, sharing one memory, skills library, task board and connector set. **Agents can read/write/run anything on the host**, so each front end's allow-list is the entire access control.

Three interchangeable front ends, **none individually required**: the panel (`PANEL_ENABLED`), Telegram (`TELEGRAM_BOT_TOKEN` + `ALLOWED_USER_IDS`), Slack (the `SLACK_*` trio). Config requires *at least one* and rejects a half-configured surface.

## Commands

```bash
npm run dev        # tsx watch (app) + vite build --watch (panel)
npm run build      # panel build, then tsc -> dist/
npm run typecheck  # tsc --noEmit
```

No tests, no linter. `typecheck` (strict, `noUnusedLocals`/`noUnusedParameters`) is the only automated check — run it after changes. Node >= 20.

## Conventions

ESM throughout, so **relative imports need the `.js` extension** even though sources are `.ts`.

Layering: `src/core/` is surface-free and shared by every agent and front end. `src/telegram/`, `src/slack/`, `src/panel/` are surface-specific. Telegram was the original and only surface, so older code still assumes it — when you touch that code, move the surface-free part down into `core/` rather than adding another `bot.telegram` reference.

Type guards over the Agent SDK's loose message union live in `src/claude/events.ts`. Add to that file instead of casting inline.

Keep `PANEL_API.md` and the README in sync when adding or renaming routes. **Do not put the route catalogue in `work.md`** — that file is injected into every agent's system prompt.

## Gotchas

**Config exits at module load.** `config.ts` calls `process.exit(1)` on invalid config while evaluating, so `index.ts` must keep both branches as *dynamic* imports, and `src/setup/` must not import anything that reaches `config.ts` (`logger.ts` is dependency-free and safe).

**Surface independence.** Background subsystems (schedules, heartbeat, task outcomes, update notices, inbox) are wired once in `core/wiring.ts` from `app.ts`, never inside `buildBot()` — putting them there is what used to make Telegram mandatory. They report through `core/notify.ts`, which fans out to whichever surfaces are live and logs when none are. A notice carries plain `text` for every surface plus optional `telegram.i18n` (a `TranslationKey` rendered per recipient, so localization does not regress) and inline keyboards only Telegram has.

**One President session, one runner.** `mainChatId()` falls back to `PANEL_CHAT_ID` (0, never a real Telegram chat id) so the President always has a `Session`. Exactly one runner attaches to `chatBridge`: `bot.ts`'s when Telegram is configured, `core/panelChatRunner.ts`'s otherwise. `telegramBotToken()` throws rather than connecting with `""`, so a missed guard fails loudly.

**Telegraf 4.16.3 has no wrappers for Bot API 9.3/10.1.** Rich Messages and drafts go through raw `tg.callApi()`.

**Slack's typed fallbacks are load-bearing, not a convenience.** Block Kit clicks only arrive if the Slack app has *Interactivity* enabled. A prompt that can only be clicked wedges the turn: the model parks in `canUseTool`, the session stays `busy`, later messages bounce off the busy guard. So every prompt also accepts a typed answer, and `!stop` must cancel the pending question/approval as well as aborting — aborting the SDK run alone never settles a `canUseTool` promise. Commands use `!` because Slack refuses to deliver an undeclared `/command`.

**Private Telegram chat ids are identical across bot tokens.** Anything keyed by chat id across Atlas and Lead bots needs the agent id too (see `core/crewAsk.ts`).

**`assertReadOnlySql` only checks the leading keyword.** A data-modifying CTE or `SELECT … INTO` slips past it, so Postgres read tools additionally run inside `BEGIN TRANSACTION READ ONLY`.

**Panel security is load-bearing in three non-obvious places.** `trustProxy` trusts `X-Forwarded-For` only from a loopback peer (otherwise the per-IP lockout would see 127.0.0.1 for all tunneled traffic and exempt it). CSP `connect-src` is `'self'`, not the bare `ws:`/`wss:` schemes, which match any host and would let injected script exfiltrate the panel token. The global `bodyLimit` is 1MB because `POST /hook/:id` is public and unauthenticated until its HMAC check.

### CLI-wrapping backends

All CLI-wrapping backends wrap the vendor's own agentic CLI rather than reimplementing a tool loop, and share `core/cliBridge.ts` (loopback control plane) plus `scripts/cli-bridge/*` (plain JS, not compiled, so one path works in dev and prod).

**Codex** reads hooks from exactly one place, the *file* `$CODEX_HOME/hooks.json` (`-c hooks.PreToolUse=[…]` parses and is then silently a no-op). `--dangerously-bypass-hook-trust` is **mandatory**: codex gates hooks on a sha256 trust record and silently skips an untrusted one, so the tool runs ungated — a fail-open default. The flag and the private `CODEX_HOME` are produced together by `codexLaunch()`; if the home cannot be built, fall back to plain codex rather than an ungated one. Codex and Cursor **do not pass their environment to stdio MCP children** (hooks do inherit it), hence the 0600 `MYAGENS_BRIDGE_FILE` handoff instead of a token on the command line where `ps` shows it. Optional **usage-based billing**: `resolveCodexApiKey()` (vault setting, then `CODEX_API_KEY` env — not `OPENAI_API_KEY`) writes a private `auth.json` + `preferred_auth_method = "apikey"`; without a key the host ChatGPT login is symlinked and any host `OPENAI_API_KEY` is stripped from the child env so voice keys cannot steal billing.

**Cursor** reads `hooks.json`/`mcp.json` only from `<cwd>/.cursor/`, the primary workspace — a MyAgens-owned `--add-dir` is ignored, and making our dir primary breaks every relative path the model uses. So config is installed into the user's project, refcounted, and restored byte-for-byte in a `finally` plus at boot after a `kill -9`. `--force --approve-mcps` is passed at every autonomy level: below `--force` cursor's own decision provider silently auto-rejects every MCP call whatever our hook returns.

**Antigravity (`agy`)** has no flag for MCP servers, hooks or a system prompt; it discovers customizations from every workspace dir it is given. Our root goes **first** and the session cwd **last**, because agy writes new files into the last workspace dir. Its conversation id appears only in the CLI log, so each turn passes a temp `--log-file` and greps it afterwards.

**OpenCode** has no shell-command PreToolUse hook. Approvals go through an in-process plugin under `OPENCODE_CONFIG_DIR` (`scripts/cli-bridge/opencode-config/`, throw = deny). MCP is injected per turn via `OPENCODE_CONFIG_CONTENT` (never the user's `~/.config/opencode` or project `opencode.json`). Headless `run` auto-rejects `"ask"` permissions, so our inline config sets `"*": "allow"` and the plugin is the real gate. MCP tools show up as `myagens_mcp__<area>__<tool>`.

**Ollama** is the odd one out: plain chat against a local server, not a CLI wrapper. It hand-builds a small system prompt instead of importing the `claude_code` preset, and ignores `opts.env` so a configured cloud provider cannot silently redirect it off-host.

### Tmux mode

Opting an agent in hosts its conversation in one persistent `claude` TUI. Only *interactive* turns route there; delegated cards, council, reflect and maintenance stay on the SDK (they need transcripts, tool events and abortability, and must not interleave into the user's conversation).

The respawn ladder deliberately has **no `--continue` rung**: it resumes whatever session in the cwd is newest, and SDK one-shots write to the same project dir, so it once hijacked a reflection conversation into the user's TUI. For the same reason, transcript discovery binds only a `type:"user"` line whose text *equals* the pasted prompt — substring matching is forbidden.

Instances survive shutdown on purpose; boot re-adopts them.

## Where things live

```
src/
  index.ts     entry: setup mode or the real app
  app.ts       boot: optional Telegram bot, Slack, panel, background wiring
  config.ts    env parse (zod); exits at module load on invalid config
  core/        surface-free layer: backends, notify, wiring, memory, tasks,
               workers, vault, connectors, schedules, chat bridge, …
  claude/ grok/ codex/ agy/ cursor/ opencode/ ollama/   agent backends
  telegram/ slack/ panel/                     front ends
  mcp/         in-process MCP servers (memory, tasks, skills, crew, …)
  setup/       first-run browser wizard (must not import config.ts)
panel/         React + Vite + Tailwind SPA
scripts/       installers and service management (linux/, macos/, windows/)
```

New features follow the same shape: surface-free logic in `src/core/`, an MCP server per capability in `src/mcp/`, a panel view plus REST routes, JSON persistence in the data dir.
