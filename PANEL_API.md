# Panel REST API

Complete reference (with copy-paste `curl` examples) for the MyAgens Panel REST API.
The agent does not need this for normal operation — it manages the fleet through its
MCP tools — so it lives here rather than in `work.md` (which loads every turn). Read
this file when you need to script the panel or call an endpoint directly.


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
#   model         model id override (e.g. "claude-sonnet-5")
#   providerId    id of a saved provider preset (for local models)
#   backendId     agent backend id — "" / omit = Claude (default); "grok-cli" or "codex-cli"
#                 to run this one agent on a different backend (see GET /api/agent's
#                 `backends` list for what's registered). Advanced/hidden option: not
#                 surfaced as a panel dropdown, set it directly via this API.
#   systemPrompt  extra domain knowledge appended to the system prompt
#   skillId       id of a saved skill whose body augments the system prompt
#   telegramToken vault:<id> reference for this Lead's own Telegram bot token
#   streamMode    "rich" | "draft" | "edit" streaming backend override for this Lead's bot (falls back to STREAM_MODE)
#   persona       character/tone instructions (separate from domain knowledge)
#   autonomy      "supervised" | "standard" | "full"
#   language      BCP 47 code, e.g. "en", "hu", "es"
#   avatar        slug from the curated avatar set (e.g. "panda"); shown in panel and set as the Lead bot photo
#   when          schedule: "30m", "2h", "1d", or "HH:MM" for daily
#   enabled       true/false

# Update a worker
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/workers/<id> \
  -d '{ "enabled": true, "when": "08:00" }'

# Trigger a manual run now.
# Optional { "prompt": "..." } overrides the saved prompt for this one run only (does not mutate the worker).
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/workers/<id>/run \
  -d '{ "prompt": "Audit the staging deploy and report back." }'

# Stop a running worker
curl -X POST -H "$AUTH" $BASE/api/workers/<id>/stop

# Force a Lead's Telegram bot to restart right now (404 if not a live Lead:
# needs role "lead" + telegramToken + enabled). The watchdog already self-heals
# a dead poll within 60s on its own; this is for forcing it while diagnosing.
curl -X POST -H "$AUTH" $BASE/api/workers/<id>/restart-bot

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
    "priority": "high",
    "blockedBy": ["<prerequisite-task-id>"]
  }'
# priority: "low" | "normal" | "high"
# column: use column ids from GET /api/tasks (default columns: backlog, doing, done)
# parentId: id of a parent task for subtasks
# blockedBy: list of task ids that must reach Done before this card can be delegated

# Update a task (move column, change priority, edit notes)
curl -X PATCH -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tasks/<id> \
  -d '{ "column": "doing", "priority": "high" }'
# recurrence: make a card a recurring template (accepted on create and update).
# The template stays put and spawns a fresh backlog copy on each cadence (copies
# don't carry the recurrence). Shapes:
#   { "kind": "daily",   "hour": 9, "minute": 0 }
#   { "kind": "weekly",  "dayOfWeek": 1, "hour": 9, "minute": 0 }   # 0=Sun..6=Sat
#   { "kind": "monthly", "dayOfMonth": 1, "hour": 9, "minute": 0 }  # 1..31
# Pass recurrence: null on update to stop the card repeating.
curl -X PATCH -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tasks/<id> \
  -d '{ "recurrence": { "kind": "weekly", "dayOfWeek": 1, "hour": 9, "minute": 0 } }'

# Delegate a card to an autonomous agent run.
# Optional { "leadId": "<worker-id>" } body routes the run under a specific Lead; omit to auto-route.
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tasks/<id>/delegate \
  -d '{ "leadId": "<worker-id>" }'

# Stop a delegated run
curl -X POST -H "$AUTH" $BASE/api/tasks/<id>/stop

# Retry a failed delegated run (resets to backlog, clears delegate state, re-delegates)
curl -X POST -H "$AUTH" $BASE/api/tasks/<id>/retry

