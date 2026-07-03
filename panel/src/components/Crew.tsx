import { useEffect, useState, type ReactNode } from "react";
import { Send, MessageCircle } from "lucide-react";
import { api, AuthError, type Worker, type MainAgent, type DelegationRecord, type CouncilRule } from "../api.ts";
import { Card, Empty, Badge, InfoCard, Skeleton, Avatar } from "./ui.tsx";
import { CrewArt } from "./onboarding.tsx";
import { relTime } from "../lib/format.ts";
import { useI18n } from "../lib/useI18n.ts";
import { errorMessage } from "../lib/errorMessage.ts";
import type { TranslationKey } from "../i18n/en.ts";
import { useSubscription } from "../lib/useSubscription.ts";
import { roleLabel } from "../lib/agentRole.ts";

interface CouncilVote {
  leadId: string;
  leadName: string;
  portfolio?: string;
  vote: "support" | "oppose" | "abstain";
  reason: string;
  concern: string;
  /** Domain relevance weight (0..1); absent on legacy sessions. */
  relevance?: number;
}

interface CouncilSession {
  id: string;
  proposal: string;
  votes: CouncilVote[];
  supportCount: number;
  opposeCount: number;
  abstainCount: number;
  /** Relevance-weighted tallies + rule outcome (absent on legacy sessions). */
  weightedSupport?: number;
  weightedOppose?: number;
  rule?: CouncilRule;
  passed?: boolean;
  weighted?: boolean;
  createdAt: number;
  noQuorum?: boolean;
}

