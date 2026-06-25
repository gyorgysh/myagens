import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

// Default working directory: a gitignored `data/` folder at the repo root, so
// files the agent creates (and uploads) stay out of the project tree.
// Resolves to <repo>/data from both src/config.ts and dist/config.js.
// dirname twice: src/config.ts or dist/config.js -> repo root in both layouts.
export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultWorkdir = join(repoRoot, "data");
// Session/usage state lives alongside in the gitignored data/ folder so it
// survives restarts without leaking into any agent working directory.
const defaultStateFile = join(defaultWorkdir, "state.json");

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
  // Branding overrides (allows white-labelling / self-hosting with a different name).
  ATLAS_NAME: z.string().min(1).default("Atlas"),
  BRAND_NAME: z.string().min(1).default("MyHQ"),
  // Default language for agent responses (BCP 47 tag, e.g. "en", "hu", "fr").
  DEFAULT_LANGUAGE: z.string().min(2).default("en"),
  // Auto-generate skills from expensive/long turns (off by default).
  // Post-turn reflection: after a substantive turn, a short autonomous reflection
  // run distils a durable fact (→ memory) and/or a reusable procedure (→ skills).
  // Runs through the same model/provider as the bot; gated by cost/time thresholds
  // so cheap turns never trigger it.
  AUTO_SKILL_GENERATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Maintenance scheduler: daily run time in HH:MM (server-local 24h). Disabled if unset.
  MAINTENANCE_CRON: z.string().optional(),
  // Memory compaction thresholds.
  MEMORY_MAX_ENTRIES: z.coerce.number().int().positive().default(500),
  COLD_MAX: z.coerce.number().int().positive().default(200),
  // --- Semantic memory (Phase 2): local embeddings for similarity recall ---
  // Off by default; keyword search is always the fallback. When on, memories are
  // embedded with a local model and recall blends cosine similarity with keywords.
  EMBEDDING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Which wire shape to speak: "ollama" (POST /api/embeddings) or "openai"
  // (POST /v1/embeddings — LM Studio, OpenAI, most proxies).
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
  // Voice notes. Two backends:
  //   openai = OpenAI-compatible /audio/transcriptions (OpenAI, Groq, …)
  //   vosk   = fully local, offline recognition (needs VOSK_MODEL_PATH + ffmpeg)
  TRANSCRIBE_PROVIDER: z.enum(["openai", "vosk"]).default("openai"),
  OPENAI_API_KEY: z.string().optional(),
  TRANSCRIBE_MODEL: z.string().min(1).default("whisper-1"),
  TRANSCRIBE_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  // Local Vosk: path to an unpacked model dir (e.g. vosk-model-small-en-us-0.15).
  VOSK_MODEL_PATH: z.string().optional(),
  // ffmpeg binary used to decode OGG/Opus voice notes to 16kHz mono PCM.
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
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
  // Panel chat: unlock "auto" (bypassPermissions) mode for the in-panel chat.
  // Off by default — the chat then gates every risky tool behind an in-panel
  // approve/deny prompt. Set true + restart to allow auto-run without prompts.
  PANEL_CHAT_BYPASS: z
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
});

function parseConfig() {
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

export const allowedUserIds = new Set<number>(config.ALLOWED_USER_IDS);