# Unstick a card jammed in queued/running/error (e.g. orphaned by a crash):
# aborts any live run, drops it from the queue, and clears its delegation
# WITHOUT re-running it. Cards left "queued"/"running" by a restart are also
# auto-reconciled to a retryable error on boot.
curl -X POST -H "$AUTH" $BASE/api/tasks/<id>/unstick

# Get / update delegation run settings (timeoutMs, maxConcurrent)
curl -H "$AUTH" $BASE/api/tasks/config
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tasks/config \
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

### Webhook triggers (inbound)

Register endpoints that external services hit to fire an autonomous run. The
management routes below are token-gated like the rest of `/api`. The actual
**firing endpoint is public** (`POST /hook/<id>`, no Bearer token) and instead
authenticates with an HMAC-SHA256 signature of the raw request body using the
trigger's own secret.

```bash
# List triggers (secrets are returned only as a 4-char hint) + the base URL
curl -H "$AUTH" $BASE/api/webhook-triggers

# Create a trigger (returns the new trigger; secret is generated server-side)
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/webhook-triggers \
  -d '{ "name": "GitHub push", "prompt": "Triage this push event", "leadId": "" }'

# Update a trigger (name, prompt, cwd, leadId, enabled)
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/webhook-triggers/<id> \
  -d '{ "enabled": false }'

# Rotate the signing secret (the caller must be reconfigured afterwards)
curl -X POST -H "$AUTH" $BASE/api/webhook-triggers/<id>/rotate

# Reveal the signing secret + a ready-to-paste signed sample for testing
curl -H "$AUTH" $BASE/api/webhook-triggers/<id>/secret

# Remove a trigger
curl -X DELETE -H "$AUTH" $BASE/api/webhook-triggers/<id>

# Fire a trigger (PUBLIC — no Bearer token; HMAC-SHA256 over the raw body).
# Compute the digest with the trigger's secret, send it in X-Signature-256
# (GitHub's X-Hub-Signature-256 and a bare hex digest are also accepted).
BODY='{"hello":"world"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "<secret>" | awk '{print $2}')
curl -X POST -H "Content-Type: application/json" -H "X-Signature-256: sha256=$SIG" \
  --data "$BODY" $BASE/hook/<id>
# 202 → a backlog card was filed and delegated to an autonomous run
```

### Webhook tools (outbound)

Register an arbitrary HTTP endpoint as a callable agent tool. Each definition
surfaces to the agent as `webhook_<slug>_<id>`; the agent fills the declared
params and the call is issued through the SSRF-guarded `safeFetch`. Static
`headers` values may be `vault:<id>` references (resolved at call time, so an
`Authorization` header can hold a secret without storing it in plaintext).

```bash
# List tool definitions (secret header values returned only as a hint)
curl -H "$AUTH" $BASE/api/webhook-tools

# Create a tool. `params` declare what the agent fills in and where each goes
# (query | header | body | path; a path param fills the {name} placeholder).
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/webhook-tools \
  -d '{
    "name": "Create Linear issue",
    "description": "Open a new Linear issue",
    "method": "POST",
    "url": "https://api.linear.app/graphql",
    "headers": { "Authorization": "vault:<secret-id>" },
    "params": [{ "name": "title", "in": "body", "required": true }]
  }'

# Update / delete a tool
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/webhook-tools/<id> \
  -d '{ "method": "GET" }'
curl -X DELETE -H "$AUTH" $BASE/api/webhook-tools/<id>
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

# Export the whole store (all tiers, embeddings stripped) as portable JSON
curl -H "$AUTH" $BASE/api/memories/export -o memories.json

# Import a dump; entries are deduped by normalized text, hot entries re-checked against the injection guard
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/memories/import \
  -d @memories.json
# -> { "imported": <n>, "skipped": <n> }
```

### Prompt templates

