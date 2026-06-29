import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { runTurn, AUTO_ALLOWED_TOOLS } from "../claude/runner.js";
import { memoryMcp } from "../mcp/memory.js";
import { workers } from "./workers.js";
import { getSkill } from "./skills.js";
import { getProvider } from "./providers.js";
import { resolveSecret } from "./vault.js";
import { embedBatch, cosineSimilarity } from "./embeddings.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";
import { config } from "../config.js";
import { log } from "../logger.js";

const COUNCIL_FILE = join(config.WORKDIR, "..", "council.jsonl");
const RULE_FILE = "councilRule.json";

/**
 * Quorum / decision rule for resolving a council vote (on the relevance-weighted
 * tallies):
 *  - `majority`      : weighted support strictly exceeds weighted oppose.
 *  - `supermajority` : weighted support ≥ 2/3 of the decisive (support+oppose) weight.
 *  - `unanimous`     : at least one supporter and zero opposers.
 */
export type CouncilRule = "majority" | "supermajority" | "unanimous";

interface CouncilRuleFile {
  version: 1;
  rule: CouncilRule;
}

/** The configured decision rule (defaults to simple majority). */
export function getCouncilRule(): CouncilRule {
  const f = loadJson<CouncilRuleFile>(RULE_FILE, { version: 1, rule: "majority" });
  return f.rule === "supermajority" || f.rule === "unanimous" ? f.rule : "majority";
}

/** Set the decision rule. Invalid values are ignored (rule unchanged). */
export function setCouncilRule(rule: CouncilRule): CouncilRule {
  if (rule !== "majority" && rule !== "supermajority" && rule !== "unanimous") {
    return getCouncilRule();
  }
  saveJson<CouncilRuleFile>(RULE_FILE, { version: 1, rule });
  audit("council.rule", { rule });
  return rule;
}

export interface CouncilVote {
  leadId: string;
  leadName: string;
  portfolio?: string;
  vote: "support" | "oppose" | "abstain";
  reason: string;
  concern: string;
  /**
   * Relevance of the proposal to this voter's domain (0..1). Used as the vote
   * weight. 1 when embeddings are unavailable (every voter counts equally).
   */
  relevance: number;
}

export interface CouncilSession {
  id: string;
  proposal: string;
  votes: CouncilVote[];
  supportCount: number;
  opposeCount: number;
  abstainCount: number;
  /** Relevance-weighted support total (sum of supporters' relevance). */
  weightedSupport: number;
  /** Relevance-weighted oppose total (sum of opposers' relevance). */
  weightedOppose: number;
  /** The decision rule applied to resolve this session. */
  rule: CouncilRule;
  /** Outcome under the rule: did the proposal pass? */
  passed: boolean;
  /** True when relevance weighting was active (embeddings produced scores). */
  weighted: boolean;
  createdAt: number;
  /** True when the vote was skipped due to insufficient council members (< 2). */
  noQuorum?: boolean;
}

/** Parse structured VOTE/REASON/CONCERN from a lead's free-form reply. */
function parseVote(text: string): Pick<CouncilVote, "vote" | "reason" | "concern"> {
  const voteMatch = /VOTE\s*:\s*(SUPPORT|OPPOSE|ABSTAIN)/i.exec(text);
  const reasonMatch = /REASON\s*:\s*(.+)/i.exec(text);
  const concernMatch = /CONCERN\s*:\s*(.+)/i.exec(text);

  const voteRaw = (voteMatch?.[1] ?? "").toUpperCase();
  const vote: CouncilVote["vote"] =
    voteRaw === "SUPPORT" ? "support" : voteRaw === "OPPOSE" ? "oppose" : "abstain";

  return {
    vote,
    reason: reasonMatch?.[1]?.trim() ?? "(no reason given)",
    concern: concernMatch?.[1]?.trim() ?? "(no concern stated)",
  };
}

/**
 * Compute a relevance score (0..1) for each voter against the proposal via
 * semantic similarity between the proposal and each voter's domain text. Cosine
 * similarity lands in roughly [-1, 1]; we clamp to [0, 1] so an off-topic Lead
 * simply counts for less, never negative. Returns `null` when embeddings are
 * off or the endpoint is unreachable, so the caller falls back to equal weight.
 */
async function computeRelevance(proposal: string, domains: string[]): Promise<number[] | null> {
  const vectors = await embedBatch([proposal, ...domains]);
  if (!vectors || vectors.length !== domains.length + 1) return null;
  const [proposalVec, ...domainVecs] = vectors;
  return domainVecs.map((v) => {
    const sim = cosineSimilarity(proposalVec, v);
    return Math.max(0, Math.min(1, sim));
  });
}

