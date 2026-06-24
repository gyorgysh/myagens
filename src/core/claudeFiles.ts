import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
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

/** Candidate roots: the bot workdir, repo root, and every session cwd/project. */
function roots(): string[] {
  const set = new Set<string>([config.WORKDIR, repoRoot]);
  for (const s of sessions.all()) {
    set.add(s.cwd);
    for (const p of s.projects) set.add(p);
  }
  return [...set];
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

/** True if `path` is an editable Claude config file inside a known root. */
function isAllowed(path: string): boolean {
  const abs = resolve(path);
  if (!abs.endsWith(".md")) return false;
  const inRoot = roots().some((r) => abs === join(r, "CLAUDE.md") || abs.startsWith(resolve(r) + sep));
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