```bash
# List templates (each includes computed "variables": string[] extracted from {{name}} slots)
curl -H "$AUTH" $BASE/api/templates

# Create a template
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/templates \
  -d '{ "name": "Daily standup", "description": "Morning check-in", "body": "Summarize {{project}} status for {{date}}." }'

# Update a template (partial)
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/templates/<id> \
  -d '{ "body": "Summarize {{project}} status for {{date}}, flag blockers." }'

# Delete
curl -X DELETE -H "$AUTH" $BASE/api/templates/<id>
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

# Export a skill as a shareable JSON bundle (kind: "myagens.skill")
curl -H "$AUTH" $BASE/api/skills/<id>/export > skill-deploy-site.json

# Import a bundle (installs a new skill; name collisions get an " (imported)" suffix)
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/skills/import \
  -d @skill-deploy-site.json
```

### Main agent (Atlas)

```bash
# View current model, provider, persona, autonomy, defaultLanguage
curl -H "$AUTH" $BASE/api/agent

# Update (all fields optional)
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/agent \
  -d '{
    "model": "claude-opus-4-8",
    "persona": "Concise and direct.",
    "autonomy": "standard",
    "defaultLanguage": "en",
    "fallbackProviderId": "<provider-id>",
    "dryRun": false,
    "knownPaths": [
      { "label": "Projects", "path": "/Users/you/dev" },
      { "label": "Data", "path": "/Users/you/data" }
    ]
  }'
# fallbackProviderId: when set, autonomous turns switch to this provider/model
#   automatically when the usage probe shows the Anthropic plan is rate-limited.
#   Interactive turns are never redirected.
# dryRun: when true, mutating tools (Bash, Write, Edit, MultiEdit, NotebookEdit)
#   are intercepted and described ("would run X") without executing.
# knownPaths: named directory shortcuts ({ label, path } pairs) injected into
#   the system prompt each turn so agents know key folder locations. Also shown
#   as quick-pick chips in the Workers panel when setting a worker cwd.
# backendId: agent backend id — "" / omit = Claude (default). GET /api/agent's
#   response includes `backends` (every registered id + display name, e.g.
#   "grok-cli"/"codex-cli"). Advanced/hidden option: not a panel dropdown: set
#   via this API, or in Telegram via `/model <backendId>` or
#   `/model <backendId>:<model>` (e.g. `/model codex-cli:gpt-5.1-codex`).

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

### Backup & restore (whole-fleet state)

```bash
# Preview what a backup would contain (curated state files + vault secret count)
curl -H "$AUTH" $BASE/api/backup

# Download an encrypted archive of all durable state (binary .mag)
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/backup/export \
  -d '{ "passphrase": "at-least-8-chars" }' -o myagens-backup.mag

# Restore an archive (base64-encoded body). Overwrites state files; restart after.
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/backup/import \
  -d "{ \"archive\": \"$(base64 < myagens-backup.mag)\", \"passphrase\": \"…\", \"includeVault\": true }"
# Returns { filesRestored, vaultRestored, names, exportedAt }
```

### Providers (local/proxy model endpoints, and voice API keys)

Each provider has a `purpose`: `"chat"` (default — Anthropic-compatible chat/embedding
endpoints, e.g. LM Studio/Ollama/a proxy) or `"voice"` (an xAI or OpenAI-compatible key
consumed by Settings → Voice, see below). `GET /api/providers` defaults to `purpose=chat`
so existing chat/worker pickers never see voice entries mixed in.

```bash
# List saved chat providers (default)
curl -H "$AUTH" $BASE/api/providers

# List saved voice providers
curl -H "$AUTH" "$BASE/api/providers?purpose=voice"

# Create a provider
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/providers \
  -d '{ "name": "LM Studio", "baseUrl": "http://localhost:1234/v1", "authToken": "lm-studio" }'

# Create a voice provider (xAI)
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/providers \
  -d '{ "name": "xAI Voice", "baseUrl": "https://api.x.ai/v1", "authToken": "xai-…", "purpose": "voice" }'

# List available models for a saved provider
curl -H "$AUTH" $BASE/api/providers/<id>/models
```

### Voice (transcription + spoken replies)

Panel overrides for STT/TTS engine, model, and provider selection. Every field falls
back to the matching `.env` var (`TRANSCRIBE_PROVIDER`, `TTS_PROVIDER`, `OPENAI_API_KEY`,
`XAI_API_KEY`, `VOSK_MODEL_PATH`, `PIPER_PATH`/`PIPER_MODEL`, …) when unset, so an
unconfigured panel keeps working exactly as before.

```bash
# View effective + raw voice settings, plus the list of purpose="voice" providers
curl -H "$AUTH" $BASE/api/voice

