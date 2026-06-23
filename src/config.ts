import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

// Default working directory: a gitignored `data/` folder at the repo root, so
// files the agent creates (and uploads) stay out of the project tree.
// Resolves to <repo>/data from both src/config.ts and dist/config.js.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
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
});

function parseConfig() {
  const parsed = schema.safeParse(process.env);
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