/** Run a single vote turn for one voter (lead or Atlas). */
async function castVote(
  voterId: string,
  voterName: string,
  _portfolio: string,
  prompt: string,
  cwd: string,
  model?: string,
  env?: Record<string, string | undefined>,
  systemPromptAppend?: string,
  persona?: string,
): Promise<Pick<CouncilVote, "vote" | "reason" | "concern">> {
  const abort = new AbortController();
  let output = "";
  try {
    await runTurn({
      prompt,
      cwd,
      model,
      env,
      systemPromptAppend,
      persona,
      permissionMode: "bypassPermissions",
      abortController: abort,
      mcpServers: { memory: memoryMcp },
      canUseTool: async (name, input) => {
        if (AUTO_ALLOWED_TOOLS.has(name)) return { behavior: "allow", updatedInput: input };
        return { behavior: "deny", message: "Council vote is read-only." };
      },
      onText: (delta) => { output += delta; },
      onToolUse: () => {},
      onSessionId: () => {},
    });
  } catch (err) {
    log.warn("Council vote failed", { voter: voterName, voterId, error: err instanceof Error ? err.message : String(err) });
    return { vote: "abstain", reason: "Error during vote.", concern: "Could not complete the council turn." };
  }
  return parseVote(output);
}

/**
 * Run a council vote on a proposal. Atlas always votes as the main
 * coordinator. Each enabled Lead worker votes from its domain perspective.
 * Requires at least 2 voters (Atlas + 1 Lead); returns noQuorum when no
 * leads are enabled.
 */
export async function runCouncil(proposal: string): Promise<CouncilSession> {
  const leads = workers.list().filter((w) => w.role === "lead" && w.enabled);
  const atlasName = config.ATLAS_NAME;

  // Quorum: need Atlas + at least one Lead (minimum 2 voters).
  if (leads.length === 0) {
    const session: CouncilSession = {
      id: randomBytes(4).toString("hex"),
      proposal,
      votes: [],
      supportCount: 0,
      opposeCount: 0,
      abstainCount: 0,
      weightedSupport: 0,
      weightedOppose: 0,
      rule: getCouncilRule(),
      passed: false,
      weighted: false,
      createdAt: Date.now(),
      noQuorum: true,
    };
    persistSession(session);
    return session;
  }

  // Relevance weighting: embed the proposal against each voter's domain text so
  // a Lead whose portfolio is closer to the topic carries more weight. Atlas
  // sits first (cross-domain "Strategy"), then each Lead in order.
  const domainTexts = [
    "Strategy: cross-domain coordination and overall direction.",
    ...leads.map((lead) => {
      const skill = lead.skillId ? getSkill(lead.skillId) : undefined;
      return [lead.portfolio ?? "General", skill?.prompt, lead.systemPrompt].filter(Boolean).join("\n\n");
    }),
  ];
  const relevance = await computeRelevance(proposal, domainTexts);
  const weighted = relevance !== null;
  const relAt = (i: number): number => relevance?.[i] ?? 1;

  // Build all vote promises — Atlas first, then each Lead in parallel.
  const atlasPrompt =
    `You are ${atlasName}, the central AI coordinator and main agent.\n\n` +
    `The President is putting this proposal to a council vote:\n\n` +
    `"${proposal}"\n\n` +
    `Evaluate it from a strategic, cross-domain perspective as the main coordinator who oversees the full team.\n\n` +
    `Reply in EXACTLY this format (no other text, no preamble):\n` +
    `VOTE: SUPPORT\n` +
    `REASON: [one sentence — strategic case for or against]\n` +
    `CONCERN: [one sentence — biggest cross-cutting risk or caveat]\n\n` +
    `or replace SUPPORT with OPPOSE or ABSTAIN.`;

  log.info("Council vote starting", { voter: atlasName, voterId: "atlas", model: config.CLAUDE_MODEL });
  const atlasVotePromise = castVote("atlas", atlasName, "Strategy", atlasPrompt, config.WORKDIR).then(
    (parsed): CouncilVote => ({ leadId: "atlas", leadName: atlasName, portfolio: "Strategy", relevance: relAt(0), ...parsed }),
  );

  const leadVotePromises = leads.map(async (lead, idx): Promise<CouncilVote> => {
    const skill = lead.skillId ? getSkill(lead.skillId) : undefined;
    const domainContext = [skill?.prompt, lead.systemPrompt].filter(Boolean).join("\n\n") || undefined;
    const provider = lead.providerId ? getProvider(lead.providerId) : undefined;
    const env = provider
      ? {
          ANTHROPIC_BASE_URL: provider.baseUrl,
          ANTHROPIC_AUTH_TOKEN: resolveSecret(provider.authToken),
          ANTHROPIC_API_KEY: undefined,
        }
      : undefined;

    const portfolio = lead.portfolio ?? "General";
    const prompt =
      `You are ${lead.name}, the ${portfolio} Lead.\n\n` +
      `The President is putting this proposal to a council vote:\n\n` +
      `"${proposal}"\n\n` +
      `Evaluate it strictly from the ${portfolio} domain perspective.\n\n` +
      `Reply in EXACTLY this format (no other text, no preamble):\n` +
      `VOTE: SUPPORT\n` +
      `REASON: [one sentence — why this benefits ${portfolio}]\n` +
      `CONCERN: [one sentence — biggest risk or caveat from ${portfolio} angle]\n\n` +
      `or replace SUPPORT with OPPOSE or ABSTAIN.`;

    log.info("Council vote starting", { lead: lead.name, leadId: lead.id, model: lead.model ?? config.CLAUDE_MODEL });
    const parsed = await castVote(lead.id, lead.name, portfolio, prompt, lead.cwd || config.WORKDIR, lead.model, env, domainContext, lead.persona);
    return { leadId: lead.id, leadName: lead.name, portfolio: lead.portfolio, relevance: relAt(idx + 1), ...parsed };
  });

  const votes = await Promise.all([atlasVotePromise, ...leadVotePromises]);

  const weightedSupport = votes.filter((v) => v.vote === "support").reduce((s, v) => s + v.relevance, 0);
  const weightedOppose = votes.filter((v) => v.vote === "oppose").reduce((s, v) => s + v.relevance, 0);
  const rule = getCouncilRule();

  const session: CouncilSession = {
    id: randomBytes(4).toString("hex"),
    proposal,
    votes,
    supportCount: votes.filter((v) => v.vote === "support").length,
    opposeCount: votes.filter((v) => v.vote === "oppose").length,
    abstainCount: votes.filter((v) => v.vote === "abstain").length,
    weightedSupport,
    weightedOppose,
    rule,
    passed: resolveOutcome(rule, weightedSupport, weightedOppose),
    weighted,
    createdAt: Date.now(),
  };

  persistSession(session);
  log.info("Council vote complete", {
    id: session.id,
    support: session.supportCount,
    oppose: session.opposeCount,
    rule,
    passed: session.passed,
  });
  return session;
}

