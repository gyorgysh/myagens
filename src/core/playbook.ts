import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getPersonality, WORK_FILE } from "../prompt.js";
import { audit } from "./audit.js";

// Warn the user when work.md exceeds this threshold. It is injected into the
// system prompt by the bot on every turn, so keeping it lean directly reduces
// token cost and latency. The shipped default is ~3.3 KB, so 6 KB gives a
// comfortable margin before flagging genuinely grown files.
export const PROMPT_FILE_SIZE_WARN_BYTES = 6144;

export interface PromptView {
  /** The fixed personality block compiled into the build (read-only). */
  personality: string;
  /** Absolute path to the operator playbook. */
  workFile: string;
  /** Current playbook contents (empty string if the file doesn't exist yet). */
  work: string;
  exists: boolean;
  /** The shipped default playbook (git-tracked template), if it can be read. */
  defaultWork?: string;
  /** Whether the live playbook matches the shipped default (false = customized). */
  matchesDefault?: boolean;
  /** Byte size of work.md (0 if absent). */
  workBytes: number;
}

/**
 * The playbook ships as a git-tracked template (`work.md`) that users are meant
 * to customize per-box. Reading the committed blob lets us tell the user whether
 * their live file is the untouched default or has drifted, so they can restore
 * it if a change looks accidental. Returns undefined when git/the blob is
 * unavailable (e.g. tarball install) — the UI just hides the indicator then.
 */
function readDefaultPlaybook(): string | undefined {
  try {
    const out = execFileSync("git", ["show", "HEAD:work.md"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out;
  } catch {
    return undefined;
  }
}

/** Normalize for comparison: ignore trailing-whitespace/newline noise. */
function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
}

function safeStatBytes(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

export function getPrompt(): PromptView {
  let work = "";
  let exists = false;
  if (existsSync(WORK_FILE)) {
    try {
      work = readFileSync(WORK_FILE, "utf8");
      exists = true;
    } catch {
      /* unreadable — surface as empty */
    }
  }
  const defaultWork = readDefaultPlaybook();
  const matchesDefault =
    defaultWork === undefined
      ? undefined
      : normalize(work) === normalize(defaultWork);

  const workBytes = safeStatBytes(WORK_FILE);

  return {
    personality: getPersonality(),
    workFile: WORK_FILE,
    work,
    exists,
    defaultWork,
    matchesDefault,
    workBytes,
  };
}

/** Overwrite the operator playbook. Takes effect on the next turn (re-read live). */
export function savePlaybook(content: string): PromptView {
  mkdirSync(dirname(WORK_FILE), { recursive: true });
  writeFileSync(WORK_FILE, content);
  audit("prompt.save", { workFile: WORK_FILE, bytes: content.length });
  return getPrompt();
}

/** Restore the operator playbook to the shipped default template. */
export function restorePlaybook(): PromptView {
  const def = readDefaultPlaybook();
  if (def === undefined) {
    throw new Error("Shipped default playbook is unavailable (no git checkout).");
  }
  return savePlaybook(def);
}
