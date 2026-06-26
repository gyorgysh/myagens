import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { config, repoRoot } from "../config.js";
import { sessions } from "../session/manager.js";
import { audit } from "./audit.js";

/**
 * A read/write window onto the on-disk Claude Code config the driven agent
 * loads: per-root .claude/{agents,skills,commands}/*.md plus the root CLAUDE.md.
 * Scoped on purpose — writes are refused outside these locations so the editor
 * can't be turned into an arbitrary-file write primitive.
 */
export interface ClaudeFile {
  /** Absolute path. */
  path: string;
  /** Path relative to its root, for display. */
  rel: string;
  kind: "agent" | "skill" | "command" | "memory";
  bytes: number;
}

export interface ClaudeRoot {
  root: string;
  files: ClaudeFile[];
}

/**
 * A path is too shallow to ever be a legitimate project root (filesystem root,
 * a top-level dir like /etc, or a drive root). Allowing one would let a session
 * cwd of "/" widen the editable scope to the whole disk, so we drop them.
 */
function tooShallow(abs: string): boolean {
  // Count path segments below the root. resolve() already normalised it.
  const segments = abs.split(sep).filter(Boolean);
  // < 2 segments means "/", "/etc", "C:\", "C:\Users" — reject the first two.
  return segments.length < 2;
}

/**
 * Candidate roots: the bot workdir, repo root, and every session cwd/project.
 * Each is canonicalised (symlinks resolved) and filtered so a too-shallow root
 * can't broaden the write scope. Returns absolute, real paths.
 */
function roots(): string[] {
  const raw = new Set<string>([config.WORKDIR, repoRoot]);
  for (const s of sessions.all()) {
    raw.add(s.cwd);
    for (const p of s.projects) raw.add(p);
  }
  const out = new Set<string>();
  for (const r of raw) {
    const real = realPath(resolve(r));
    if (!real || tooShallow(real)) continue;
    out.add(real);
  }
  return [...out];
}

/** realpathSync that returns undefined instead of throwing on a missing path. */
function realPath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

const SUBDIRS: Array<{ dir: string; kind: ClaudeFile["kind"] }> = [
  { dir: join(".claude", "agents"), kind: "agent" },
  { dir: join(".claude", "skills"), kind: "skill" },
  { dir: join(".claude", "commands"), kind: "command" },
];

function scanDir(root: string, sub: string, kind: ClaudeFile["kind"]): ClaudeFile[] {
  const base = join(root, sub);
  if (!existsSync(base)) return [];
  const out: ClaudeFile[] = [];
  for (const entry of readdirSync(base, { recursive: true }) as string[]) {
    if (!entry.endsWith(".md")) continue;
    const path = join(base, entry);
    try {
      const st = statSync(path);
      if (st.isFile()) out.push({ path, rel: relative(root, path), kind, bytes: st.size });
    } catch {
      /* skip unreadable entry */
    }
  }
  return out;
}

export function listClaudeFiles(): ClaudeRoot[] {
  const result: ClaudeRoot[] = [];
  for (const root of roots()) {
    const files: ClaudeFile[] = [];
    for (const { dir, kind } of SUBDIRS) files.push(...scanDir(root, dir, kind));
    const memory = join(root, "CLAUDE.md");
    if (existsSync(memory)) {
      try {
        files.push({
          path: memory,
          rel: "CLAUDE.md",
          kind: "memory",
          bytes: statSync(memory).size,
        });
      } catch {
        /* ignore */
      }
    }
    if (files.length) result.push({ root, files: files.sort((a, b) => a.rel.localeCompare(b.rel)) });
  }
  return result;
}

/**
 * Canonicalise a path that may not exist yet: realpath the deepest existing
 * ancestor (so symlinks anywhere in the path are resolved), then re-append the
 * non-existent tail. This stops a symlinked component from escaping the scope.
 */
function canonicalize(path: string): string {
  let abs = resolve(path);
  const tail: string[] = [];
  // Walk up until we hit a path that exists, realpath it, then rebuild.
  while (!existsSync(abs)) {
    const parent = dirname(abs);
    if (parent === abs) break; // reached the root
    tail.unshift(basename(abs));
    abs = parent;
  }
  const realBase = realPath(abs) ?? abs;
  return tail.length ? join(realBase, ...tail) : realBase;
}

/**
 * True if `path` is an editable Claude config file inside a known root.
 * The path is canonicalised first (symlinks resolved) and containment is
 * checked against the canonical root paths, so the editor can't be turned into
 * an arbitrary-file write primitive via a symlink or a "/" session cwd.
 */
function isAllowed(path: string): boolean {
  const abs = canonicalize(path);
  if (!abs.endsWith(".md")) return false;
  // Must be a CLAUDE.md at a root, or a .md somewhere under a root's .claude/.
  const inRoot = roots().some(
    (r) => abs === join(r, "CLAUDE.md") || abs.startsWith(r + sep),
  );
  if (!inRoot) return false;
  return abs.includes(`${sep}.claude${sep}`) || basename(abs) === "CLAUDE.md";
}

export function readClaudeFile(path: string): string | undefined {
  if (!isAllowed(path) || !existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function writeClaudeFile(path: string, content: string): boolean {
  if (!isAllowed(path)) return false;
  try {
    writeFileSync(path, content);
    audit("claudeFile.save", { path, bytes: content.length });
    return true;
  } catch {
    return false;
  }
}
