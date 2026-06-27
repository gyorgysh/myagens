# Work Playbook

Operational conventions for this machine. The bot loads this file on **every**
turn, so edits take effect immediately, so keep it short, accurate, and specific.
Everything below is an editable example; replace it with what's true for your machine.

## Ground rules
- This runs unattended over Telegram. Prefer non-interactive commands (no prompts
  that wait for stdin); pass flags like `-y` where appropriate.
- Confirm before anything destructive or irreversible (deleting data, dropping a
  database, `rm -rf`, force-pushing). State exactly what will happen first.
- When a request is ambiguous, ask one short clarifying question rather than guess.

## Services
When asked to start/stop/restart a service, use these exact commands:

- **Apache (httpd)**: `sudo apachectl restart`. Config test first with `sudo apachectl configtest`.
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
- Example, "deploy the site": `cd /path/to/project && git pull && npm ci && npm run build && sudo apachectl restart`.

## Managing this agent (self-service)
This bot runs as an OS service: **systemd** (`myhq`) on Linux, or a
**launchd** LaunchAgent (`sh.gyorgy.myhq`) on macOS. Prefer the
cross-platform wrapper, run from the project directory:

- **Restart**: `./scripts/agentctl.sh restart`
- **Stop / Start**: `./scripts/agentctl.sh stop` / `./scripts/agentctl.sh start`
- **Status**: `./scripts/agentctl.sh status`
- **Logs**: `./scripts/agentctl.sh logs`

Native equivalents if you need them:
- Linux: `sudo systemctl restart myhq` (logs: `journalctl -u myhq`)
- macOS: `launchctl kickstart -k gui/$(id -u)/sh.gyorgy.myhq`

Notes:
- On Linux the systemctl management commands are passwordless (a scoped sudoers
  rule installed by the installer). On macOS it is a per-user agent, so no sudo.
- **Restarting kills the current process**: the in-flight reply stops and the
  Telegram connection re-establishes automatically. That is expected: run the
  restart command last, and do not try to report back afterward in the same turn.

### Updating to the latest version
When asked to "update", "update to the latest version", "pull the latest", or
similar, run the project's update script from the project directory:

```
./scripts/update.sh
```

**Always use this script, never hand-roll `git pull` + restart.** The script is
the only path that also reinstalls dependencies and rebuilds; pulling by hand
skips `npm install` / `npm run build`, so new code or dependency changes won't
actually take effect until someone runs them manually.