# Point transcription at a linked provider, and enable voice-note replies
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/voice \
  -d '{ "sttEngine": "xai", "sttProviderId": "<voice-provider-id>", "sendVoiceNotes": true }'
```

`sendVoiceNotes` (default `true`) transcodes xAI/Piper's WAV output to Opus/OGG via
ffmpeg before sending, so replies arrive as a real Telegram voice note (`sendVoice`)
instead of a file attachment (`sendAudio`); it silently falls back to the file
attachment if ffmpeg is unavailable.

### Heartbeat (proactive monitoring)

```bash
# View current config and recent alerts
curl -H "$AUTH" $BASE/api/heartbeat

# Update config
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/heartbeat \
  -d '{
    "mode": "alert",
    "intervalMs": 300000,
    "cpu": 85, "mem": 90, "disk": 85,
    "mutedSignals": ["swap"],
    "quietStart": "23:00",
    "quietEnd": "07:00",
    "calendarEnabled": true,
    "calendarWindowMin": 720,
    "calendarLeadMin": 30
  }'
# mode: "off" | "alert" | "active"
# mutedSignals: suppress specific signals without disabling the whole heartbeat
#   valid values: "cpu" | "mem" | "swap" | "disk" | "stale" | "spend" | "calendar"
# quietStart / quietEnd: HH:MM (server local time). Signals in this window are
#   silently dropped. Wraps midnight correctly (e.g. 23:00–07:00).
# calendarEnabled: scan Google/Apple Calendar for upcoming events and brief
#   Atlas before each one. Requires at least one Calendar connector to be enabled.
# calendarWindowMin: how far ahead (minutes) to scan for events (default 720 = 12h)
# calendarLeadMin: how many minutes before an event to brief Atlas (default 30)

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
# basicAuth: HTTP login (user "myagens" + auto-generated password) in front of the
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

# Search / filter the audit log. All params optional:
#   q=<text>  actor=<source>  action=<verb>  resource=<prefix>
#   since=<epoch-ms>  limit=<n, default 500>
curl -H "$AUTH" "$BASE/api/audit/search?resource=vault&action=vault.rotate&limit=100"

# Facet lists for the filter dropdowns (distinct actors / resources / actions,
# ranked by frequency).
curl -H "$AUTH" $BASE/api/audit/facets

# Anomaly detector — live scan of the recent audit log (delete bursts, off-hours
# vault access, new privileged grants). Read-only preview; alerting is driven by
# the heartbeat loop (see /api/heartbeat, anomaly config).
curl -H "$AUTH" $BASE/api/audit/anomalies
```

### Council votes

```bash
# Council vote history (each entry has the proposal, per-Lead votes, and tally)
curl -H "$AUTH" $BASE/api/council

# Get / set the decision rule. Votes are relevance-weighted (each voter's weight
# is the proposal's relevance to their domain; 1.0 when embeddings are off).
# rule: "majority" (default) | "supermajority" (>=2/3 of decisive weight) | "unanimous"
curl -H "$AUTH" $BASE/api/council/rule
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/council/rule \
  -d '{ "rule": "supermajority" }'

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
# Read or write this operator playbook (work.md) and the read-only personality.
# The GET response also includes `defaultWork` (the shipped git template) and
# `matchesDefault` (false = the live playbook has been customized).
curl -H "$AUTH" $BASE/api/prompt
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/prompt \
  -d '{ "work": "# Work Playbook\n..." }'

# Restore the playbook to the shipped default (overwrites work.md)
curl -X POST -H "$AUTH" $BASE/api/prompt/restore

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
  -d '{ "name": "Review" }'

# Rename a column
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tasks/columns/<id> \
  -d '{ "name": "In Review" }'

# Reorder columns (send the full id order)
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tasks/columns/reorder \
  -d '{ "ids": ["backlog", "doing", "review", "done"] }'

