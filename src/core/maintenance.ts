import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { memory, type MemoryEntry } from "./memory.js";
import { listSkills, updateSkill } from "./skills.js";
import { isResult, type SdkMessage } from "../claude/events.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { parseWhen, nextRun } from "../schedule/manager.js";
import { log } from "../logger.js";

const BATCH_SIZE = 20;
const STORE_FILE = "maintenance.json";
/** Interval-mode cadence: run once last run was this long ago (24h). */
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Guard so an HH:MM clock match can't double-fire (must be < 24h). */
const MIN_RUN_GAP_MS = 23 * 60 * 60 * 1000;

export interface MaintenanceStats {
  lastRunAt?: number;
  /** When the next scheduled run is due (from MAINTENANCE_CRON); computed, not persisted. */
  nextRunAt?: number;
  memoriesCompacted: number;
  memoriesDeleted: number;
  memoriesMerged: number;
  /** Entries whose text the dedup pass rewrote into a clearer consolidated form. */
  memoriesRewritten: number;
  /** Verbose entries the shorten pass condensed into a terse one-liner. */
  memoriesShortened: number;
  skillsArchived: number;
}

/** A memory entry as shown in a preview (no embedding vector). */
export type PreviewEntry = Omit<MemoryEntry, "embedding" | "embeddingModel">;

/**
 * Dry-run result of the deterministic compaction steps (salience thresholds),
 * computed without committing any change. Only the deterministic passes are
 * previewable; the AI consolidation/shortening steps depend on a live model
 * call and can't be predicted ahead of time.
 */
export interface MaintenancePreview {
  /** Cold-overflow entries that an actual run would delete (lowest salience first). */
  toDelete: PreviewEntry[];
  /** Warm entries an actual run would demote to cold (over the entry cap). */
  toDemote: PreviewEntry[];
  /**
   * Deterministic merges. Always empty for now — merging is AI-driven, so it
   * can't be previewed — but kept in the shape so the panel can render it if a
   * deterministic merge step is ever added.
   */
  toMerge: { kept: PreviewEntry; dropped: PreviewEntry[] }[];
}