It does everything in one shot: fetches `origin`, **hard-resets** the checkout to
the remote ref (local edits to *tracked* files are discarded; untracked files
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
  Other local edits to *tracked* files are discarded; say so first if you have any.

## Fleet API (Panel)

When the panel is enabled, the full fleet can be managed programmatically via a
local REST API. Use `curl` with the Bearer token from `.env`:

```bash
source .env
BASE="http://127.0.0.1:${PANEL_PORT:-8787}"
AUTH="Authorization: Bearer $PANEL_TOKEN"
```

All write endpoints accept and return JSON. Replace `$BASE` and `$AUTH` with the
above in every example. Endpoints return `{ error: "..." }` with a 4xx status on
failure.

### Workers (Leads, Assistants, specialists)

```bash
# List all workers
curl -H "$AUTH" $BASE/api/workers

# Create a worker (Lead with its own Telegram bot)
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/workers \
  -d '{
    "name": "DevOps Lead",
    "cwd": "/home/user/project",
    "prompt": "You are the DevOps Lead. Handle infra, deployments, and monitoring.",
    "role": "lead",
    "portfolio": "Infrastructure and deployments",
    "model": "claude-opus-4-8",
    "persona": "Concise and direct.",
    "autonomy": "standard",
    "language": "en",
    "enabled": true,
    "when": "09:00"
  }'

# Fields reference:
#   name          display name
#   cwd           working directory for this agent's runs
#   prompt        the agent's standing task/instructions (its "job description")
#   role          "lead" | "assistant" (omit for specialist)
#   portfolio     domain description shown to Atlas in the crew roster
#   parentId      id of the Lead this Assistant reports to
#   model         model id override (e.g. "claude-sonnet-4-6")
#   providerId    id of a saved provider preset (for local models)
#   systemPrompt  extra domain knowledge appended to the system prompt
#   skillId       id of a saved skill whose body augments the system prompt
#   telegramToken vault:<id> reference for this Lead's own Telegram bot token
#   persona       character/tone instructions (separate from domain knowledge)
#   autonomy      "supervised" | "standard" | "full"
#   language      BCP 47 code, e.g. "en", "hu", "es"
#   when          schedule: "30m", "2h", "1d", or "HH:MM" for daily
#   enabled       true/false

# Update a worker
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/workers/<id> \
  -d '{ "enabled": true, "when": "08:00" }'

# Trigger a manual run now
curl -X POST -H "$AUTH" $BASE/api/workers/<id>/run

# Stop a running worker
curl -X POST -H "$AUTH" $BASE/api/workers/<id>/stop

# Delete a worker
curl -X DELETE -H "$AUTH" $BASE/api/workers/<id>

# Run history for a worker
curl -H "$AUTH" $BASE/api/workers/<id>/runs
```

### Tasks (Kanban board)

```bash
# List all tasks, columns, and WIP limits
curl -H "$AUTH" $BASE/api/tasks

# Create a task
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tasks \
  -d '{
    "title": "Check disk usage on prod",
    "notes": "Alert if over 80%",
    "column": "backlog",
    "priority": "high"
  }'
# priority: "low" | "normal" | "high"
# column: use column ids from GET /api/tasks (default columns: backlog, doing, done)
# parentId: id of a parent task for subtasks

# Update a task (move column, change priority, edit notes)
curl -X PATCH -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tasks/<id> \
  -d '{ "column": "doing", "priority": "high" }'

# Delegate a card to an autonomous agent run
curl -X POST -H "$AUTH" $BASE/api/tasks/<id>/delegate

# Stop a delegated run
curl -X POST -H "$AUTH" $BASE/api/tasks/<id>/stop

# Retry a failed delegated run (resets to backlog, clears delegate state, re-delegates)
curl -X POST -H "$AUTH" $BASE/api/tasks/<id>/retry

# Get / update delegation run settings (timeoutMs, maxConcurrent)
curl -H "$AUTH" $BASE/api/tasks/run-config
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tasks/run-config \
  -d '{ "timeoutMs": 600000, "maxConcurrent": 3 }'

# Delete a task
curl -X DELETE -H "$AUTH" $BASE/api/tasks/<id>
```

### Schedules

```bash
# List scheduled prompts
curl -H "$AUTH" $BASE/api/schedules

# Add a schedule
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/schedules \
  -d '{ "prompt": "Check disk usage and alert if over 80%", "when": "09:00", "cwd": "/home/user" }'
# when: "30m", "2h", "1d", or "HH:MM" (daily, server local time)

# Update a schedule (prompt, when, cwd)
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/schedules/<id> \
  -d '{ "prompt": "New prompt", "when": "10:00", "cwd": "/home/user" }'

# Pause/resume a schedule (paused ones stay in the list but never fire on tick)
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/schedules/<id>/enabled \
  -d '{ "enabled": false }'

# Remove a schedule
curl -X DELETE -H "$AUTH" $BASE/api/schedules/<id>
```

### Memory

```bash
# List / search memories
curl -H "$AUTH" "$BASE/api/memories?q=deployment"

# Create a memory
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/memories \
  -d '{ "text": "Prod DB host is db.internal:5432", "tags": ["prod", "db"], "tier": "hot" }'
# tier: "hot" (every turn), "warm" (keyword-recalled), "cold" (panel-only)

# Promote/demote tier
curl -X PATCH -H "$AUTH" -H "Content-Type: application/json" $BASE/api/memories/<id>/tier \
  -d '{ "tier": "warm" }'

# Update text/tags
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/memories/<id> \
  -d '{ "text": "Updated fact", "tags": ["prod"] }'

# Delete
curl -X DELETE -H "$AUTH" $BASE/api/memories/<id>
```

### Skills

```bash
# List skills (pass ?archived=true to include archived)
curl -H "$AUTH" $BASE/api/skills

# Create a skill
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/skills \
  -d '{ "name": "deploy-site", "prompt": "1. git pull\n2. npm ci\n3. npm run build\n4. restart apache", "tags": ["deploy"] }'

# Update a skill
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/skills/<id> \
  -d '{ "prompt": "...", "archived": false }'

# Delete
curl -X DELETE -H "$AUTH" $BASE/api/skills/<id>
```

### Main agent (Atlas)

```bash
# View current model, provider, persona, autonomy, defaultLanguage
curl -H "$AUTH" $BASE/api/agent

# Update (all fields optional)
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/agent \
  -d '{ "model": "claude-opus-4-8", "persona": "Concise and direct.", "autonomy": "standard", "defaultLanguage": "en" }'

# Toggle semantic memory embeddings
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/agent/embeddings \
  -d '{ "enabled": true, "provider": "ollama", "baseUrl": "http://localhost:11434", "model": "nomic-embed-text" }'

# Clear all session resume tokens (next message starts fresh)
curl -X POST -H "$AUTH" $BASE/api/agent/reset

# Restart the service (only works when a service is installed)
curl -X POST -H "$AUTH" $BASE/api/agent/restart
```

### Vault (secrets)

```bash
# List secrets (values are masked, only hint shown)
curl -H "$AUTH" $BASE/api/vault

# Store a secret
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/vault \
  -d '{ "name": "DevOps Lead Telegram token", "value": "7123456789:AAH...", "hint": "lead-bot" }'
# Returns { id: "vault:<uuid>" }; use that id anywhere a token is referenced

# Reveal a secret value
curl -H "$AUTH" $BASE/api/vault/<id>/reveal

# Delete
curl -X DELETE -H "$AUTH" $BASE/api/vault/<id>

# Rotate the master key (re-encrypts every secret under a fresh key, stamps keyRotatedAt)
curl -X POST -H "$AUTH" $BASE/api/vault/rotate

# Encrypted, passphrase-protected backup of ALL secrets (portable across machines)
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/vault/export \
  -d '{ "passphrase": "at-least-8-chars" }'
# Returns { blob: "vaultbak1.<salt>.<iv>.<tag>.<ct>" }

# Restore from a backup blob (additive: existing secrets untouched)
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/vault/import-backup \
  -d '{ "blob": "vaultbak1.…", "passphrase": "at-least-8-chars" }'
```

### Providers (local/proxy model endpoints)

```bash
# List saved providers
curl -H "$AUTH" $BASE/api/providers

# Create a provider
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/providers \
  -d '{ "name": "LM Studio", "baseUrl": "http://localhost:1234/v1", "authToken": "lm-studio" }'

# List available models for a saved provider
curl -H "$AUTH" $BASE/api/providers/<id>/models
```

### Heartbeat (proactive monitoring)

```bash
# View current config and recent alerts
curl -H "$AUTH" $BASE/api/heartbeat

# Update config
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/heartbeat \
  -d '{ "mode": "alert", "intervalMs": 300000, "cpu": 85, "mem": 90, "disk": 85, "mutedSignals": ["swap"] }'
# mode: "off" | "alert" | "active"
# mutedSignals: array of signal types to suppress without disabling the heartbeat
#   valid values: "cpu" | "mem" | "swap" | "disk" | "stale" | "spend"

# Trigger a manual heartbeat check now
curl -X POST -H "$AUTH" $BASE/api/heartbeat/run
```

### Remote access (tunnel relay)

Exposes the panel to the internet via ngrok/cloudflared so a phone can reach it,
still behind the panel login. Off unless `PANEL_TUNNEL_ENABLED=true`; the relay
binary (`ngrok` or `cloudflared`) must be installed on the host.

```bash
# View tunnel config + live state (provider, hasToken, url, state, autoStart,
# basicAuth, basicAuthUser, hasPassword)
curl -H "$AUTH" $BASE/api/tunnel

# Configure provider/token/domain/autoStart/basicAuth (blank authToken keeps the saved one)
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tunnel \
  -d '{ "provider": "ngrok", "authToken": "vault:<id>", "domain": "", "autoStart": true, "basicAuth": true }'
# provider: "ngrok" (needs a token) | "cloudflare" (free quick tunnel, no token)
# autoStart: relaunch the relay after a reboot/update (default true)
# basicAuth: HTTP login (user "myhq" + auto-generated password) in front of the
#   public URL (default true); a password is generated + vaulted on first enable.

# Reveal the current Basic Auth login (user + plaintext password)
curl -H "$AUTH" $BASE/api/tunnel/password

# Rotate to a new random password (no body) or set your own (>=6 chars)
curl -X POST -H "$AUTH" $BASE/api/tunnel/password
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tunnel/password \
  -d '{ "password": "my-own-secret" }'

# Start / stop the relay (start returns once launched; the public URL arrives async)
curl -X POST -H "$AUTH" $BASE/api/tunnel/start
curl -X POST -H "$AUTH" $BASE/api/tunnel/stop
# PUT/start/stop/password all return 403 when PANEL_TUNNEL_ENABLED is false.
```

### System / status

```bash
# Live system health (CPU, memory, disk, swap, I/O)
curl -H "$AUTH" $BASE/api/health

# Claude service status + provider/local backend probes
curl -H "$AUTH" $BASE/api/status

# Active sessions
curl -H "$AUTH" $BASE/api/sessions

# Usage summary (today + lifetime per chat)
curl -H "$AUTH" $BASE/api/usage

# Recent audit log
curl -H "$AUTH" $BASE/api/audit
```

### Council votes

```bash
# Council vote history (each entry has the proposal, per-Lead votes, and tally)
curl -H "$AUTH" $BASE/api/council

# Cross-agent delegation log
curl -H "$AUTH" $BASE/api/delegations

# Worker run history across the whole fleet
curl -H "$AUTH" $BASE/api/runs

# Full per-run transcript (NDJSON events: text, tool, result, start, end)
curl -H "$AUTH" $BASE/api/runs/<runId>/log
```

A council vote can be triggered from Telegram with `/council <proposal>` or from the panel Crew tab:

```bash
# Trigger a council vote (returns the full tally)
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/council \
  -d '{ "proposal": "Should we migrate to PostgreSQL?" }'

# Delete a council session (two-step confirm in the panel Crew tab)
curl -X DELETE -H "$AUTH" $BASE/api/council/<id>
```

### Suggestion inbox

Agents file non-urgent ideas with `crew_suggest`; the president triages from `/inbox` or the panel Crew tab.

```bash
# List suggestions (status: pending | accepted | delegated | dismissed)
curl -H "$AUTH" "$BASE/api/suggestions?status=pending"

# Park (accept → create a backlog task card)
curl -X POST -H "$AUTH" $BASE/api/suggestions/<id>/accept

# Delegate (create card + route to a Lead for immediate execution)
curl -X POST -H "$AUTH" $BASE/api/suggestions/<id>/delegate

# Dismiss (archive)
curl -X POST -H "$AUTH" $BASE/api/suggestions/<id>/dismiss
```

### Local model backends and embeddings

```bash
# Probe a locally running backend (reachability, models, embed-model presence)
curl -H "$AUTH" $BASE/api/integrations/ollama
curl -H "$AUTH" $BASE/api/integrations/lmstudio

# One-click connect: register the backend as a provider and turn embeddings on
curl -X POST -H "$AUTH" $BASE/api/integrations/ollama/connect
curl -X POST -H "$AUTH" $BASE/api/integrations/lmstudio/connect

# When both backends run, pick which one auto-detect prefers on startup
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/agent/embeddings/preferred \
  -d '{ "preferredBackend": "lmstudio" }'
# preferredBackend: "ollama" | "lmstudio" | null (null = auto, Ollama first)

# List a provider's models without saving it first
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/providers/models \
  -d '{ "baseUrl": "http://localhost:1234/v1", "authToken": "lm-studio" }'
```

### Plan and budget

```bash
# View plan, monthly cap, billing day, alert threshold
curl -H "$AUTH" $BASE/api/plan

# Update (plan: "pro" | "max" | "api")
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/plan \
  -d '{ "plan": "api", "monthlyCap": 100, "billingDay": 1, "alertThresholdPct": 80 }'

# Send a test cost report to Telegram now
curl -X POST -H "$AUTH" $BASE/api/plan/report-test

# Live OAuth usage probe (5h session + 7d weekly limits); add /run to refresh
curl -H "$AUTH" $BASE/api/usage-probe
curl -X POST -H "$AUTH" $BASE/api/usage-probe/run
```

### Playbook and maintenance

```bash
# Read or write this operator playbook (work.md) and the read-only personality
curl -H "$AUTH" $BASE/api/prompt
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/prompt \
  -d '{ "work": "# Work Playbook\n..." }'

# Maintenance status, and trigger a compaction/pruning pass now
curl -H "$AUTH" $BASE/api/maintenance
curl -X POST -H "$AUTH" $BASE/api/maintenance/run

# Dry-run preview: see what would be deleted/demoted without running compaction
curl -X POST -H "$AUTH" $BASE/api/maintenance/preview
```

### Task columns and WIP limits

```bash
# List columns (also returned inline by GET /api/tasks)
curl -H "$AUTH" $BASE/api/tasks/columns

# Add a column
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tasks/columns \
  -d '{ "title": "Review" }'

# Rename a column
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tasks/columns/<id> \
  -d '{ "title": "In Review" }'

# Reorder columns or cards (send the full id order)
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tasks/columns/reorder \
  -d '{ "order": ["backlog", "doing", "review", "done"] }'
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tasks/reorder \
  -d '{ "column": "doing", "order": ["task-id-1", "task-id-2"] }'

# Set per-column WIP limits (0 = unlimited)
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tasks/wip \
  -d '{ "doing": 3 }'

# Delete a column (its cards move back to the first column)
curl -X DELETE -H "$AUTH" $BASE/api/tasks/columns/<id>
```

### Other endpoints

A few more endpoints exist, mostly mirroring panel views:

- `GET /api/languages`: the agent language catalogue.
- `POST /api/vault/import`: scan provider tokens into the vault and rewrite them to references.
- `POST /api/workers/wizard`: draft a worker config from a plain-text description.
- `POST /api/schedules/<id>/run`: fire a schedule immediately.
- `GET /api/claude-usage`: historical activity from `~/.claude/stats-cache.json`.
- `GET /api/claude-files`, `GET|PUT /api/claude-files/content`: browse and edit on-disk `.claude/*` and `CLAUDE.md` files under known working dirs.
- `GET /api/logs`, `GET /api/logs/dates`: live ring buffer or a dated NDJSON log file (`?date=&q=&level=&limit=`).
- `GET /api/logs/search`: cross-file event search over every retained file (`?q=&level=&hours=72&limit=`), merged into one oldest-first timeline.
- `GET /api/logs/summary`: usage insights (`?hours=72`) — most-used tools and shell commands tallied from persisted "Tool use" entries.
- `GET /api/update`, `POST /api/update/check|run|restore`: in-panel update check, apply, and rollback.
- `GET /api/connectors`, `PUT /api/connectors/<id>`: the external-connector catalogue (placeholders for now).
- `GET /api/chat`, `POST /api/chat/send|stop|clear|approve`, `PUT /api/chat/settings`: the panel's own Claude chat session.
- `GET /api/terminal`, `POST /api/terminal/spawn|resize`: the panel terminal session.

## Temporary swap (Linux only)
When a task requires more memory than is available (large builds, model inference,
bulk data processing), add temporary swap from the project directory:

```bash
./scripts/tmpswap.sh on 4          # add 4GB (default); first arg is size in GB
# ... do the heavy work ...
./scripts/tmpswap.sh off           # remove when done (reclaims disk space)
```

The script checks that the requested size does not exceed 80% of free disk space
before creating the file. The swap lives at `/var/tmp/myhq-swap` by default and
is NOT added to `/etc/fstab`; it disappears on reboot even if you forget to run
`off`. Always remove it after the task to reclaim the disk space.

On macOS the script exits cleanly with a message: macOS manages swap automatically.

## Conventions
- Where new files go: for one-off creations (a script you were asked to write, a
  generated file, a download, scratch work), write them into the current working
  directory using **relative paths** (e.g. `./png2webp.sh`), not an absolute path
  into the bot's own source tree. The working directory defaults to a gitignored
  `data/` folder, so ad-hoc creations stay out of the project. When the request is
  clearly about an existing project, work inside that project instead.
- Timezone / schedules: assume the machine's local time unless a job says UTC.
