import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GitResult {
  ok: boolean;
  /** Combined stdout (or stderr on failure), trimmed. */
  out: string;
}

/** Run a git subcommand in `cwd`. Never throws — failures come back as ok:false. */
async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    return { ok: true, out: stdout.trim() };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return { ok: false, out: (e.stderr || e.stdout || e.message || "git error").trim() };
  }
}

/** True if `cwd` is inside a git work tree. */
export async function isRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.out === "true";
}

/** Porcelain status (short form), empty string when the tree is clean. */
export async function status(cwd: string): Promise<GitResult> {
  return git(cwd, ["status", "--short", "--branch"]);
}

/** Full working-tree diff including staged changes (HEAD vs working tree). */
export async function diff(cwd: string): Promise<GitResult> {
  return git(cwd, ["diff", "HEAD"]);
}

/** Names of files with any change (tracked modifications + untracked). */
export async function changedFiles(cwd: string): Promise<string[]> {
  const r = await git(cwd, ["status", "--porcelain"]);
  if (!r.ok || !r.out) return [];
  return r.out
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/** Stage everything and commit with `message`. Returns the commit summary. */
export async function commitAll(cwd: string, message: string): Promise<GitResult> {
  const add = await git(cwd, ["add", "-A"]);
  if (!add.ok) return add;
  return git(cwd, ["commit", "-m", message]);
}

/**
 * Discard changes to tracked files (git restore). Untracked files are left in
 * place — clearing those is destructive enough that we don't do it implicitly.
 */
export async function discardTracked(cwd: string): Promise<GitResult> {
  return git(cwd, ["restore", "--staged", "--worktree", "."]);
}