/** Strip the bulky embedding fields so a preview stays lightweight over the wire. */
function toPreviewEntry(e: MemoryEntry): PreviewEntry {
  const { embedding: _embedding, embeddingModel: _embeddingModel, ...rest } = e;
  return rest;
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

/**
 * Run a lightweight Haiku prompt for dedup analysis through the Agent SDK, so it
 * uses the same Claude connection as the rest of the bot (a CLI subscription
 * login or `ANTHROPIC_API_KEY`, whichever is configured) instead of needing a
 * separate API key. No tools, no project context: just a one-shot text reply.
 */
async function callHaiku(prompt: string): Promise<string | null> {
  try {
    const response = query({
      prompt,
      options: {
        model: "claude-haiku-4-5-20251001",
        systemPrompt: "You tidy an AI agent's long-term memory. Reply with ONLY the requested JSON array, no prose.",
        maxTurns: 1,
        permissionMode: "bypassPermissions",
      },
    }) as unknown as AsyncIterable<SdkMessage>;
    let out: string | null = null;
    for await (const msg of response) {
      if (isResult(msg) && msg.result) out = msg.result;
    }
    return out;
  } catch (err) {
    log.debug("Maintenance model call failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

class MaintenanceScheduler {
  // Loaded from disk so "last run" survives restarts; persisted after each run.
  private stats: MaintenanceStats = loadJson<MaintenanceStats>(STORE_FILE, {
    memoriesCompacted: 0,
    memoriesDeleted: 0,
    memoriesMerged: 0,
    memoriesRewritten: 0,
    memoriesShortened: 0,
    skillsArchived: 0,
  });
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  start(): void {
    if (this.timer || this.mode() === "off") return;
    // Check every minute whether it's time to run; the per-mode gate below keeps
    // an actual run to at most once a day. A long-overdue run catches up on the
    // first tick rather than waiting for the wall clock.
    this.timer = setInterval(() => void this.checkAndRun(), 60_000);
    this.timer.unref?.();
    void this.checkAndRun();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Resolve the configured schedule into a mode:
   * - "off": explicitly disabled (MAINTENANCE_CRON=off).
   * - "cron": a valid "HH:MM" daily clock time.
   * - "interval": anything else, including unset — run every 24h (catch-up).
   */
  private mode(): "off" | "cron" | "interval" {
    const spec = config.MAINTENANCE_CRON?.trim();
    if (spec && spec.toLowerCase() === "off") return "off";
    if (spec && /^\d{1,2}:\d{2}$/.test(spec) && parseWhen(spec)) return "cron";
    return "interval";
  }

  /** Next due time, or undefined when disabled. */
  private computeNextRun(): number | undefined {
    const mode = this.mode();
    if (mode === "off") return undefined;
    if (mode === "cron") {
      const spec = parseWhen(config.MAINTENANCE_CRON!.trim());
      return spec ? nextRun(spec, Date.now()) : undefined;
    }
    // Interval mode: 24h after the last run (or now, if it's never run).
    return (this.stats.lastRunAt ?? Date.now()) + MAINTENANCE_INTERVAL_MS;
  }

  view(): MaintenanceStats {
    return { ...this.stats, nextRunAt: this.computeNextRun() };
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
      memoriesShortened: 0,
      skillsArchived: 0,
    };
    try {
      await this.compactMemories(run);
      this.pruneSkills(run);
      run.lastRunAt = Date.now();
      this.stats = run;
      saveJson(STORE_FILE, run); // cache last-run time + counts across restarts
      log.info("Maintenance run complete", run as unknown as Record<string, unknown>);
    } catch (err) {
      log.error("Maintenance run failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
    }
    return this.view();
  }

  /**
   * Dry-run the deterministic compaction steps (the salience-threshold passes)
   * and report what an actual run would delete or demote, without committing
   * anything. Pure reads over the live store — no entry is mutated. The AI
   * consolidation/shortening passes are intentionally excluded: they depend on
   * a live model call and can't be predicted here.
   */
  previewCompaction(): MaintenancePreview {
    const all = memory.allRaw();
    const counts = memory.countByTier();
    const total = counts.hot + counts.warm + counts.cold;

    // Step 1 (demote): warm entries the cap would push to cold, lowest salience first.
    const toDemote: MemoryEntry[] = [];
    const demotedIds = new Set<string>();
    if (total > config.MEMORY_MAX_ENTRIES) {
      const excess = total - config.MEMORY_MAX_ENTRIES;
      const warm = all
        .filter((e) => e.tier === "warm")
        .sort((a, b) => a.salience - b.salience);
      for (const e of warm.slice(0, excess)) {
        toDemote.push(e);
        demotedIds.add(e.id);
      }
    }

    // Step 2 (delete): cold entries over COLD_MAX, lowest salience first. The
    // real run deletes after demoting, so a just-demoted warm entry counts as
    // cold for the overflow check here too.
    const cold = all.filter((e) => e.tier === "cold" || demotedIds.has(e.id));
    const toDelete: MemoryEntry[] = [];
    if (cold.length > config.COLD_MAX) {
      const sorted = [...cold].sort((a, b) => a.salience - b.salience);
      toDelete.push(...sorted.slice(0, cold.length - config.COLD_MAX));
    }

    const deleteIds = new Set(toDelete.map((e) => e.id));
    return {
      toDelete: toDelete.map(toPreviewEntry),
      // An entry both demoted and then deleted is reported only as a deletion.
      toDemote: toDemote.filter((e) => !deleteIds.has(e.id)).map(toPreviewEntry),
      toMerge: [],
    };
  }

  private checkAndRun(): void {
    if (this.running) return;
    const mode = this.mode();
    if (mode === "off") return;

    const last = this.stats.lastRunAt ?? 0;
    if (mode === "interval") {
      // Run whenever the last run was a full interval (24h) ago — or never.
      if (Date.now() - last >= MAINTENANCE_INTERVAL_MS) void this.runOnce();
      return;
    }

    // Cron mode: fire at the configured HH:MM, guarded so a clock match in the
    // same day can't double-fire after a recent run.
    const spec = config.MAINTENANCE_CRON!.trim();
    const [hh, mm] = spec.split(":").map(Number);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return;
    const now = new Date();
    if (now.getHours() === hh && now.getMinutes() === mm) {
      if (Date.now() - last < MIN_RUN_GAP_MS) return;
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

    // Step 4: shorten verbose entries into terse one-liners. The priority is
    // HOT — it injects into every turn, so its context cost is paid constantly;
    // shorten it past the lower hot threshold. WARM only costs context when it's
    // actually recalled, so leave it alone unless it's genuinely bloated (the
    // higher warm threshold). COLD is panel-only and never shortened.
    await this.shortenVerbose("hot", run);
    await this.shortenVerbose("warm", run);
  }

  /**
   * Rewrite any entry longer than the tier's shorten threshold into one terse
   * sentence that keeps the meaning, dropping filler and play-by-play detail.
   * Keeps recall context small over time even when the agent saved a wordy
   * entry. Hot uses a lower threshold (MEMORY_SHORTEN_CHARS_HOT) since it's the
   * priority — paid for on every turn; warm uses the higher MEMORY_SHORTEN_CHARS.
   */
  private async shortenVerbose(tier: "hot" | "warm", run: MaintenanceStats): Promise<void> {
    const warmLimit = config.MEMORY_SHORTEN_CHARS;
    if (warmLimit <= 0) return;
    // Hot is the priority: trim it past the lower threshold (falling back to the
    // warm one when unset). Warm uses the higher threshold as before.
    const limit =
      tier === "hot" ? config.MEMORY_SHORTEN_CHARS_HOT || warmLimit : warmLimit;
    const verbose = memory
      .allRaw()
      .filter((e) => e.tier === tier && e.text.length > limit);
    for (let i = 0; i < verbose.length; i += BATCH_SIZE) {
      const batch = verbose.slice(i, i + BATCH_SIZE);
      const numbered = batch.map((e) => `[${e.id}] ${e.text}`).join("\n");
      const prompt =
        `You are tidying an AI agent's long-term memory. Each line below is a memory ` +
        `entry (id in square brackets) that is too long. Rewrite EACH into ONE terse ` +
        `sentence under ${limit} characters that preserves every distinct fact while ` +
        `dropping filler, long file lists, and play-by-play detail. Keep ids, paths, and ` +
        `identifiers that matter. Return ONLY a JSON array, no prose:\n` +
        `[{"id":"<id>","text":"<shortened text>"}]\n\n${numbered}`;
      const raw = await callHaiku(prompt);
      if (!raw) continue;
      const items = parseJsonArray<{ id: string; text?: string }>(raw);
      if (!items) continue;
      for (const it of items) {
        const entry = memory.get(it.id);
        const newText = it.text?.trim();
        // Only accept a genuine shortening that didn't blow up or go empty.
        if (!entry || !newText || newText === entry.text || newText.length >= entry.text.length) continue;
        memory.update(it.id, { text: newText });
        run.memoriesShortened++;
      }
    }
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
