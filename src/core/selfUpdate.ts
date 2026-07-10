import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { repoRoot } from "../config.js";
import { log } from "../logger.js";
import { audit } from "./audit.js";
import { whenSettled } from "./activity.js";
import { serviceInstalled, restartService } from "./agentControl.js";
import { writeUpdateMarker } from "./updateControl.js";

const pexec = promisify(execFile);

type Notify = (text: string) => Promise<void> | void;

export interface SelfUpdateState {
  status: "idle" | "queued" | "building" | "restarting" | "error";
  summary?: string;
  error?: string;
  at?: number;
}

/**
 * Lets the agent ship its own source edits to the live bot. The agent calls the
 * self_update MCP tool when it has finished editing THIS project's source; we
 * then, once every run is idle (so a running task is never recompiled), rebuild
 * the project and — if the build passes and a service is installed — restart so
 * the changes take effect. The build is the gate: a broken build is reported to
 * the user and the bot is NOT restarted, so a bad edit can't brick it.
 */
class SelfUpdateManager {
  private notify: Notify = () => {};
  private queued = false;
  private state: SelfUpdateState = { status: "idle" };

  start(notify: Notify): void {
    this.notify = notify;
  }

  getState(): SelfUpdateState {
    return this.state;
  }

  /** Queue a build+restart. Deferred until idle, build-gated, reported to the user. */
  request(summary: string): { ok: boolean; message: string } {
    if (this.queued) {
      return { ok: false, message: "A self-update is already queued." };
    }
    this.queued = true;
    this.state = { status: "queued", summary, at: Date.now() };
    audit("selfUpdate.queue", { summary: summary.slice(0, 200) });
    log.warn("Self-update queued; will build + restart once idle", { summary });
    void this.run(summary);
    return {
      ok: true,
      message:
        "Queued. Once this task finishes I'll rebuild and, if the build passes, " +
        "restart to apply the changes. If the build fails I won't restart.",
    };
  }

  private async run(summary: string): Promise<void> {
    try {
      // Wait for the calling task — including its post-stream tail (quote/summary
      // edits + reflect/memory pass, tracked by the session.busy idle gate) — to
      // finish before we touch anything, so nothing is recompiled mid-task.
      await whenSettled();

      const stat = await this.diffStat();
      this.state = { status: "building", summary, at: Date.now() };
      const build = await this.build();

      if (!build.ok) {
        this.state = { status: "error", summary, error: build.tail, at: Date.now() };
        this.queued = false;
        audit("selfUpdate.buildFailed", {});
        log.error("Self-update build failed; not restarting");
        await this.notify(
          truncate(
            `🛠 Self-update aborted — build failed, NOT restarting.\n\n${summary}\n\n` +
              `Build output:\n${build.tail}`,
          ),
        );
        return;
      }

      // Build is green. Don't restart on top of a task (or its post-stream tail)
      // that started while we were building.
      await whenSettled();
      const serviced = serviceInstalled();
      audit("selfUpdate.applied", { serviced });
      this.queued = false;
      await this.notify(
        truncate(
          `✅ Self-update built successfully` +
            (serviced ? " — restarting now to apply." : " — restart manually to apply (no service installed).") +
            `\n\n${summary}` +
            (stat ? `\n\nChanges:\n${stat}` : ""),
        ),
      );
      if (serviced) {
        this.state = { status: "restarting", summary, at: Date.now() };
        // Lets the freshly booted process confirm "back online" to the user.
        writeUpdateMarker("self-update");
        restartService();
      } else {
        this.state = { status: "idle", summary, at: Date.now() };
      }
    } catch (err) {
      this.queued = false;
      const message = err instanceof Error ? err.message : String(err);
      this.state = { status: "error", summary, error: message, at: Date.now() };
      log.error("Self-update failed", { error: message });
      await this.notify(`🛠 Self-update failed: ${message}`);
    }
  }

  /** A compact summary of working-tree changes vs HEAD, for the report. */
  private async diffStat(): Promise<string> {
    try {
      const r = await pexec("git", ["diff", "--stat", "HEAD"], { cwd: repoRoot });
      return r.stdout.trim().split("\n").slice(0, 30).join("\n");
    } catch {
      return "";
    }
  }

  /** Run `npm run build`, resolving with success + a tail of the output. */
  private build(): Promise<{ ok: boolean; tail: string }> {
    return new Promise((resolve) => {
      const out: string[] = [];
      // Use npm.cmd on Windows — bare "npm" fails with ENOENT in a service
      // environment since npm ships as a .cmd shim, not a plain executable.
      const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
      const child = spawn(npmCmd, ["run", "build"], { cwd: repoRoot });
      const onData = (b: Buffer) => {
        for (const line of b.toString().split("\n")) if (line.trim()) out.push(line);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (e) => resolve({ ok: false, tail: e.message }));
      child.on("close", (code) => resolve({ ok: code === 0, tail: out.slice(-25).join("\n") }));
    });
  }
}

function truncate(text: string): string {
  return text.length > 3500 ? `${text.slice(0, 3500)}…` : text;
}

export const selfUpdate = new SelfUpdateManager();
