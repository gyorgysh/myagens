import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { isValidLanguage } from "./core/languages.js";

loadEnv();

// Default working directory: ~/MyAgens-Workspace, a cross-platform projects folder
// that exists on Linux, macOS, and Windows. The name is intentionally distinct
// from ~/myagens (the service install dir) so they never collide, even on
// case-insensitive macOS. Created on first use if absent. Override with WORKDIR.
// Resolves to <repo>/data from both src/config.ts and dist/config.js.
// dirname twice: src/config.ts or dist/config.js -> repo root in both layouts.
export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultWorkdir = join(homedir(), "MyAgens-Workspace");
// Session/usage state lives in the gitignored data/ folder so it
// survives restarts without leaking into any agent working directory.
const defaultStateFile = join(repoRoot, "data", "state.json");

const csvIds = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => Number(x)),
  )
  // z.number().int() rejects NaN (from non-numeric ids), giving a clean error.
  .pipe(z.array(z.number().int()).min(1, "ALLOWED_USER_IDS must contain at least one valid id"));

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  ALLOWED_USER_IDS: csvIds,
  WORKDIR: z.string().min(1).default(defaultWorkdir),
  // Where per-chat session + usage state is persisted (JSON). Survives restarts.
  STATE_FILE: z.string().min(1).default(defaultStateFile),
  CLAUDE_MODEL: z.string().min(1).default("claude-opus-4-8"),
  ANTHROPIC_API_KEY: z.string().optional(),
  APPROVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  // Agentic loop detection: when the same tool call (name + input) repeats this
  // many times in one turn, pause and ask Skip / Approve once / Continue, so a
  // runaway retry can't burn tokens unattended. Set to 0 to disable.
  LOOP_THRESHOLD: z.coerce.number().int().nonnegative().default(3),
  // Per-chat turn rate limit (SEC): even an allow-listed user mustn't be able to
  // spawn unbounded concurrent turns by messaging faster than one finishes. Each
  // chat may start at most TURN_RATE_LIMIT new turns per TURN_RATE_WINDOW_MS
  // (token bucket); over the limit it gets a short "slow down" notice instead of
  // a new turn. Autonomous turns (schedules/heartbeat) are exempt. Set the limit
  // to 0 to disable.
  TURN_RATE_LIMIT: z.coerce.number().int().nonnegative().default(5),
  TURN_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // Per-client rate limit on mutating panel API routes (SEC): an authenticated
  // panel user (or anyone holding PANEL_TOKEN) must not be able to spam costly
  // POST/PUT/PATCH/DELETE endpoints (delegate runs, chat sends, schedule runs)
  // unthrottled. Each client (keyed by IP) may make at most PANEL_RATE_LIMIT
  // mutating requests per PANEL_RATE_WINDOW_MS (token bucket); over the limit it
  // gets a 429 with Retry-After. GET/HEAD reads are exempt. Set the limit to 0
  // to disable.
  PANEL_RATE_LIMIT: z.coerce.number().int().nonnegative().default(120),
  PANEL_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // Separate, deliberately HIGH ceiling on a short list of *expensive* GET
  // endpoints (memory semantic search, log reads/search, per-run transcripts).
  // These run on localhost where dozens of agents legitimately read memory/logs
  // constantly, so the limit must never throttle normal fleet activity — it only
  // exists to stop a runaway client hammering thousands of heavy reads/min. Per
  // client IP, refilling over PANEL_RATE_WINDOW_MS. Set 0 to disable.
  PANEL_READ_RATE_LIMIT: z.coerce.number().int().nonnegative().default(600),
  // Outbound webhooks: when a schedule or worker/task run with a webhookUrl
  // completes, POST a JSON outcome payload to that URL. This is the per-request
  // timeout (ms) for that POST. Every webhook URL is run through assertSafeUrl()
  // (SSRF guard) before the call.
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  // Branding overrides (allows white-labelling / self-hosting with a different name).
  ATLAS_NAME: z.string().min(1).default("Atlas"),
  BRAND_NAME: z.string().min(1).default("MyAgens"),
  // White-label (full panel branding: title, logo, favicon, colours, email
  // footer) is a licensed feature. The configuration UI always exists, but the
  // overrides are only *applied* when this is true. Free for personal use:
  // self-hosters flip it here; the panel has no toggle for it.
  BRANDING_UNLOCKED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Where the panel "Send feedback" form relays bug reports / suggestions. The
  // project collector handles them server-side; override to point at your own.
  FEEDBACK_URL: z.string().url().default("https://gyorgy.sh/myagens_feedback"),
  // Default language for agent responses (BCP 47 tag, e.g. "en", "hu", "fr").
  // Fall back to English on an unsupported code rather than propagating an
  // invalid value into the "Respond in <lang>" prompt block or /lang display.
  DEFAULT_LANGUAGE: z
    .string()
    .min(2)
    .default("en")
    .transform((v) => (isValidLanguage(v) ? v : "en")),
  // Auto-generate skills from expensive/long turns (off by default).
  // Post-turn reflection: after a substantive turn, a short autonomous reflection
  // run distils a durable fact (→ memory) and/or a reusable procedure (→ skills).
  // Runs through the same model/provider as the bot; gated by cost/time thresholds
  // so cheap turns never trigger it.
  AUTO_SKILL_GENERATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Maintenance scheduler (memory compaction + skill pruning). Three states:
  //   unset  -> on by default: runs every 24h (catch-up, robust to downtime).
  //   HH:MM  -> daily at that server-local time.
  //   off    -> disabled.
  MAINTENANCE_CRON: z.string().optional(),
  // Memory compaction thresholds.
  MEMORY_MAX_ENTRIES: z.coerce.number().int().positive().default(500),
  COLD_MAX: z.coerce.number().int().positive().default(200),
  // Maintenance rewrites verbose memory entries into a terse one-liner (meaning
  // preserved) to keep recall context small. 0 = off. Hot entries inject into
  // EVERY turn, so they're the priority: shorten them past the (lower) hot
  // threshold. Warm entries only cost context when recalled, so they're left
  // alone unless they're genuinely bloated (the higher warm threshold). Cold
  // entries are panel-only and never shortened.
  MEMORY_SHORTEN_CHARS: z.coerce.number().int().nonnegative().default(220),
  // Hot-tier shorten threshold (chars). Lower than the warm one because hot
  // entries are paid for on every single turn. 0 = fall back to the warm value.
  MEMORY_SHORTEN_CHARS_HOT: z.coerce.number().int().nonnegative().default(160),
  // --- Semantic memory (Phase 2): local embeddings for similarity recall ---
  // Tri-state, default "auto": probe Ollama then LM Studio at startup and enable
  // embeddings against whichever is live (the panel can override this). "on" pins
  // the EMBEDDING_* backend below; "off" forces embeddings off (good for non-panel
  // users who never want them). Legacy "true"/"false" map to "on"/"off". Keyword
  // search is always the fallback.
  EMBEDDING_ENABLED: z
    .enum(["auto", "on", "off", "true", "false"])
    .default("auto")
    .transform((v) => (v === "true" ? "on" : v === "false" ? "off" : v)),
  // Which wire shape to speak: "ollama" (POST /api/embeddings) or "openai"
  // (POST /v1/embeddings, for LM Studio, OpenAI, most proxies).
  EMBEDDING_PROVIDER: z.enum(["ollama", "openai"]).default("ollama"),
  // Endpoint base URL. Default targets a local Ollama install.
  EMBEDDING_BASE_URL: z.string().url().default("http://localhost:11434"),
  // Embedding model id (e.g. "nomic-embed-text" for Ollama, "text-embedding-3-small" for OpenAI).
  EMBEDDING_MODEL: z.string().min(1).default("nomic-embed-text"),
  // Optional auth token (plain or a vault:<id> reference) for the embedding endpoint.
  EMBEDDING_AUTH_TOKEN: z.string().optional(),
  // How replies stream back:
  //   rich  = Bot API 10.1 sendRichMessageDraft -> sendRichMessage (structured markdown)
  //   draft = Bot API 9.3 sendMessageDraft (plain preview), finalized with sendMessage
  //   edit  = legacy throttled editMessageText of a placeholder message
  STREAM_MODE: z.enum(["rich", "draft", "edit"]).default("rich"),
  // Voice notes. Three backends:
  //   openai = OpenAI-compatible /audio/transcriptions (OpenAI, Groq, …)
  //   vosk   = fully local, offline recognition (needs VOSK_MODEL_PATH + ffmpeg)
  //   xai    = xAI's /v1/stt endpoint (needs XAI_API_KEY)
  TRANSCRIBE_PROVIDER: z.enum(["openai", "vosk", "xai"]).default("openai"),
  OPENAI_API_KEY: z.string().optional(),
  TRANSCRIBE_MODEL: z.string().min(1).default("whisper-1"),
  TRANSCRIBE_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  // Local Vosk: path to an unpacked model dir (e.g. vosk-model-small-en-us-0.15).
  VOSK_MODEL_PATH: z.string().optional(),
  // ffmpeg binary used to decode OGG/Opus voice notes to 16kHz mono PCM.
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  // xAI's own API key, shared by its TTS (/v1/tts) and STT (/v1/stt) endpoints —
  // a separate credential from OPENAI_API_KEY, fixed hosts (not "OpenAI-
  // compatible" reusable base URLs like the openai backend above).
  XAI_API_KEY: z.string().optional(),
  // --- Text-to-speech (spoken replies) ---
  // Provider for spoken voice replies:
  //   openai = OpenAI-compatible /audio/speech (OpenAI, or any compatible proxy)
  //   piper  = fully local, offline TTS (needs PIPER_PATH + PIPER_MODEL)
  //   xai    = xAI's /v1/tts endpoint (needs XAI_API_KEY)
  TTS_PROVIDER: z.enum(["openai", "piper", "xai"]).default("openai"),
  // OpenAI TTS model + voice (reuses OPENAI_API_KEY / a TTS-specific base url).
  // TTS_VOICE also doubles as the xai backend's voice_id (its default "alloy"
  // isn't a real xAI voice, so the xai path substitutes its own default "eve"
  // when this is left unset) — TTS_MODEL/TTS_BASE_URL are openai-only.
  TTS_MODEL: z.string().min(1).default("tts-1"),
  TTS_VOICE: z.string().min(1).default("alloy"),
  TTS_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  // Local Piper: path to the piper binary and an .onnx voice model.
  PIPER_PATH: z.string().min(1).default("piper"),
  PIPER_MODEL: z.string().optional(),
  // --- Management panel (optional embedded web UI) ---
  // The panel can read/write/run anything on the host, same as the bot, so it
  // is off by default and refuses to start without a token (see refinement).
  PANEL_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Bind address. Defaults to loopback; expose remotely via a reverse proxy or
  // a private network (e.g. tailscale), never by binding 0.0.0.0 unprotected.
  PANEL_HOST: z.string().min(1).default("127.0.0.1"),
  PANEL_PORT: z.coerce.number().int().positive().default(8787),
  // Shared secret required on every panel request + WS handshake. Required
  // whenever PANEL_ENABLED=true (enforced below).
  PANEL_TOKEN: z.string().optional(),
  // Panel chat feature toggle. On by default when the panel runs; set false to
  // hide the Chat view and reject its endpoints entirely.
  PANEL_CHAT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Panel terminal: a full interactive host shell streamed over /ws. A panel
  // token holder gets arbitrary command execution as the bot's user, so this is
  // OFF by default and must be explicitly opted into. Set true + restart to enable.
  PANEL_TERMINAL_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Whether the terminal shell inherits the bot's full environment (which holds
  // secrets loaded from .env: TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, PANEL_TOKEN,
  // OPENAI_API_KEY, …). Off by default: the shell gets a minimal sanitized env
  // (PATH/HOME/USER/SHELL/TERM/LANG) so a terminal session can't trivially read
  // those secrets back out via `env`. Set true only if you understand the risk.
  PANEL_TERMINAL_INHERIT_ENV: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Remote access: let the panel spawn a tunnel relay (ngrok / cloudflared) so it
  // is reachable from a phone over the internet, gated by the panel login. The
  // panel token is host-equivalent, so this is OFF by default and must be opted
  // into. When enabled, the actual relay still only runs when the user starts it
  // from the Remote Access view (with a provider + token configured).
  PANEL_TUNNEL_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

