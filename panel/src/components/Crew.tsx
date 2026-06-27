import { useEffect, useState } from "react";
import { api, type Worker, type MainAgent, type DelegationRecord } from "../api.ts";
import { Card, Empty, Badge, InfoCard } from "./ui.tsx";
import { relTime } from "../lib/format.ts";
import { useI18n } from "../lib/useI18n.ts";

interface CouncilVote {
  leadId: string;
  leadName: string;
  portfolio?: string;
  vote: "support" | "oppose" | "abstain";
  reason: string;
  concern: string;
}

interface CouncilSession {
  id: string;
  proposal: string;
  votes: CouncilVote[];
  supportCount: number;
  opposeCount: number;
  abstainCount: number;
  createdAt: number;
  noQuorum?: boolean;
}

export function CrewView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [atlas, setAtlas] = useState<MainAgent | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [delegations, setDelegations] = useState<DelegationRecord[]>([]);
  const [council, setCouncil] = useState<CouncilSession[]>([]);
  const [proposal, setProposal] = useState("");
  const [voting, setVoting] = useState(false);
  const [voteElapsed, setVoteElapsed] = useState(0);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.agent(),
      api.workers(),
      api.delegations(30),
      api.council(20),
    ])
      .then(([a, w, d, c]) => {
        setAtlas(a);
        setWorkers(w.workers);
        setDelegations(d.delegations);
        setCouncil(c.sessions as unknown as CouncilSession[]);
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error === "AuthError: unauthorized") onAuthError();
  }, [error, onAuthError]);

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
      setVoteError(String(e));
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

      {/* President */}
      <CrewNode
        icon="★"
        title={t("crew_president")}
        subtitle={t("crew_president_sub")}
        tone="amber"
        depth={0}
      />

      {/* Atlas — the main bot is always reachable on Telegram */}
      <CrewNode
        icon="◈"
        title="Atlas"
        subtitle={`${t("crew_atlas_sub")} · ${atlas?.effectiveModel ?? "…"}`}
        tone="accent"
        depth={1}
        extra={t("crew_listening")}
        extraHref={atlas?.botUsername ? `https://t.me/${atlas.botUsername}` : undefined}
      />

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
      {leads.map((lead) => (
        <div key={lead.id}>
          <CrewNode
            icon="◆"
            title={lead.name}
            subtitle={[lead.portfolio ? `${lead.portfolio} Lead` : "Lead", lead.model]
              .filter(Boolean)
              .join(" · ")}
            tone="blue"
            depth={2}
            paused={!lead.enabled}
            extra={lead.listening ? t("crew_listening") : undefined}
            extraHref={
              lead.listening && lead.botUsername ? `https://t.me/${lead.botUsername}` : undefined
            }
            warn={lead.enabled && !lead.telegramToken ? t("crew_no_token") : undefined}
          />
          {assistants
            .filter((a) => a.parentId === lead.id)
            .map((a) => (
              <CrewNode
                key={a.id}
                icon="◇"
                title={a.name}
                subtitle={a.portfolio ?? "Assistant"}
                tone="zinc"
                depth={3}
                paused={!a.enabled}
              />
            ))}
        </div>
      ))}

      {/* Unparented assistants */}
      {assistants
        .filter((a) => !a.parentId || !leads.find((l) => l.id === a.parentId))
        .map((a) => (
          <CrewNode
            key={a.id}
            icon="◇"
            title={a.name}
            subtitle={a.portfolio ?? "Assistant"}
            tone="zinc"
            depth={2}
            paused={!a.enabled}
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
              title={w.name}
              subtitle={w.model || "default model"}
              tone="zinc"
              depth={2}
              paused={!w.enabled}
            />
          ))}
        </div>
      )}

      {/* Council vote log */}
      <Card title={t("crew_council")}>
        <p className="mb-3 text-sm text-fg-dim">{t("crew_council_desc")}</p>

        {/* Trigger a new vote */}
        <div className="mb-4 rounded-lg border border-accent/30 bg-accent/5 p-3">
          <textarea
            value={proposal}
            onChange={(e) => setProposal(e.target.value)}
            placeholder={t("crew_council_placeholder")}
            rows={3}
            disabled={voting}
            className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none disabled:opacity-60"
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
              className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {voting && (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              )}
              {voting ? t("crew_council_voting") : t("crew_council_call")}
            </button>
          </div>
          {voting && (
            <div className="mt-3 flex items-start gap-3 rounded-md border border-accent/30 bg-accent/10 p-3">
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
            <p className="mt-2 text-xs text-red-400">{voteError}</p>
          )}
        </div>

        {council.length === 0 ? (
          <Empty>{t("crew_council_empty")}</Empty>
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
          <Empty>{t("crew_delegations_empty")}</Empty>
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
  const [open, setOpen] = useState(false);
  // Expandable when any field carries more than fits on a single truncated line.
  const expandable =
    (d.task?.length ?? 0) > 80 ||
    (d.summary?.length ?? 0) > 80 ||
    (d.outputTail?.length ?? 0) > 120;

  return (
    <div
      className={`rounded-lg border border-line p-2.5 text-xs ${
        expandable ? "cursor-pointer hover:bg-surface-2 transition-colors" : ""
      }`}
      onClick={expandable ? () => setOpen((o) => !o) : undefined}
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
        {d.costUsd != null && (
          <span className="tabular text-fg-faint">${d.costUsd.toFixed(4)}</span>
        )}
        {expandable && (
          <span className={`shrink-0 text-fg-dim ${d.durationMs == null && d.costUsd == null ? "ml-auto" : ""}`}>
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
  const winner =
    session.supportCount > session.opposeCount
      ? "support"
      : session.opposeCount > session.supportCount
      ? "oppose"
      : null;

  if (session.noQuorum) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
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
            className="text-xs text-fg-faint hover:text-red-400"
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
            {total > 0 && (
              <Badge tone={winner === "support" ? "green" : winner === "oppose" ? "amber" : "zinc"}>
                {winner === "support"
                  ? t("crew_council_support")
                  : winner === "oppose"
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
          className="shrink-0 text-xs text-fg-faint hover:text-red-400 transition-colors px-1"
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

type Tone = "amber" | "accent" | "blue" | "zinc";

function CrewNode({
  icon,
  title,
  subtitle,
  tone,
  depth,
  extra,
  extraHref,
  warn,
  paused,
}: {
  icon: string;
  title: string;
  subtitle: string;
  tone: Tone;
  depth: number;
  extra?: string;
  /** When set, the `extra` badge becomes a link (e.g. a t.me handle). */
  extraHref?: string;
  warn?: string;
  /** Dim the node and show a "paused" badge when the worker is disabled. */
  paused?: boolean;
}) {
  const { t } = useI18n();
  const toneClass: Record<Tone, string> = {
    amber: "text-amber-400",
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
      className={`flex items-center gap-3 ${depth > 0 ? "pl-3" : ""} ${
        ruleClass[depth] ?? ""
      } ${paused ? "opacity-50" : ""}`}
      style={{ marginLeft: `calc(${depth} * var(--crew-indent))` }}
    >
      {depth > 0 && (
        <div className="flex items-center">
          <div className="h-px w-4 bg-line" />
        </div>
      )}
      <div className={`shrink-0 w-5 text-center text-sm ${toneClass[tone]}`}>{icon}</div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-fg">{title}</span>
          {paused && <Badge tone="zinc">{t("crew_paused")}</Badge>}
          {extra &&
            (extraHref ? (
              <a href={extraHref} target="_blank" rel="noreferrer" className="hover:underline">
                <Badge tone="green">{extra}</Badge>
              </a>
            ) : (
              <Badge tone="green">{extra}</Badge>
            ))}
          {warn && <Badge tone="zinc">{warn}</Badge>}
        </div>
        <div className="truncate text-xs text-fg-dim" title={subtitle}>
          {subtitle}
        </div>
      </div>
    </div>
  );
}
