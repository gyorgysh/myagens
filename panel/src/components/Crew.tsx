import { useEffect, useState } from "react";
import { api, type Worker, type MainAgent, type DelegationRecord } from "../api.ts";
import { Card, Empty, Badge } from "./ui.tsx";
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
}

export function CrewView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [atlas, setAtlas] = useState<MainAgent | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [delegations, setDelegations] = useState<DelegationRecord[]>([]);
  const [council, setCouncil] = useState<CouncilSession[]>([]);
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

  if (error) return <Empty>Failed to load: {error}</Empty>;

  const leads = workers.filter((w) => w.role === "lead");
  const assistants = workers.filter((w) => w.role === "assistant");
  const specialists = workers.filter(
    (w) => !w.role || (w.role !== "lead" && w.role !== "assistant"),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-fg">{t("crew_title")}</h1>
        <p className="mt-1 text-sm text-fg-dim">{t("crew_subtitle")}</p>
      </div>

      <CrewHowItWorks t={t} />

      {/* President */}
      <CrewNode
        icon="★"
        title={t("crew_president")}
        subtitle={t("crew_president_sub")}
        tone="amber"
        depth={0}
      />

      {/* Atlas */}
      <CrewNode
        icon="◈"
        title="Atlas"
        subtitle={`${t("crew_atlas_sub")} · ${atlas?.effectiveModel ?? "…"}`}
        tone="accent"
        depth={1}
      />

      {/* Leads and their Assistants */}
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
            extra={lead.listening ? t("crew_listening") : undefined}
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
            />
          ))}
        </div>
      )}

      {/* Council vote log */}
      <Card title={t("crew_council")}>
        <p className="mb-3 text-sm text-fg-dim">{t("crew_council_desc")}</p>
        {council.length === 0 ? (
          <Empty>{t("crew_council_empty")}</Empty>
        ) : (
          <div className="space-y-4">
            {council.map((session) => (
              <CouncilCard key={session.id} session={session} t={t} />
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
              <div key={i} className="rounded-lg border border-line p-2.5 text-xs">
                <div className="flex items-center gap-2 text-fg-dim">
                  <span className="tabular">{relTime(d.ts)}</span>
                  {d.fromAgentId && (
                    <span className="text-fg-faint">
                      {d.fromAgentId} → {d.toAgentId ?? "president"}
                    </span>
                  )}
                  {d.leadName && <span className="font-medium text-fg">{d.leadName}</span>}
                  {d.durationMs != null && (
                    <span className="tabular text-fg-faint ml-auto">
                      {(d.durationMs / 1000).toFixed(1)}s
                    </span>
                  )}
                  {d.costUsd != null && (
                    <span className="tabular text-fg-faint">${d.costUsd.toFixed(4)}</span>
                  )}
                </div>
                {d.task && <p className="mt-1 text-fg-muted truncate">{d.task}</p>}
                {d.summary && <p className="mt-1 text-fg-muted truncate">{d.summary}</p>}
                {d.outputTail && (
                  <p className="mt-1 font-mono text-fg-faint truncate">{d.outputTail.slice(0, 120)}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function CouncilCard({ session, t }: { session: CouncilSession; t: ReturnType<typeof useI18n>["t"] }) {
  const [open, setOpen] = useState(false);
  const total = session.votes.length;
  const winner =
    session.supportCount > session.opposeCount
      ? "support"
      : session.opposeCount > session.supportCount
      ? "oppose"
      : null;

  return (
    <div className="rounded-lg border border-line overflow-hidden">
      {/* Header / summary */}
      <button
        className="w-full flex flex-wrap items-center gap-2 p-3 text-left hover:bg-surface-2 transition-colors"
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

/** Collapsible explainer of how the crew, wizard, tasks and runs work. */
function CrewHowItWorks({ t }: { t: ReturnType<typeof useI18n>["t"] }) {
  const [open, setOpen] = useState(false);
  const sections: Array<[string, string]> = [
    [t("crew_how_wizard_title"), t("crew_how_wizard")],
    [t("crew_how_tasks_title"), t("crew_how_tasks")],
    [t("crew_how_runs_title"), t("crew_how_runs")],
  ];
  return (
    <div className="rounded-lg border border-line bg-surface overflow-hidden">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-fg hover:bg-surface-2 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-accent">ⓘ</span>
        <span className="flex-1">{open ? t("crew_how_title") : t("crew_how_show")}</span>
        <span className="text-fg-dim">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-3 py-3 text-sm text-fg-dim">
          <p>{t("crew_how_intro")}</p>
          {sections.map(([title, body]) => (
            <div key={title}>
              <div className="font-medium text-fg">{title}</div>
              <p className="mt-0.5">{body}</p>
            </div>
          ))}
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
  warn,
}: {
  icon: string;
  title: string;
  subtitle: string;
  tone: Tone;
  depth: number;
  extra?: string;
  warn?: string;
}) {
  const indent = depth * 24;
  const toneClass: Record<Tone, string> = {
    amber: "text-amber-400",
    accent: "text-[var(--accent)]",
    blue: "text-blue-400",
    zinc: "text-fg-dim",
  };

  return (
    <div className="flex items-center gap-3" style={{ paddingLeft: indent }}>
      {depth > 0 && (
        <div className="flex items-center">
          <div className="h-px w-4 bg-line" />
        </div>
      )}
      <div className={`shrink-0 w-5 text-center text-sm ${toneClass[tone]}`}>{icon}</div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-fg">{title}</span>
          {extra && <Badge tone="green">{extra}</Badge>}
          {warn && <Badge tone="amber">⚠ {warn}</Badge>}
        </div>
        <div className="text-xs text-fg-dim">{subtitle}</div>
      </div>
    </div>
  );
}