export function CrewView({
  onAuthError,
  onChat,
}: {
  onAuthError: () => void;
  /** Jump to the panel Chat view with this agent selected. Absent when web
   *  chat is disabled, in which case no "Web Chat" badge is shown. */
  onChat?: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const [atlas, setAtlas] = useState<MainAgent | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [delegations, setDelegations] = useState<DelegationRecord[]>([]);
  const [council, setCouncil] = useState<CouncilSession[]>([]);
  const [councilRule, setCouncilRuleState] = useState<CouncilRule>("majority");
  const [proposal, setProposal] = useState("");
  const [voting, setVoting] = useState(false);
  const [voteElapsed, setVoteElapsed] = useState(0);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      api.agent(),
      api.workers(),
      api.delegations(30),
      api.council(20),
      api.councilRule(),
    ])
      .then(([a, w, d, c, r]) => {
        setAtlas(a);
        setWorkers(w.workers);
        setDelegations(d.delegations);
        setCouncil(c.sessions as unknown as CouncilSession[]);
        setCouncilRuleState(r.rule);
      })
      .catch((e) => {
        if (e instanceof AuthError) return onAuthError();
        setError(errorMessage(e, t));
      })
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While a vote is in flight the request blocks until every Lead + Atlas has
  // answered (each is a one-shot model call), so tick an elapsed counter to make
  // it obvious work is happening and the panel hasn't frozen.
  useEffect(() => {
    if (!voting) return;
    const started = Date.now();
    setVoteElapsed(0);
    const timer = setInterval(() => setVoteElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [voting]);

  if (error) return <Empty>Failed to load: {error}</Empty>;

  const leads = workers.filter((w) => w.role === "lead");
  const assistants = workers.filter((w) => w.role === "assistant");
  const specialists = workers.filter(
    (w) => !w.role || (w.role !== "lead" && w.role !== "assistant"),
  );

  // Resolve a delegation-log agent id to a display name. "president"/"atlas" are
  // literals; a worker id resolves to its name; a name string is matched
  // case-insensitively (crew_delegate stores the resolved name as toAgentId);
  // a since-deleted worker falls back to the id itself so the record still reads.
  const resolveAgent = (id: string | undefined, hint?: string): string => {
    if (!id) return hint ?? t("crew_unknown_agent");
    const low = id.toLowerCase();
    if (low === "president" || low === "user") return t("crew_president");
    if (low === "atlas") return "Atlas";
    const byId = workers.find((x) => x.id === id);
    if (byId) return byId.name;
    const byName = workers.find((x) => x.name.toLowerCase() === low);
    if (byName) return byName.name;
    // Fall back to the hint (leadName) when available, otherwise show the raw id.
    return hint ?? id;
  };

  const enabledLeads = leads.filter((w) => w.enabled).length;

  const runVote = async () => {
    const text = proposal.trim();
    if (!text || voting) return;
    setVoting(true);
    setVoteError(null);
    try {
      const { session } = await api.runCouncil(text);
      setCouncil((prev) => [session as unknown as CouncilSession, ...prev]);
      setProposal("");
    } catch (e) {
      setVoteError(errorMessage(e, t));
    } finally {
      setVoting(false);
    }
  };

  return (
    <div className="space-y-6 [--crew-indent:14px] sm:[--crew-indent:24px]">
      <div>
        <h1 className="text-lg font-semibold text-fg">{t("crew_title")}</h1>
        <p className="mt-1 text-sm text-fg-dim">{t("crew_subtitle")}</p>
      </div>

      <InfoCard
        id="crew"
        title={t("crew_how_show")}
        openTitle={t("crew_how_title")}
      >
        <p>{t("crew_how_intro")}</p>
        {([
          [t("crew_how_wizard_title"), t("crew_how_wizard")],
          [t("crew_how_tasks_title"), t("crew_how_tasks")],
          [t("crew_how_runs_title"), t("crew_how_runs")],
        ] as Array<[string, string]>).map(([title, body]) => (
          <div key={title}>
            <div className="font-medium text-fg">{title}</div>
            <p className="mt-0.5">{body}</p>
          </div>
        ))}
      </InfoCard>

      {/* President — always present; dimmed as a structural placeholder until
          the fleet data loads so the hierarchy shape shows immediately. */}
      <CrewNode
        icon="★"
        title={t("crew_president")}
        role={t("crew_role_president")}
        subtitle={t("crew_president_sub")}
        tone="amber"
        depth={0}
        dimmed={!loaded}
      />

      {/* Atlas — the main bot is always reachable on Telegram */}
      <CrewNode
        icon="◈"
        avatarId="atlas"
        avatar="robot"
        title="Atlas"
        role={t("crew_role_coordinator")}
        subtitle={`${t("crew_atlas_sub")} · ${atlas?.effectiveModel ?? "…"}`}
        tone="accent"
        depth={1}
        dimmed={!loaded}
        extra={t("crew_listening")}
        extraHref={atlas?.botUsername ? `https://t.me/${atlas.botUsername}` : undefined}
        onWebChat={onChat ? () => onChat("atlas") : undefined}
      />

      {/* A couple of Lead skeleton cards below the (dimmed) President + Atlas,
          so the grid shape is previewed while the initial fetch is in flight. */}
      {!loaded && (
        <div
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
          style={{ marginLeft: "calc(2 * var(--crew-indent))" }}
        >
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-line bg-surface p-3.5">
              <div className="flex items-center gap-3">
                <Skeleton className="h-12 w-12 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </div>
              <Skeleton className="mt-3 h-3 w-full" />
              <Skeleton className="mt-3 h-6 w-20" />
            </div>
          ))}
        </div>
      )}

      {/* Leads and their Assistants */}
      {leads.length > 0 && (
        <div
          className="text-xs font-medium uppercase tracking-wider text-fg-faint pl-3"
          style={{ marginLeft: "calc(2 * var(--crew-indent))" }}
        >
          {t("crew_leads_count")
            .replace("{total}", String(leads.length))
            .replace("{active}", String(enabledLeads))}
        </div>
      )}
      {leads.length > 0 && (
        <div
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
          style={{ marginLeft: "calc(2 * var(--crew-indent))" }}
        >
          {leads.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              assistants={assistants.filter((a) => a.parentId === lead.id)}
              onWebChat={onChat ? () => onChat(lead.id) : undefined}
            />
          ))}
        </div>
      )}

      {/* Unparented assistants */}
      {assistants
        .filter((a) => !a.parentId || !leads.find((l) => l.id === a.parentId))
        .map((a) => (
          <CrewNode
            key={a.id}
            icon="◇"
            avatarId={a.id}
            avatar={a.avatar}
            title={a.name}
            role={a.portfolio || t("crew_role_assistant")}
            subtitle={a.model || t("crew_default_model")}
            tone="zinc"
            depth={2}
            paused={!a.enabled}
            escalated={a.escalated}
          />
        ))}

      {/* Specialists */}
      {specialists.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wider text-fg-faint">
            {t("crew_specialists")}
          </div>
          {specialists.map((w) => (
            <CrewNode
              key={w.id}
              icon="·"
              avatarId={w.id}
              avatar={w.avatar}
              title={w.name}
              role={w.portfolio || t("crew_role_specialist")}
              subtitle={w.model || t("crew_default_model")}
              tone="zinc"
              depth={2}
              paused={!w.enabled}
              escalated={w.escalated}
            />
          ))}
        </div>
      )}

      {/* Council vote log */}
      <Card title={t("crew_council")}>
        <p className="mb-3 text-sm text-fg-dim">{t("crew_council_desc")}</p>

        {/* Decision rule selector */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-fg-dim">{t("crew_council_rule")}</span>
          <div className="inline-flex overflow-hidden rounded-lg border border-line">
            {(["majority", "supermajority", "unanimous"] as CouncilRule[]).map((r) => (
              <button
                key={r}
                onClick={() => {
                  if (r === councilRule) return;
                  setCouncilRuleState(r);
                  void api.setCouncilRule(r).catch((e) => setError(errorMessage(e, t)));
                }}
                className={`px-3 py-1 text-xs font-medium transition ${
                  councilRule === r ? "bg-accent text-white" : "bg-surface text-fg-dim hover:text-fg"
                }`}
              >
                {t(`crew_council_rule_${r}` as TranslationKey)}
              </button>
            ))}
          </div>
        </div>
        <p className="mb-3 text-xs text-fg-faint">{t(`crew_council_rule_${councilRule}_hint` as TranslationKey)}</p>

        {/* Trigger a new vote */}
        <div className="mb-4 rounded-lg border border-accent/30 bg-accent/5 p-3">
          <textarea
            value={proposal}
            onChange={(e) => setProposal(e.target.value)}
            placeholder={t("crew_council_placeholder")}
            rows={3}
            disabled={voting}
            className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none disabled:opacity-60"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-xs text-fg-dim">
              {enabledLeads === 0
                ? t("crew_council_no_leads")
                : t("crew_council_lead_count").replace("{n}", String(enabledLeads + 1))}
            </span>
            <button
              onClick={runVote}
              disabled={voting || !proposal.trim() || enabledLeads === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {voting && (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              )}
              {voting ? t("crew_council_voting") : t("crew_council_call")}
            </button>
          </div>
          {voting && (
            <div className="mt-3 flex items-start gap-3 rounded-lg border border-accent/30 bg-accent/10 p-3">
              <span className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">
                  {t("crew_council_voting_title").replace("{n}", String(enabledLeads + 1))}
                </p>
                <p className="mt-0.5 text-xs text-fg-dim">
                  {t("crew_council_voting_hint")}
                  {voteElapsed > 0 && (
                    <span className="ml-1 tabular-nums text-fg-faint">
                      {t("crew_council_voting_elapsed").replace("{s}", String(voteElapsed))}
                    </span>
                  )}
                </p>
              </div>
            </div>
          )}
          {voteError && (
            <p className="mt-2 text-xs text-critical-fg">{voteError}</p>
          )}
        </div>

        {council.length === 0 ? (
          <Empty icon={<CrewArt />} title={t("crew_council_empty")}>
            {t("crew_council_empty_desc")}
          </Empty>
        ) : (
          <div className="space-y-4">
            {council.map((session) => (
              <CouncilCard
                key={session.id}
                session={session}
                t={t}
                onDelete={(id) => {
                  void api.deleteCouncilSession(id).then(() =>
                    setCouncil((prev) => prev.filter((s) => s.id !== id))
                  ).catch(() => {});
                }}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Delegation log */}
      <Card title={t("crew_delegations")}>
        <p className="mb-3 text-sm text-fg-dim">{t("crew_delegations_desc")}</p>
        {delegations.length === 0 ? (
          <Empty icon={<CrewArt />} title={t("crew_delegations_empty")}>
            {t("crew_delegations_empty_desc")}
          </Empty>
        ) : (
          <div className="space-y-2">
            {delegations.map((d, i) => (
              <DelegationCard key={i} d={d} resolveAgent={resolveAgent} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function DelegationCard({
  d,
  resolveAgent,
}: {
  d: DelegationRecord;
  resolveAgent: (id: string | undefined, hint?: string) => string;
}) {
  const { t } = useI18n();
  const hideCost = useSubscription();
  const [open, setOpen] = useState(false);
  // Expandable when any field carries more than fits on a single truncated line.
  const expandable =
    (d.task?.length ?? 0) > 80 ||
    (d.summary?.length ?? 0) > 80 ||
    (d.outputTail?.length ?? 0) > 120;
  const toggle = () => setOpen((o) => !o);

  return (
    <div
      className={`rounded-lg border border-line p-2.5 text-xs ${
        expandable
          ? "cursor-pointer transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-page focus-visible:ring-accent"
          : ""
      }`}
      onClick={expandable ? toggle : undefined}
      {...(expandable
        ? {
            role: "button",
            tabIndex: 0,
            "aria-expanded": open,
            "aria-label": t("crew_delegation_toggle"),
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle();
              }
            },
          }
        : {})}
    >
      <div className="flex items-center gap-2 text-fg-dim">
        <span className="tabular">{relTime(d.ts)}</span>
        {(d.fromAgentId || d.toAgentId) && (
          <span className="text-fg-faint">
            {resolveAgent(d.fromAgentId)} → {resolveAgent(d.toAgentId ?? "president", d.leadName)}
          </span>
        )}
        {d.durationMs != null && (
          <span className="tabular text-fg-faint ml-auto">
            {(d.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        {!hideCost && d.costUsd != null && (
          <span className="tabular text-fg-faint">${d.costUsd.toFixed(4)}</span>
        )}
        {expandable && (
          <span
            aria-hidden
            className={`shrink-0 text-fg-dim ${d.durationMs == null && (hideCost || d.costUsd == null) ? "ml-auto" : ""}`}
          >
            {open ? "▴" : "▾"}
          </span>
        )}
      </div>
      {d.task && (
        <p className={`mt-1 text-fg-muted ${open ? "whitespace-pre-wrap break-words" : "truncate"}`}>
          {d.task}
        </p>
      )}
      {d.summary && (
        <p className={`mt-1 text-fg-muted ${open ? "whitespace-pre-wrap break-words" : "truncate"}`}>
          {d.summary}
        </p>
      )}
      {d.outputTail && (
        <p
          className={`mt-1 font-mono text-fg-faint ${
            open ? "whitespace-pre-wrap break-words" : "truncate"
          }`}
        >
          {open ? d.outputTail : d.outputTail.slice(0, 120)}
        </p>
      )}
    </div>
  );
}

function CouncilCard({
  session,
  t,
  onDelete,
}: {
  session: CouncilSession;
  t: ReturnType<typeof useI18n>["t"];
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const total = session.votes.length;
  // Outcome under the configured rule when available (new sessions), else fall
  // back to the raw head-count for legacy sessions that predate weighting.
  const outcome: "support" | "oppose" | null =
    session.passed !== undefined
      ? session.passed
        ? "support"
        : "oppose"
      : session.supportCount > session.opposeCount
      ? "support"
      : session.opposeCount > session.supportCount
      ? "oppose"
      : null;

  if (session.noQuorum) {
    return (
      <div className="rounded-lg border border-warn/30 bg-warn-subtle p-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="font-medium text-fg">{session.proposal.slice(0, 100)}</span>
          <Badge tone="amber">{t("crew_council_no_quorum")}</Badge>
          <span className="ml-auto text-xs text-fg-faint">{relTime(session.createdAt)}</span>
          <button
            type="button"
            onClick={() => (confirmDel ? onDelete(session.id) : setConfirmDel(true))}
            onBlur={() => setConfirmDel(false)}
            aria-label={t("crew_council_delete")}
            title={t("crew_council_delete")}
            className="text-xs text-fg-faint hover:text-critical-fg"
          >
            {confirmDel ? t("crew_council_delete_confirm") : "✕"}
          </button>
        </div>
        <p className="mt-1 text-xs text-fg-dim">{t("crew_council_no_quorum_hint")}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line overflow-hidden">
      {/* Header / summary */}
      <div className="w-full flex flex-wrap items-center gap-2 p-3">
        <button
          className="flex flex-wrap items-center gap-2 text-left flex-1 min-w-0 hover:opacity-80 transition-opacity"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="text-sm font-medium text-fg truncate flex-1">
            {session.proposal.slice(0, 100)}
          </span>
          <span className="shrink-0 flex items-center gap-1.5 text-xs">
            <Badge tone="green">✅ {session.supportCount}</Badge>
            <Badge tone="amber">❌ {session.opposeCount}</Badge>
            {session.abstainCount > 0 && <Badge tone="zinc">⬜ {session.abstainCount}</Badge>}
            {session.rule && (
              <Badge tone="zinc">{t(`crew_council_rule_${session.rule}` as TranslationKey)}</Badge>
            )}
            {total > 0 && (
              <Badge tone={outcome === "support" ? "green" : outcome === "oppose" ? "amber" : "zinc"}>
                {session.passed !== undefined
                  ? session.passed
                    ? t("crew_council_passes")
                    : t("crew_council_fails")
                  : outcome === "support"
                  ? t("crew_council_support")
                  : outcome === "oppose"
                  ? t("crew_council_oppose")
                  : "Tied"}
              </Badge>
            )}
          </span>
          <span className="shrink-0 text-xs text-fg-faint">{relTime(session.createdAt)}</span>
          <span className="shrink-0 text-fg-dim">{open ? "▴" : "▾"}</span>
        </button>
        <button
          type="button"
          onClick={() => (confirmDel ? onDelete(session.id) : setConfirmDel(true))}
          onBlur={() => setConfirmDel(false)}
          aria-label={t("crew_council_delete")}
          title={t("crew_council_delete")}
          className="shrink-0 text-xs text-fg-faint hover:text-critical-fg transition-colors px-1"
        >
          {confirmDel ? t("crew_council_delete_confirm") : "✕"}
        </button>
      </div>

      {/* Expanded votes */}
      {open && (
        <div className="border-t border-line divide-y divide-line">
          {session.votes.map((v) => {
            const icon = v.vote === "support" ? "✅" : v.vote === "oppose" ? "❌" : "⬜";
            const tone =
              v.vote === "support" ? "green" : v.vote === "oppose" ? "amber" : "zinc";
            return (
              <div key={v.leadId} className="p-3 text-xs space-y-1">
                <div className="flex items-center gap-2">
                  <span>{icon}</span>
                  <span className="font-medium text-fg">{v.leadName}</span>
                  {v.portfolio && <span className="text-fg-faint">{v.portfolio}</span>}
                  <Badge tone={tone}>
                    {v.vote === "support"
                      ? t("crew_council_support")
                      : v.vote === "oppose"
                      ? t("crew_council_oppose")
                      : t("crew_council_abstain")}
                  </Badge>
                  {session.weighted && v.relevance !== undefined && (
                    <span
                      className="ml-auto shrink-0 tabular-nums text-fg-faint"
                      title={t("crew_council_relevance")}
                    >
                      {Math.round(v.relevance * 100)}%
                    </span>
                  )}
                </div>
                <p className="text-fg-muted">→ {v.reason}</p>
                <p className="text-fg-faint">⚠ {v.concern}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type LeadStatus = "paused" | "error" | "working" | "idle";

function leadStatus(lead: Worker): LeadStatus {
  if (!lead.enabled) return "paused";
  if (lead.escalated) return "error";
  if (lead.running) return "working";
  return "idle";
}

const STATUS_GLOW: Record<LeadStatus, string> = {
  paused: "",
  idle: "status-glow-idle",
  working: "status-glow-working",
  error: "status-glow-error",
};

const STATUS_DOT: Record<LeadStatus, string> = {
  paused: "bg-fg-faint",
  idle: "bg-fg-faint",
  working: "bg-accent",
  error: "bg-critical",
};

/** Pill-shaped quick action for the Telegram / Web-chat controls on Crew
 *  cards: a real border + solid hover background (not just an opacity fade)
 *  so it reads as clickable rather than as a plain status badge. */
function ActionChip({
  href,
  onClick,
  title,
  tone,
  icon,
  children,
  className = "",
}: {
  href?: string;
  onClick?: () => void;
  title: string;
  tone: "green" | "cobalt";
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const toneClass =
    tone === "green"
      ? "border-ok/40 bg-ok-subtle text-ok-fg"
      : "border-blue-500/40 bg-blue-500/15 text-blue-600 dark:text-blue-400";
  const interactive = href ?? onClick;
  const base = `inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${toneClass} ${
    interactive ? "transition-colors hover:brightness-95 dark:hover:brightness-125" : "opacity-70"
  } ${className}`;
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" title={title} className={base}>
        {icon}
        {children}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={base}>
        {icon}
        {children}
      </button>
    );
  }
  return (
    <span title={title} className={base}>
      {icon}
      {children}
    </span>
  );
}

/**
 * Scannable roster card for one Lead: avatar with a colored status-glow ring
 * (idle/working/error/paused — always paired with a text label, never color
 * alone), a one-line personality blurb from its persona, and a compact stack
 * of its Assistants' avatars. Replaces the old flat text row.
 */
function LeadCard({
  lead,
  assistants,
  onWebChat,
}: {
  lead: Worker;
  assistants: Worker[];
  onWebChat?: () => void;
}) {
  const { t } = useI18n();
  const status = leadStatus(lead);
  const persona = (lead.persona ?? "").trim();
  const blurb = persona || t("crew_no_persona");
  const warn = lead.enabled && !lead.telegramToken;

  return (
    <div
      className={`rounded-xl border border-line bg-surface p-3.5 transition-opacity ${
        status === "paused" ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <span className={`shrink-0 rounded-full ${STATUS_GLOW[status]}`}>
          <Avatar id={lead.id} avatar={lead.avatar} size={48} alt={lead.name} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-fg" title={lead.name}>
            {lead.name}
          </div>
          <div className="truncate text-xs text-fg-dim" title={roleLabel(lead, t)}>
            {roleLabel(lead, t)}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`} aria-hidden />
            <span className="text-xs font-medium text-fg-dim">
              {t(`crew_status_${status}` as TranslationKey)}
            </span>
            {lead.escalated && (
              <span title={t("crew_escalated_hint")}>
                <Badge tone="amber">{t("crew_escalated")}</Badge>
              </span>
            )}
          </div>
        </div>
      </div>

      <p className="mt-2.5 line-clamp-2 text-xs italic text-fg-faint" title={persona || undefined}>
        {blurb}
      </p>

      {assistants.length > 0 && (
        <div className="mt-2.5 flex items-center gap-1.5">
          <div className="flex -space-x-2">
            {assistants.slice(0, 4).map((a) => (
              <Avatar
                key={a.id}
                id={a.id}
                avatar={a.avatar}
                size={20}
                alt={a.name}
                className="ring-2 ring-surface"
              />
            ))}
          </div>
          <span className="text-xs text-fg-faint">
            {(assistants.length === 1 ? t("crew_assistant_count") : t("crew_assistants_count")).replace(
              "{n}",
              String(assistants.length),
            )}
          </span>
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {lead.listening && (
          <ActionChip
            href={lead.botUsername ? `https://t.me/${lead.botUsername}` : undefined}
            title={t("crew_listening_hint")}
            tone="green"
            icon={<Send size={11} />}
          >
            {t("crew_listening")}
          </ActionChip>
        )}
        {warn && (
          <span title={t("crew_no_token_hint")} className="opacity-40">
            <Badge tone="zinc">{t("crew_no_token")}</Badge>
          </span>
        )}
        {status === "paused" && <Badge tone="zinc">{t("crew_paused")}</Badge>}
        {onWebChat && (
          <ActionChip
            onClick={onWebChat}
            title={t("crew_web_chat_hint")}
            tone="cobalt"
            icon={<MessageCircle size={11} />}
            className="ml-auto"
          >
            {t("crew_web_chat")}
          </ActionChip>
        )}
      </div>
    </div>
  );
}

type Tone = "amber" | "accent" | "blue" | "zinc";

function CrewNode({
  icon,
  avatarId,
  avatar,
  title,
  role,
  subtitle,
  tone,
  depth,
  extra,
  extraHref,
  warn,
  paused,
  dimmed,
  escalated,
  onWebChat,
}: {
  icon: string;
  /** When set, render the worker's circular avatar instead of the `icon` glyph. */
  avatarId?: string;
  /** Explicit avatar slug; falls back to a deterministic default from avatarId. */
  avatar?: string;
  title: string;
  /** The agent's portfolio / domain (e.g. "Web Design & UI", "President"),
   *  rendered as an always-visible role chip below the name so the Crew tab
   *  reads as an org chart, not just a name list. */
  role?: string;
  subtitle: string;
  tone: Tone;
  depth: number;
  extra?: string;
  /** When set, the `extra` badge becomes a link (e.g. a t.me handle). */
  extraHref?: string;
  warn?: string;
  /** Dim the node and show a "paused" badge when the worker is disabled. */
  paused?: boolean;
  /** Dim the node without a badge — used as a loading placeholder before the
   *  fleet data has arrived, so the hierarchy shape is visible while it loads. */
  dimmed?: boolean;
  /** Show an amber "escalated" badge: worker hit a tool error in auto_until_error mode. */
  escalated?: boolean;
  /** When set, show a neon "Web Chat" badge that opens the panel chat here. */
  onWebChat?: () => void;
}) {
  const { t } = useI18n();
  const toneClass: Record<Tone, string> = {
    amber: "text-warn-fg",
    accent: "text-[var(--accent)]",
    blue: "text-blue-400",
    zinc: "text-fg-dim",
  };
  // A coloured left rule per depth gives a width-independent hierarchy cue, so
  // even when the responsive indent is small on a phone the nesting stays legible.
  const ruleClass: Record<number, string> = {
    1: "border-l-2 border-[var(--accent)]/40",
    2: "border-l-2 border-blue-400/40",
    3: "border-l-2 border-fg-faint/40",
  };

  return (
    <div
      className={`flex items-center gap-3 transition-opacity ${depth > 0 ? "pl-3" : ""} ${
        ruleClass[depth] ?? ""
      } ${paused ? "opacity-50" : ""} ${dimmed ? "opacity-60" : ""}`}
      style={{ marginLeft: `calc(${depth} * var(--crew-indent))` }}
    >
      {depth > 0 && (
        <div className="flex items-center">
          <div className="h-px w-4 bg-line" />
        </div>
      )}
      {avatarId ? (
        <Avatar id={avatarId} avatar={avatar} size={32} alt={title} className="shrink-0" />
      ) : (
        <div className={`shrink-0 w-5 text-center text-sm ${toneClass[tone]}`}>{icon}</div>
      )}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-fg">{title}</span>
          {role && (
            <span
              className="max-w-[18ch] truncate rounded bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-fg-dim"
              title={role}
            >
              {role}
            </span>
          )}
          {paused && <Badge tone="zinc">{t("crew_paused")}</Badge>}
          {escalated && (
            <span title={t("crew_escalated_hint")}>
              <Badge tone="amber">{t("crew_escalated")}</Badge>
            </span>
          )}
          {/* Telegram + Chat: fixed-width slots so the chips always align */}
          <span className="flex items-center gap-1.5">
            {extra && (
              <ActionChip
                href={extraHref}
                title={t("crew_listening_hint")}
                tone="green"
                icon={<Send size={11} />}
                className="min-w-[5.5rem] justify-center"
              >
                {t("crew_listening")}
              </ActionChip>
            )}
            {warn && (
              <span title={t("crew_no_token_hint")} className="opacity-40">
                <Badge tone="zinc" className="min-w-[4.5rem] justify-center">{t("crew_no_token")}</Badge>
              </span>
            )}
            {onWebChat && (
              <ActionChip
                onClick={onWebChat}
                title={t("crew_web_chat_hint")}
                tone="cobalt"
                icon={<MessageCircle size={11} />}
                className="min-w-[5.5rem] justify-center"
              >
                {t("crew_web_chat")}
              </ActionChip>
            )}
          </span>
        </div>
        <div className="truncate text-xs text-fg-dim" title={subtitle}>
          {subtitle}
        </div>
      </div>
    </div>
  );
}