// Fail closed: a panel with host access must never run without a token.
const refined = schema.superRefine((cfg, ctx) => {
  if (cfg.PANEL_ENABLED && !cfg.PANEL_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["PANEL_TOKEN"],
      message: "PANEL_TOKEN is required when PANEL_ENABLED=true",
    });
  }
  // A short token is brute-forceable; the panel can read/write/run on the host.
  if (cfg.PANEL_ENABLED && cfg.PANEL_TOKEN && cfg.PANEL_TOKEN.length < 16) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["PANEL_TOKEN"],
      message: "PANEL_TOKEN must be at least 16 characters (use a long random secret)",
    });
  }
});

/**
 * When the panel auto-heals a missing/weak PANEL_TOKEN at startup, the freshly
 * generated value lands here so `index.ts` can DM it to the user once the bot
 * connects. Null when no regeneration happened.
 */
export let regeneratedPanelToken: string | null = null;

/** Cryptographically strong, URL/.env-safe token (no quoting needed). */
function generatePanelToken(): string {
  // 24 bytes -> 32 base64url chars, comfortably above the 16-char minimum.
  return randomBytes(24).toString("base64url");
}

/**
 * Self-heal a missing or too-short PANEL_TOKEN before validation, so an existing
 * install with a weak/blank token (which the SEC-3 16-char minimum would now
 * reject at startup) keeps booting instead of crash-looping after an update.
 *
 * Generates a strong token, rewrites the PANEL_TOKEN line in `.env` in place
 * (or appends one), mutates `process.env` so this run uses it, and records it in
 * `regeneratedPanelToken` so the user is notified over Telegram with the new
 * value. Only runs when the panel is enabled. Best-effort: if `.env` can't be
 * written, the token still applies to the live process and the user is notified.
 */
