# Work Playbook

Operational conventions for this machine. The bot loads this file on **every**
turn, so edits take effect immediately — keep it short, accurate, and specific.
Everything below is an editable example; replace it with what's true for your box.

## Ground rules
- This runs unattended over Telegram. Prefer non-interactive commands (no prompts
  that wait for stdin); pass flags like `-y` where appropriate.
- Confirm before anything destructive or irreversible (deleting data, dropping a
  database, `rm -rf`, force-pushing). State exactly what will happen first.
- When a request is ambiguous, ask one short clarifying question rather than guess.

## Services
When asked to start/stop/restart a service, use these exact commands:

- **Apache (httpd)**: `sudo apachectl restart` — config test first with `sudo apachectl configtest`.
  - Logs: `/usr/local/var/log/httpd/` (or `/var/log/apache2/`).
- **nginx**: `sudo nginx -t && sudo nginx -s reload`.
- **PostgreSQL** (Homebrew): `brew services restart postgresql`.
- **Docker containers**: `docker restart <name>`; check with `docker ps`.

## Scheduled jobs / crontab
- View current crontab: `crontab -l`.
- Edit safely (don't open the interactive editor): write the full crontab to a
  file and install it, e.g. `crontab /path/to/new.crontab`. Always show the diff
  vs. `crontab -l` before installing, and keep a backup of the previous one.
- Job format reminder: `min hour day-of-month month day-of-week command`.
- For macOS-native scheduling prefer `launchd` plists in `~/Library/LaunchAgents/`
  when a job must survive reboots or run in a user session.

## Deploys / common tasks
<!-- Add your own recurring tasks here so the bot does them the same way each time. -->
- Example — "deploy the site": `cd /path/to/project && git pull && npm ci && npm run build && sudo apachectl restart`.

## Managing this agent (self-service)
This bot runs as an OS service: **systemd** (`telegram-agent`) on Linux, or a
**launchd** LaunchAgent (`sh.gyorgy.telegram-agent`) on macOS. Prefer the
cross-platform wrapper, run from the project directory:

- **Restart**: `./scripts/agentctl.sh restart`
- **Stop / Start**: `./scripts/agentctl.sh stop` / `./scripts/agentctl.sh start`
- **Status**: `./scripts/agentctl.sh status`
- **Logs**: `./scripts/agentctl.sh logs`

Native equivalents if you need them:
- Linux: `sudo systemctl restart telegram-agent` (logs: `journalctl -u telegram-agent`)
- macOS: `launchctl kickstart -k gui/$(id -u)/sh.gyorgy.telegram-agent`

Notes:
- On Linux the systemctl management commands are passwordless (a scoped sudoers
  rule installed by the installer). On macOS it is a per-user agent, so no sudo.
- **Restarting kills the current process** — the in-flight reply stops and the
  Telegram connection re-establishes automatically. That is expected: run the
  restart command last, and do not try to report back afterward in the same turn.

### Updating to the latest version
When asked to "update", "update to the latest version", "pull the latest", or
similar, run the project's update script from the project directory:

```
./scripts/update.sh
```

**Always use this script — never hand-roll `git pull` + restart.** The script is
the only path that also reinstalls dependencies and rebuilds; pulling by hand
skips `npm install` / `npm run build`, so new code or dependency changes won't
actually take effect until someone runs them manually.

It does everything in one shot: fetches `origin`, **hard-resets** the checkout to
the remote ref (local edits to *tracked* files are discarded — untracked files
and the gitignored `data/` dir are left alone), runs `npm install`, rebuilds the
panel UI + bot (`npm run build`, which also runs `npm install` inside `panel/`),
and restarts the service **only if** one is installed.

- Pin a specific branch/tag/commit by passing it: `./scripts/update.sh <git-ref>`
  (defaults to the current branch).
- Output reports whether it was already up to date or the commit range applied.
- Because the script restarts the service itself at the end, the **same caveat as
  a manual restart applies**: the current process is killed, so run it as the last
  action and don't try to report back afterward in the same turn. If no service is
  installed, the script just builds and you must restart the manual run yourself.
- Your customizations are preserved: panel-managed config (workers, providers,
  schedules, main-agent model, sessions) lives in the gitignored `data/` dir and
  is untouched, and this `work.md` is backed up and restored across the reset.
  Other local edits to *tracked* files are discarded — say so first if you have any.

## Conventions
- Where new files go: for one-off creations (a script you were asked to write, a
  generated file, a download, scratch work), write them into the current working
  directory using **relative paths** (e.g. `./png2webp.sh`), not an absolute path
  into the bot's own source tree. The working directory defaults to a gitignored
  `data/` folder, so ad-hoc creations stay out of the project. When the request is
  clearly about an existing project, work inside that project instead.
- Timezone / schedules: assume the machine's local time unless a job says UTC.
