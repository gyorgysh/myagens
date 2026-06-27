# Show HN draft

**Title:** Show HN: MyHQ, a self-hosted Claude Code agent you control over Telegram

**URL:** (link to the GitHub repo)

## First comment

I kept ending up SSHed into my own machine at 2am from my phone to run one command — restart a service, check why a deploy failed, tail a log. MyHQ is what I built so I'd stop doing that. It runs a real Claude Code agent on your own machine and lets you drive it from a Telegram chat.

You message the bot, it runs the Claude Agent SDK on the host, streams the reply back as it works, and gates risky tool calls behind inline Approve/Deny buttons. It's not a sandbox or a wrapper around the API — it loads the real `CLAUDE.md` and settings from whatever directory it's working in, so it behaves like a genuine Claude Code session you happen to be holding over chat.

A few things that make it more than a chat relay:

- **Approval flow.** In the default mode read-only tools (Read, Grep, …) run automatically and anything that writes or executes posts inline buttons that block until you tap. "Always allow" persists per tool, and there's an "always allow `<command>`" option for specific shell programs. You can also drop to fully supervised (prompt everything) or full-auto per chat.

- **Autonomous Leads.** You can stand up named sub-agents — Leads with their own Telegram bot, Assistants that report to a Lead, single-purpose specialists. Each can run on its own model (a cheap local model for routine work, a frontier model where it matters). Atlas, the main agent, can delegate a subtask to a Lead and get the result back.

- **Kanban delegation.** There's a board in the web panel. Hand a card to an agent and it works the task end to end in its own directory — breaking it into subtasks if needed — then moves it to done with a memory note and a Telegram report. Failures get a one-tap retry.

- **Encrypted vault.** Provider tokens and connector credentials are AES-256-GCM encrypted, with the master key in the macOS Keychain (or a `0600` key file on Linux). Secrets are referenced as `vault:<id>` and resolved at use-time, so plaintext tokens never sit in config or get returned to the panel.

- **The panel.** An optional web dashboard (off by default, token-gated) for everything that's awkward over chat: live logs and activity feed, usage, the Kanban board, memory, the crew hierarchy, model/provider settings, schedules, and an optional terminal and tunnel.

It's not locked to Anthropic — point any agent at a local model via LM Studio or Ollama, or any OpenAI-compatible proxy. Semantic memory embeddings and voice transcription both run fully offline if you want them to.

Important caveat up front: **the bot can read, write, and run anything on the host.** The only access control is an allow-list of Telegram user IDs. That's by design — it's your machine and your agent — but it means you run it on hardware you own and you keep the allow-list tight. The panel is loopback-only by default; expose it remotely only behind the built-in auth (and ideally a reverse proxy).

You need a Claude account (the agent uses your CLI login or an API key), Node 20+, and a Telegram bot token. Install is a `curl | bash` wizard or a manual clone-and-build.

Happy to answer anything about the architecture or the security model.
