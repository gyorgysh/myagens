import { config } from "../config.js";
import { memory } from "./memory.js";
import { listSkills, updateSkill } from "./skills.js";
import { log } from "../logger.js";

const BATCH_SIZE = 20;

export interface MaintenanceStats {
  lastRunAt?: number;
  memoriesCompacted: number;
  memoriesDeleted: number;
  memoriesMerged: number;
  /** Entries whose text the dedup pass rewrote into a clearer consolidated form. */
  memoriesRewritten: number;
  skillsArchived: number;
}

/** Pull the first JSON array out of a model reply (tolerates ```json fences / prose). */
function parseJsonArray<T>(raw: string): T[] | null {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

/** Make a direct Anthropic API call for lightweight dedup analysis. */
async function callHaiku(prompt: string): Promise<string | null> {
  const apiKey = config.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return data.content?.find((b) => b.type === "text")?.text ?? null;
  } catch {
    return null;
  }
}

class MaintenanceScheduler {
  private stats: MaintenanceStats = {
    memoriesCompacted: 0,
    memoriesDeleted: 0,
    memoriesMerged: 0,
    memoriesRewritten: 0,
    skillsArchived: 0,
  };
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  start(): void {
    if (this.timer || !config.MAINTENANCE_CRON) return;
    // Check every minute whether it's time to run.
    this.timer = setInterval(() => void this.checkAndRun(), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  view(): MaintenanceStats {
    return { ...this.stats };
  }

  async runOnce(): Promise<MaintenanceStats> {
    if (this.running) return this.view();
    this.running = true;
    log.info("Maintenance run starting");
    const run: MaintenanceStats = {
      memoriesCompacted: 0,
      memoriesDeleted: 0,
      memoriesMerged: 0,
      memoriesRewritten: 0,
      skillsArchived: 0,
    };
    try {
      await this.compactMemories(run);
      this.pruneSkills(run);
      run.lastRunAt = Date.now();
      this.stats = run;
      log.info("Maintenance run complete", run as unknown as Record<string, unknown>);
    } catch (err) {
      log.error("Maintenance run failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
    }
    return this.view();
  }

  private checkAndRun(): void {
    const spec = config.MAINTENANCE_CRON;
    if (!spec) return;
    const [hh, mm] = spec.split(":").map(Number);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return;
    const now = new Date();
    if (now.getHours() === hh && now.getMinutes() === mm) {
      // Only fire once per minute window.
      if (this.stats.lastRunAt && Date.now() - this.stats.lastRunAt < 90_000) return;
      void this.runOnce();
    }
  }

  private async compactMemories(run: MaintenanceStats): Promise<void> {
    const all = memory.allRaw();
    const counts = memory.countByTier();
    const total = counts.hot + counts.warm + counts.cold;

    // Step 1: demote lowest-salience warm entries to cold if over limit.
    if (total > config.MEMORY_MAX_ENTRIES) {
      const excess = total - config.MEMORY_MAX_ENTRIES;
      const warm = all
        .filter((e) => e.tier === "warm")
        .sort((a, b) => a.salience - b.salience);
      const toDemote = warm.slice(0, excess);
      for (const e of toDemote) {
        e.tier = "cold";
        run.memoriesCompacted++;
      }
      memory.replaceAll(all);
    }

    // Step 2: delete the coldest cold entries if still over COLD_MAX.
    const cold = all.filter((e) => e.tier === "cold");
    if (cold.length > config.COLD_MAX) {
      const toDelete = cold
        .sort((a, b) => a.salience - b.salience)
        .slice(0, cold.length - config.COLD_MAX);
      const deleteIds = new Set(toDelete.map((e) => e.id));
      memory.replaceAll(all.filter((e) => !deleteIds.has(e.id)));
      run.memoriesDeleted += deleteIds.size;
    }

    // Step 3: AI consolidation. Hot entries inject into every turn, so a few of
    // them saying the same thing in different words is pure wasted context;
    // collapse those first, then do the same for warm.
    await this.consolidateTier("hot", run);
    await this.consolidateTier("warm", run);
  }

  /**
   * Use a small model as the "brain" of maintenance: scan one tier for entries
   * that state the same fact (even worded differently or split across several
   * entries), rewrite each such group into one clear consolidated entry, and
   * drop the redundant ones. No-op when there is no API key or nothing to merge.
   */
  private async consolidateTier(tier: "hot" | "warm", run: MaintenanceStats): Promise<void> {
    const entries = memory.allRaw().filter((e) => e.tier === tier);
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      if (batch.length < 2) continue;
      const numbered = batch.map((e, idx) => `${idx + 1}. [${e.id}] ${e.text}`).join("\n");
      const prompt =
        `You are tidying an AI agent's long-term memory. Below are ${batch.length} "${tier}" memory ` +
        `entries (id in square brackets). Find groups that state the SAME fact, even if worded ` +
        `differently or spread across multiple entries. For each group, choose one id to keep, write a ` +
        `single clear consolidated version that preserves EVERY distinct detail, and list the other ids ` +
        `to drop. Leave genuinely distinct entries alone. Return ONLY a JSON array, no prose:\n` +
        `[{"keep":"<id>","text":"<consolidated text>","drop":["<id>",...]}]\n` +
        `If nothing should be merged, return [].\n\n${numbered}`;
      const raw = await callHaiku(prompt);
      if (!raw) continue;
      const groups = parseJsonArray<{ keep: string; text?: string; drop?: string[] }>(raw);
      if (!groups) continue;
      for (const g of groups) {
        const keep = memory.get(g.keep);
        if (!keep) continue;
        const drops = (Array.isArray(g.drop) ? g.drop : [])
          .map((id) => memory.get(id))
          .filter((e): e is NonNullable<typeof e> => Boolean(e) && e!.id !== g.keep);
        const newText = g.text?.trim() || keep.text;
        const rewritten = newText !== keep.text;
        if (drops.length === 0 && !rewritten) continue;
        // Fold the dropped entries' tags + salience into the kept one, then
        // rewrite its text to the consolidated version (which re-embeds it).
        memory.update(g.keep, {
          text: newText,
          tags: [...new Set([...keep.tags, ...drops.flatMap((d) => d.tags)])],
          salience: Math.max(keep.salience, ...drops.map((d) => d.salience)),
        });
        for (const d of drops) {
          memory.remove(d.id);
          run.memoriesMerged++;
        }
        if (rewritten) run.memoriesRewritten++;
      }
    }
  }

  private pruneSkills(run: MaintenanceStats): void {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    for (const skill of listSkills()) {
      if (!skill.archived && skill.useCount === 0 && skill.createdAt < cutoff) {
        updateSkill(skill.id, { archived: true });
        run.skillsArchived++;
        log.info("Skill auto-archived", { id: skill.id, name: skill.name });
      }
    }
  }
}

export const maintenance = new MaintenanceScheduler();
