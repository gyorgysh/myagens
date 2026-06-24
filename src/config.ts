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