function healPanelToken(): void {
  const enabled = process.env.PANEL_ENABLED === "true";
  if (!enabled) return;
  const current = process.env.PANEL_TOKEN ?? "";
  if (current.length >= 16) return;

  const token = generatePanelToken();
  process.env.PANEL_TOKEN = token;
  regeneratedPanelToken = token;

  const envPath = join(repoRoot, ".env");
  try {
    let body = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const line = `PANEL_TOKEN=${token}`;
    if (/^PANEL_TOKEN=.*$/m.test(body)) {
      body = body.replace(/^PANEL_TOKEN=.*$/m, line);
    } else {
      if (body.length && !body.endsWith("\n")) body += "\n";
      body += `${line}\n`;
    }
    writeFileSync(envPath, body, { mode: 0o600 });
    // eslint-disable-next-line no-console
    console.warn(
      "PANEL_TOKEN was missing or shorter than 16 chars; generated a new strong token and wrote it to .env.",
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `PANEL_TOKEN was weak; generated a new one for this run but could not persist it to .env (${
        err instanceof Error ? err.message : String(err)
      }). It will change again on the next restart until .env is writable.`,
    );
  }
}

function parseConfig() {
  healPanelToken();
  const parsed = refined.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(`Invalid configuration. Check your .env file:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export type Config = z.infer<typeof schema>;

export const config = parseConfig();

/**
 * Map retired model IDs to their current replacements so users who have an old
 * value in their .env or mainAgent.json are silently upgraded. Preserves any ID
 * that isn't in the map unchanged.
 */
const MODEL_ALIASES: Record<string, string> = {
  "claude-sonnet-4-6": "claude-sonnet-5",
  "claude-sonnet-4-5": "claude-sonnet-5",
  "claude-sonnet-4-5-20250929": "claude-sonnet-5",
};

export function normalizeModelId(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

export const allowedUserIds = new Set<number>(config.ALLOWED_USER_IDS);