/**
 * Resolve a council outcome from the relevance-weighted support/oppose totals
 * under the chosen rule. Decisive weight is support+oppose (abstains excluded).
 */
function resolveOutcome(rule: CouncilRule, support: number, oppose: number): boolean {
  const decisive = support + oppose;
  if (decisive <= 0) return false; // all abstained — nothing to pass
  switch (rule) {
    case "unanimous":
      return support > 0 && oppose === 0;
    case "supermajority":
      return support >= (2 / 3) * decisive;
    case "majority":
    default:
      return support > oppose;
  }
}

function persistSession(session: CouncilSession): void {
  try {
    mkdirSync(dirname(COUNCIL_FILE), { recursive: true });
    appendFileSync(COUNCIL_FILE, JSON.stringify(session) + "\n");
  } catch (err) {
    log.warn("Failed to persist council session", { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Remove a single council session by id from the JSONL file. Returns true if
 *  a matching entry was found and deleted, false if not found or file missing. */
export function deleteCouncilSession(id: string): boolean {
  if (!existsSync(COUNCIL_FILE)) return false;
  try {
    const raw = readFileSync(COUNCIL_FILE, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const next = lines.filter((l) => {
      try { return (JSON.parse(l) as CouncilSession).id !== id; }
      catch { return true; }
    });
    if (next.length === lines.length) return false;
    writeFileSync(COUNCIL_FILE, next.length ? next.join("\n") + "\n" : "");
    return true;
  } catch (err) {
    log.warn("Failed to delete council session", { id, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Format a council session for Telegram. */
export function formatCouncilTelegram(s: CouncilSession): string {
  if (s.noQuorum) {
    return (
      `🗳 **Council vote** on: _${s.proposal}_\n\n` +
      `⚠️ No quorum — not enough council members.\n` +
      `Add at least one enabled Lead in the Agents view to hold a vote.`
    );
  }

  const total = s.votes.length;
  // Headline reflects the configured rule's outcome (on weighted tallies), with
  // the raw head-count in parentheses so both views are visible.
  const ruleLabel =
    s.rule === "supermajority" ? "supermajority ⅔" : s.rule === "unanimous" ? "unanimous" : "majority";
  const result =
    total === 0
      ? "No votes cast."
      : s.passed
      ? `✅ PASSES (${ruleLabel}, ${s.supportCount}–${s.opposeCount})`
      : `❌ FAILS (${ruleLabel}, ${s.supportCount}–${s.opposeCount})`;

  const lines: string[] = [
    `🗳 **Council vote** on: _${s.proposal}_`,
    ``,
    result,
  ];
  if (s.weighted) {
    lines.push(`⚖️ weighted ${s.weightedSupport.toFixed(2)}–${s.weightedOppose.toFixed(2)} (by domain relevance)`);
  }
  lines.push(``);

  for (const v of s.votes) {
    const icon = v.vote === "support" ? "✅" : v.vote === "oppose" ? "❌" : "⬜";
    const rel = s.weighted ? ` · ${Math.round(v.relevance * 100)}% relevant` : "";
    lines.push(`${icon} **${v.leadName}**${v.portfolio ? ` (${v.portfolio})` : ""}${rel}`);
    lines.push(`→ ${v.reason}`);
    lines.push(`⚠ ${v.concern}`);
    lines.push(``);
  }

  return lines.join("\n").trim();
}
