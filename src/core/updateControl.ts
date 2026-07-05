import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { repoRoot } from "../config.js";
import { log } from "../logger.js";
import { audit } from "./audit.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { serviceInstalled, restartService } from "./agentControl.js";

const pexec = promisify(execFile);
const UPDATE_SH = join(repoRoot, "scripts", "update.sh");
const UPDATE_PS1 = join(repoRoot, "scripts", "windows", "update.ps1");
const FILE = "update.json";

export interface UpdateStatus {
  /** Branch this checkout tracks. */
  branch: string;
  /** Short sha currently checked out. */
  current: string;
  /** Short sha of the latest fetched commit on the remote branch. */
  latest?: string;
  /** Number of commits the local checkout is behind the remote. */
  behindBy: number;
  /** Convenience flag: behindBy > 0. */
  available: boolean;
  /** package.json "version" of the current checkout. */
  currentVersion?: string;
  /** package.json "version" at FETCH_HEAD (the latest fetched remote commit). */
  latestVersion?: string;
  /** Subjects of the commits we're behind, newest first (capped). */
  commits: string[];
  /** When the remote was last checked (epoch ms). */
  checkedAt?: number;
  /** Last check error, if any. */
  error?: string;
}

export type UpdateView = UpdateStatus & { checking: boolean; updating: boolean };

const EMPTY: UpdateStatus = { branch: "", current: "", behindBy: 0, available: false, commits: [] };

let cached: UpdateStatus | undefined;
let checking = false;
let updating = false;

function git(args: string[]): Promise<string> {
  return pexec("git", args, { cwd: repoRoot }).then((r) => r.stdout.trim());
}

/** Read the "version" field out of a package.json's raw text. Returns undefined if unparseable. */
function packageVersion(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/** package.json "version" of the current checkout, read straight off disk. */
function currentPackageVersion(): string | undefined {
  try {
    return packageVersion(readFileSync(join(repoRoot, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function load(): UpdateStatus {
  if (!cached) cached = loadJson<UpdateStatus>(FILE, EMPTY);
  return cached;
}

/** Cached status — no network. Safe to call on every panel poll / `/api/me`. */
export function getUpdateStatus(): UpdateView {
  return { ...load(), checking, updating };
}

/** Fetch the remote and recompute how far behind we are. Hits the network. */
export async function checkForUpdate(): Promise<UpdateView> {
  if (checking) return getUpdateStatus();
  checking = true;
  try {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    await git(["fetch", "--prune", "origin", branch]);
    const current = await git(["rev-parse", "--short", "HEAD"]);
    const latest = await git(["rev-parse", "--short", "FETCH_HEAD"]);
    const behindBy = Number(await git(["rev-list", "--count", "HEAD..FETCH_HEAD"])) || 0;
    const logOut =
      behindBy > 0 ? await git(["log", "--oneline", "--no-decorate", "-n", "15", "HEAD..FETCH_HEAD"]) : "";
    const currentVersion = currentPackageVersion();
    const latestVersion =
      behindBy > 0
        ? packageVersion(await git(["show", "FETCH_HEAD:package.json"]).catch(() => "")) ?? currentVersion
        : currentVersion;
    cached = {
      branch,
      current,
      latest,
      behindBy,
      available: behindBy > 0,
      currentVersion,
      latestVersion,
      commits: logOut ? logOut.split("\n").filter(Boolean) : [],
      checkedAt: Date.now(),
    };
    saveJson(FILE, cached);
    log.info("Update check", { branch, behindBy });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    cached = { ...load(), error: message, checkedAt: Date.now() };
    saveJson(FILE, cached);
    log.warn("Update check failed", { error: message });
  } finally {
    checking = false;
  }
  return getUpdateStatus();
}

export function isUpdating(): boolean {
  return updating;
}

/**
 * Run scripts/update.sh, streaming each output line to `onLine`. The script
 * fetches, hard-resets to the remote, reinstalls, rebuilds the panel + bot, and
 * restarts the service if one is installed — so on a serviced host this process
 * is killed near the end (the restart is handed to systemd/launchd, which
 * completes it). Spawned detached so the build survives our death.
 */
export async function runUpdate(onLine: (line: string) => void): Promise<{ ok: boolean }> {
  return runScript(onLine, "update");
}

/**
 * Restore the checkout to the latest commit on its branch from GitHub — the
 * recovery escape hatch when a local change (e.g. a self-update gone wrong)
 * breaks the build or the panel. It runs the same scripts/update.sh, which
 * hard-resets tracked files to the remote while leaving every untracked /
 * gitignored path (data/, .env, vault, work.md) intact — so your data and
 * config survive and only the code is reset. Available regardless of whether an
 * update is "available" (the whole point is to discard broken local edits).
 */
export async function runRestore(onLine: (line: string) => void): Promise<{ ok: boolean }> {
  return runScript(onLine, "restore");
}

async function runScript(
  onLine: (line: string) => void,
  mode: "update" | "restore",
): Promise<{ ok: boolean }> {
  if (updating) {
    onLine(`An ${mode} is already in progress.`);
    return { ok: false };
  }
  updating = true;
  audit(mode === "restore" ? "update.restore" : "update.run", {});
  // Windows has no bash; run the PowerShell counterpart. Both update and restore
  // hard-reset the checkout to the remote, so one script covers both modes.
  const isWin = process.platform === "win32";
  const script = isWin ? UPDATE_PS1 : UPDATE_SH;
  log.warn(`${mode === "restore" ? "Restore" : "Update"} requested — running ${script}`);
  return new Promise((resolve) => {
    // Full path to powershell.exe — the service's PATH may not include
    // System32\WindowsPowerShell\v1.0, which would make a bare "powershell.exe"
    // fail to spawn. Fall back to the bare name if SystemRoot is unset.
    const psExe = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
    );
    // On Unix: detached + unref so the build survives the systemd/launchd
    // SIGTERM that the restart step sends to this process near the end.
    // On Windows: omit detached — Node.js 24 on Windows silently breaks the
    // stdout pipe when detached:true is set, causing zero data events and
    // making the panel show no output. It's fine without it: the script does
    // NOT restart the service when MYAGENS_INPANEL=1 (it can't — the service
    // account .\admin lacks service-control rights). Instead, on a successful
    // update we self-exit below, and NSSM (AppExit Default: Restart) relaunches
    // us with the new code, so the script doesn't need to outlive the parent.
    const child = isWin
      ? spawn(psExe, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", UPDATE_PS1], {
          cwd: repoRoot,
          env: { ...process.env, MYAGENS_INPANEL: "1" },
        })
      : spawn("bash", [UPDATE_SH], { cwd: repoRoot, detached: true });
    if (!isWin) child.unref();
    const handle = (buf: Buffer) => {
      for (const line of buf.toString().split("\n")) {
        if (line.length) {
          onLine(line);
          log.info(`[update] ${line}`);
        }
      }
    };
    child.stdout.on("data", handle);
    child.stderr.on("data", handle);
    child.on("error", (e) => {
      onLine(`Error: ${e.message}`);
      updating = false;
      resolve({ ok: false });
    });
    child.on("close", (code) => {
      updating = false;
      const ok = code === 0;
      onLine(ok ? "✓ Update complete." : `Update exited with code ${code}.`);
      resolve({ ok });
      // On Windows the script no longer restarts the service itself (the service
      // account can't), so trigger the relaunch here: restartService() exits the
      // process and NSSM/the task brings it back up with the freshly built code.
      // Unix already restarts inside the script, so skip it there.
      if (ok && isWin && serviceInstalled()) {
        onLine("Restarting to apply the update …");
        restartService();
      }
    });
  });
}
