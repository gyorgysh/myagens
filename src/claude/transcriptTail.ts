import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * Session-transcript tailing for tmux-hosted Claude instances.
 *
 * The interactive `claude` TUI already maintains a structured record of its
 * conversation: an append-only JSONL under `~/.claude/projects/<cwd-slug>/`
 * with one line per message (assistant text, tool_use blocks, token usage —
 * everything). Tailing that file is the proper bot ↔ CLI channel for Tmux
 * mode: no `/export` command typed into the user's conversation, no rendered-
 * screen parsing, and we get live streaming + usage for free. This module is
 * deliberately dumb byte plumbing; tmuxInstance.ts owns the turn semantics.
 */

/** Claude CLI project folder for a cwd (the CLI's own slug convention:
 *  every non-alphanumeric byte becomes "-", no collapsing). */
export function claudeProjectDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

export interface TranscriptUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface TranscriptContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

/** One JSONL line of a session transcript (only the fields we read). */
export interface TranscriptEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  sessionId?: string;
  isApiErrorMessage?: boolean;
  message?: {
    id?: string;
    model?: string;
    role?: string;
    usage?: TranscriptUsage;
    content?: TranscriptContentBlock[] | string;
  };
}

/** How far back a freshly-bound tail starts reading. Entries are filtered by
 *  timestamp downstream, so this only bounds the one-time catch-up read on a
 *  large resumed transcript. */
const RECENT_WINDOW_BYTES = 512 * 1024;

/**
 * Incremental reader over an append-only JSONL file. Byte offsets + a raw
 * Buffer remainder (never split a multibyte char / partial line), complete
 * lines JSON-parsed, corrupt or partial lines silently skipped — starting at
 * a mid-line offset (the "recent" mode) self-heals on the first newline.
 */
export class TranscriptTail {
  private offset: number;
  private remainder: Buffer = Buffer.alloc(0);

  constructor(
    readonly path: string,
    start: "end" | "recent",
  ) {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      /* not there yet — first poll will retry from 0 */
    }
    this.offset = start === "end" ? size : Math.max(0, size - RECENT_WINDOW_BYTES);
  }

  /** Parse every complete line appended since the previous poll. */
  poll(): TranscriptEntry[] {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      // Truncated/replaced — start over rather than reading garbage.
      this.offset = 0;
      this.remainder = Buffer.alloc(0);
    }
    if (size === this.offset) return [];
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return [];
    }
    try {
      const buf = Buffer.alloc(size - this.offset);
      const read = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += read;
      let data = Buffer.concat([this.remainder, buf.subarray(0, read)]);
      const entries: TranscriptEntry[] = [];
      let nl: number;
      while ((nl = data.indexOf(0x0a)) !== -1) {
        const line = data.subarray(0, nl).toString("utf8").trim();
        data = data.subarray(nl + 1);
        if (!line) continue;
        try {
          entries.push(JSON.parse(line) as TranscriptEntry);
        } catch {
          /* partial first line after a mid-file start, or a corrupt line */
        }
      }
      this.remainder = data;
      return entries;
    } finally {
      closeSync(fd);
    }
  }
}

/** Last `bytes` of a file as UTF-8 (for the discovery probe). */
function readTail(path: string, bytes: number): string {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    try {
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Plain text of an entry's message content (string form or text blocks). */
function entryText(e: TranscriptEntry): string | null {
  const c = e.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts = c.filter((b) => b.type === "text" && typeof b.text === "string");
    return parts.length ? parts.map((b) => b.text).join("\n") : null;
  }
  return null;
}

const normWs = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Find the transcript the TUI is writing for `cwd`: a UUID-named .jsonl
 * touched after `sinceMs` that contains a `type:"user"` line whose message
 * text EQUALS the just-submitted prompt (whitespace-normalized) with a
 * timestamp at/after submit. Full-message equality is deliberate: a substring
 * probe binds the wrong session whenever another CLI run in the same cwd
 * merely *quotes* the prompt — the memory-reflection one-shot embeds the
 * user's prompt verbatim, and a two-letter prompt like "hi" matches almost
 * any file. No user line matching the prompt exactly ⇒ no binding.
 */
export function findSessionTranscript(
  cwd: string,
  sinceMs: number,
  prompt: string,
): { path: string; sessionId: string } | null {
  const dir = claudeProjectDir(cwd);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = files
    .filter((f) => /^[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/i.test(f))
    .map((f) => {
      const path = join(dir, f);
      try {
        return { path, mtime: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((c): c is { path: string; mtime: number } => c !== null && c.mtime >= sinceMs - 3000)
    .sort((a, b) => b.mtime - a.mtime);

  const want = normWs(prompt);
  if (!want) return null;
  for (const c of candidates) {
    for (const line of readTail(c.path, 256 * 1024).split("\n")) {
      let e: TranscriptEntry;
      try {
        e = JSON.parse(line) as TranscriptEntry;
      } catch {
        continue; // partial first line of the tail window, or corrupt
      }
      if (e.type !== "user" || e.isSidechain) continue;
      // Same-host timestamps; small slack for clock granularity only.
      if (e.timestamp && Date.parse(e.timestamp) < sinceMs - 5000) continue;
      const txt = entryText(e);
      if (txt && normWs(txt) === want) {
        return { path: c.path, sessionId: basename(c.path, ".jsonl") };
      }
    }
  }
  return null;
}

/** True if a previously-bound transcript path is still readable. */
export function transcriptExists(path: string | undefined): path is string {
  return Boolean(path && existsSync(path));
}
