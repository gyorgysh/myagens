# r/selfhosted draft

**Title:** I built a self-hosted AI assistant that runs Claude Code on your machine and lets you control it from Telegram (open source)

## Body

I wanted an AI assistant I actually own — running on my own hardware, no cloud middleman, no SaaS dashboard holding my data. So I built MyHQ: it runs a real Claude Code agent locally on your machine and lets you drive it from a Telegram chat (and an optional web panel).

To be clear about what's local and what isn't: the agent runs on **your** box. It reads and writes **your** files, runs commands on **your** host, and stores everything — sessions, memory, secrets, logs — in a local data directory. The one thing that isn't local is the model itself: you need a Claude account (it uses your existing Claude CLI login or an API key). But if you'd rather not call out to Anthropic at all for some of the work, you can point individual agents at a local model through LM Studio or Ollama, and the semantic-memory embeddings and voice transcription both run fully offline.

What you get:

- **Control from your phone.** Message the bot, it streams back what it's doing live. Risky actions (writing files, running commands) pop inline Approve/Deny buttons; read-only stuff runs on its own. You decide how much leash per chat.

- **A web panel** (off by default, token-gated, loopback-only unless you expose it). Live logs and an activity feed, a Kanban board you can delegate cards from, memory you can edit, usage stats, schedules, model/provider settings, an optional terminal, and an optional tunnel for phone access.

- **A crew of agents.** Beyond the main agent you can run named sub-agents, each on its own model and working directory, some with their own Telegram bots. Useful if you want a "routine stuff" agent on a cheap local model and a "do it properly" agent on a frontier model.

- **Encrypted secret vault.** Tokens are AES-256-GCM encrypted with the key in the OS keychain (or a `0600` file on Linux), referenced indirectly and resolved at use-time. Logs are run through a secret redactor before anything is written.

- **Persistence.** Sessions survive restarts, memory accumulates across runs, schedules fire on intervals or daily times.

Runs on Linux or macOS, Node 20+. Install is a `curl | bash` wizard or a manual clone-and-build; it can install itself as a systemd/launchd service.

**One honest warning:** the agent can read, write, and run anything on the host — that's the whole point, but it means the access control is an allow-list of Telegram user IDs and you should run it on a machine you own with that list kept tight. Don't expose the panel to the internet without the built-in auth in front of it.

It's open source. Feedback and questions welcome — especially on the security model, since that's the part I most want eyes on.