# Reorder/move cards: each move is { id, column, order } — column is the
# destination column id, order is the card's new position within it.
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tasks/reorder \
  -d '{ "moves": [{ "id": "task-id-1", "column": "doing", "order": 0 }, { "id": "task-id-2", "column": "doing", "order": 1 }] }'

# Set a per-column WIP limit (column id + numeric limit; null/0 = unlimited)
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" $BASE/api/tasks/wip \
  -d '{ "column": "doing", "limit": 3 }'

# Delete a column (its cards move back to the first column)
curl -X DELETE -H "$AUTH" $BASE/api/tasks/columns/<id>

# Queue controls: pause holds dispatch of queued cards (in-flight runs keep
# going); resume fills free slots again; clear drops all waiting cards.
curl -H "$AUTH" $BASE/api/tasks/queue
curl -X POST -H "$AUTH" $BASE/api/tasks/queue/pause
curl -X POST -H "$AUTH" $BASE/api/tasks/queue/resume
curl -X POST -H "$AUTH" $BASE/api/tasks/queue/clear
```

### Web Push notifications

Browser push notifications delivered via the Web Push protocol. A VAPID keypair is auto-generated on first use and stored in the vault (private half) and `push.json` (public key + subscriptions).

```bash
# View push config: provisioned status, subscriber count, public VAPID key
curl -H "$AUTH" $BASE/api/push

# Register a browser push subscription (body is the PushSubscription JSON from
# the browser's PushManager.subscribe())
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/push/subscribe \
  -d '{ "subscription": { "endpoint": "...", "keys": { "p256dh": "...", "auth": "..." } }, "label": "my laptop" }'
# Returns { id: "<uuid>" } — store this to unsubscribe later

# Unregister a subscription
curl -X DELETE -H "$AUTH" $BASE/api/push/subscribe/<id>

# Send a test notification to all registered browsers
curl -X POST -H "$AUTH" $BASE/api/push/test
```

The panel UI handles subscription management automatically. Push events are sent for pending tool-call approvals, task failures, and any `push.notify()` call in server code.

### Pending approvals queue

Tool-call approvals from any Telegram chat are mirrored here so they can be resolved from the panel without touching Telegram.

```bash
# List all pending approvals (each entry has id, chatId, toolName, input, lead)
curl -H "$AUTH" $BASE/api/approvals

# Resolve an approval (id goes in the body, not the URL)
curl -X POST -H "$AUTH" -H "Content-Type: application/json" $BASE/api/approvals/resolve \
  -d '{ "id": "<id>", "action": "allow" }'
