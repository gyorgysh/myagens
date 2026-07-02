# Work Playbook

Operational conventions for this machine. The bot loads this file on **every**
turn, so keep it short, accurate, and specific.
Everything below is an editable example; replace it with what's true for your machine.

## Ground rules
- Prefer non-interactive commands (pass `-y` where appropriate).
- Confirm before anything destructive (deleting data, `rm -rf`, force-pushing).
- When a request is ambiguous, ask one short clarifying question rather than guess.

## Task auto-creation (remind me / todo / follow up)
When the president implies a future action or reminder ("remind me", "follow up on",
"note this", "todo", "track this"), create a Kanban card immediately with `task_create`
and confirm the title + column in your reply.

## Inbox / suggestions
- Use `crew_suggest` for non-urgent ideas or proposals needing president review.
- Use `crew_report` when work is done and you are recording the result.
- Use `crew_ask_president` only when genuinely blocked mid-task (one tight question).

## Delegation (for Leads)
- Delegate only work clearly within the target Lead's portfolio.
- Pass cwd, relevant file paths, and acceptance criteria so the target can act without follow-up.
- Synthesize the result into your own reply; log it with `crew_report`.

## Services
- **Apache**: `sudo apachectl configtest && sudo apachectl restart`
- **nginx**: `sudo nginx -t && sudo nginx -s reload`
- **PostgreSQL** (Homebrew): `brew services restart postgresql`
- **Docker**: `docker restart <name>`

## Crontab
- View: `crontab -l`. Edit by writing a file then `crontab /path/to/file` (no interactive editor).
- Format: `min hour day month weekday command`. Prefer `launchd` on macOS for user-session jobs.

## Deploys / common tasks
<!-- Add your own recurring tasks here so the bot does them the same way each time. -->
- Example: `cd /path/to/project && git pull && npm ci && npm run build && sudo apachectl restart`

## Managing this agent
Service wrapper (run from project dir):
- `./scripts/agentctl.sh restart|stop|start|status|logs`

Native: `sudo systemctl restart myagens` (Linux) or `launchctl kickstart -k gui/$(id -u)/sh.gyorgy.myagens` (macOS).

Restarting kills the current process; run it last and do not report back in the same turn.

## Updating
Always use the update script, never hand-roll `git pull` + restart:
```
./scripts/update.sh
```
Optionally pin a ref: `./scripts/update.sh <git-ref>`. The script pulls, reinstalls deps, rebuilds, and restarts the service. Local edits to tracked files are discarded; `data/` and `work.md` are preserved.

## Fleet API (Panel)
Full REST catalogue with `curl` examples is in `PANEL_API.md`. Auth: `Authorization: Bearer $PANEL_TOKEN`.

## Temporary swap (Linux only)
```bash
./scripts/tmpswap.sh on 4   # add 4 GB swap
./scripts/tmpswap.sh off    # remove when done
```

## Telegram bot tips
- **Set bot profile photo**: use `setMyProfilePhoto` with an `InputProfilePhoto` JSON object:
  ```bash
  curl -s -F 'photo={"type":"static","photo":"attach://av"}' -F "av=@photo.png" \
    "https://api.telegram.org/bot${TOKEN}/setMyProfilePhoto"
  ```

## Conventions
- Write one-off files into the current working directory (relative paths), not into the bot's source tree.
- Assume machine local time for schedules unless a job says UTC.