# action: "allow" | "deny" | "always"
#   allow  — approve this one call
#   deny   — refuse this one call
#   always — approve and add to the session's always-allow list
```

Approvals also broadcast over the `/ws` WebSocket (`{type:"approvals", approvals:[...]}`) so the panel can update live without polling.

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
- `GET /api/update/changelog`: the locally served `CHANGELOG.md` (`{ content }`); used as the Updates view's fallback when GitHub is unreachable.
- `GET /api/connectors`, `PUT /api/connectors/<id>`: the external-connector catalogue. All twenty-five are live, each tagged with a `category` (`productivity`: Notion, Google Calendar, Gmail, Google Drive, Apple Calendar, Apple Mail, Slack; `dev`: GitHub, Unreal Engine, Unity, Browser Sketchpad; `database`: PostgreSQL, SQLite; `image`: Recraft, Ideogram, Replicate, fal.ai, Local Stable Diffusion; `social`: Bluesky, Mastodon, Discord, Reddit, X, YouTube, Facebook Pages) that the panel uses for its category filter tabs; `PUT` takes `{ enabled, secretId, scope, expiresAt }` where `scope` is `read` (default) or `write` (gates the write tools), and `expiresAt` is an optional epoch-ms credential expiry (`null` clears it, omit to leave unchanged). `GET` returns a derived `tokenStatus` of `"none" | "ok" | "expiring" | "expired"` per connector.
- `POST /api/connectors/<id>/accounts`, `PUT /api/connectors/<id>/accounts/<accountId>`, `DELETE /api/connectors/<id>/accounts/<accountId>`: named accounts on the multi-account social connectors (`multiAccount: true` in the catalogue). Each account is `{ id, label, secretId }` — its own vault credential under a short label agents use to pick the posting identity (`POST` takes `{ label, secretId }`, `PUT` a partial of the same; labels are unique per connector, case-insensitive, max 40 chars). All three return the updated connector view. A social connector's tools appear once it is `enabled` and has at least one account.
- `GET /api/gallery`: list generated images (`?tag=&provider=&from=&to=&q=`, epoch-ms date bounds), returns `{ images, tags }` where `tags` is every distinct tag across the whole gallery. `GET /api/gallery/<id>`: single record. `GET /api/gallery/<id>/file`: the raw image bytes (content-type derived from extension). `PUT /api/gallery/<id>`: edit tags, body `{ tags: string[] }`. `DELETE /api/gallery/<id>`: remove the record and its file. `POST /api/gallery/generate`: `{ providerId: "recraft" | "ideogram" | "replicate" | "fal" | "local_sd", prompt, size?, style?, model?, negativePrompt?, steps?, extraInput? }` — calls the same image-generation core the `<provider>_generate_image` MCP tool uses, downloads (or decodes) the result, and saves it to the gallery. `model` is required for `replicate`/`fal` (e.g. `black-forest-labs/flux-schnell`); `negativePrompt`/`steps` are `local_sd`-only; `extraInput` is a raw object merged into the replicate/fal request body for power users. Requires the connector to be enabled with a credential (for `local_sd`, the credential is the server's base URL).
- `GET /api/chat`, `POST /api/chat/send|stop|clear|approve`, `PUT /api/chat/settings`: the panel's own Claude chat session (talks to Atlas). The autonomy level is set per-chat from the toolbar (replacing the removed `PANEL_CHAT_BYPASS` env flag). `POST /api/chat/send` also accepts an optional `images` array (base64 data URLs, from attach/drag-drop/paste in the composer) passed to the agent as inline vision content.
- `POST /api/chat/react`: react to an assistant reply with `{ reaction: "up" | "down", text }`. A thumbs-up files the response text as a durable memory; a thumbs-down is recorded. Returns 400 for any other reaction.
- `POST /api/chat/approve`: resolve a pending tool-call approval raised inside the panel chat itself, `{ approvalId, allow }` — the chat analogue of `POST /api/approvals/resolve`.
- `GET /api/asks`, `POST /api/asks/resolve`: the pending `AskUserQuestion` queue and its resolver, used to render interactive question widgets in panel chat. Resolve with `{ id, optionIndices?, text? }`.
- `GET /api/agent-chat/<id>`, `POST /api/agent-chat/<id>/send|stop|clear`, `PUT /api/agent-chat/<id>/settings`: an interactive chat with a specific worker/Lead by id. `POST /api/agent-chat/<id>/send` accepts the same optional `images` array as the main chat.
- `GET /api/usage/agents`: per-agent token + cost totals and a daily-by-role breakdown.
- `GET /api/memories/stats`: counts by tier and embedding coverage.
- `POST /api/agent/embeddings/auto`: re-enter embeddings auto-mode (clears the pin and re-probes the local backends).
- `POST /api/feedback`: relay a bug report / suggestion `{ kind, message, email? }` to the central collector (`FEEDBACK_URL`).
- `GET /api/me`: read-only deployment facts (version, brand/agent name, allowed-user count, panel host/port, tunnel/terminal flags) for the Setup view.
- `GET /api/terminal`, `POST /api/terminal/spawn|resize`: the panel terminal session.
- `GET /api/conversations/search`: hybrid (cosine + keyword) search across the live chat history and on-disk run transcripts (`?q=&limit=`), returning ranked hits with an extracted snippet and source (`chat` | `run`).
- `GET|PUT /api/branding`: the white-label branding draft (product/agent name, panel title, logo, favicon, colours, email footer). Overrides are only *applied* (folded into `GET /api/me`) when `BRANDING_UNLOCKED=true`; otherwise the draft persists but the env-default names are served.
