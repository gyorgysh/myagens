import { useEffect, useRef, useState } from "react";
import {
  api,
  AuthError,
  type Worker,
  type WorkerRun,
  type Autonomy,
  type NamedProvider,
  type NamedBackend,
  type ProviderKind,
} from "../api.ts";
import { useWorkerEvents, type LiveRun } from "../lib/useWorkerEvents.ts";
import { roleLabel } from "../lib/agentRole.ts";
import { useI18n } from "../lib/useI18n.ts";
import { errorMessage } from "../lib/errorMessage.ts";
import type { TranslationKey } from "../i18n/en.ts";
import { Avatar, Badge, Button, Card, ConfirmDialog, Empty, InfoCard, Input, Label, Modal, ModelSelect, Select, TextArea } from "./ui.tsx";
import { MODEL_SUGGESTIONS } from "../lib/models.ts";
import { useAvatarList, resolveAvatarSlug, AVATAR_SLUGS } from "../lib/avatar.ts";
import {
  RefreshCw,
  ChevronDown,
  Server,
  Rss,
  GitPullRequest,
  PenLine,
  Banknote,
  Terminal,
  Layers,
  Palette,
  HeartPulse,
  Apple,
  type LucideIcon,
} from "lucide-react";
import { RunLog } from "./RunLog.tsx";
import { CrewArt } from "./onboarding.tsx";
import { ms, relTime, usd } from "../lib/format.ts";
import { useSubscription } from "../lib/useSubscription.ts";
import { AGENT_LANGUAGES } from "../i18n/languages.ts";

const emptyForm = {
  name: "",
  cwd: "",
  prompt: "",
  model: "",
  providerId: "",
  backendId: "",
  systemPrompt: "",
  skillId: "",
  when: "",
  role: "" as "" | "lead" | "assistant",
  portfolio: "",
  parentId: "",
  telegramToken: "",
  persona: "",
  autonomy: "standard" as Autonomy,
  language: "",
  streamMode: "" as "" | "rich" | "draft" | "edit",
  webhookUrl: "",
  avatar: "",
};
type Form = typeof emptyForm;

type Named = { id: string; name: string };

/** Short, readable label for a model id badge (e.g. "haiku-4-5"). */
function shortModel(id: string): string {
  return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/** Pick the right cwd placeholder i18n key for the host platform, so the path
 *  example matches what the user will actually type (C:\... on Windows). */
function cwdPlaceholderKey(platform: string): "workers_cwd_placeholder_win" | "workers_cwd_placeholder_unix" {
  return platform === "win32" ? "workers_cwd_placeholder_win" : "workers_cwd_placeholder_unix";
}

/** Fixed display label for each provider kind; Anthropic is the implicit
 *  default when a worker has no provider set (the cloud API). */
const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  anthropic: "Anthropic",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  custom: "Provider",
};

const PERSONA_PRESETS: Array<{ labelKey: TranslationKey; descKey: TranslationKey; value: string }> = [
  { labelKey: "settings_persona_concise", descKey: "workers_persona_preset_concise", value: "Concise and direct. Lead with the result, skip preamble, use short sentences." },
  { labelKey: "settings_persona_warm", descKey: "workers_persona_preset_warm", value: "Warm and encouraging. Acknowledge effort, celebrate wins, frame challenges positively." },
  { labelKey: "settings_persona_formal", descKey: "workers_persona_preset_formal", value: "Formal and precise. Use structured language, avoid contractions and casual expressions." },
  { labelKey: "settings_persona_analytical", descKey: "workers_persona_preset_analytical", value: "Analytical and methodical. Think through problems step by step, cite specifics." },
  { labelKey: "settings_persona_playful", descKey: "workers_persona_preset_playful", value: "Witty and playful. Use light humor, analogies, and keep the energy high." },
];

const AUTONOMY_KEY: Record<Autonomy, TranslationKey> = {
  supervised: "supervised",
  standard: "standard",
  full: "full",
  auto_until_error: "auto_until_error",
};

const AUTONOMY_DESC_KEY: Record<Autonomy, TranslationKey> = {
  supervised: "settings_autonomy_supervised_desc",
  standard: "settings_autonomy_standard_desc",
  full: "settings_autonomy_full_desc",
  auto_until_error: "settings_autonomy_auto_until_error_desc",
};

// Tappable preset buttons for the wizard's goal field (prefill the textarea with
// a translated starter phrase; the user can still edit freely before generating).
const WIZARD_GOAL_EXAMPLES: Array<{ labelKey: TranslationKey; goalKey: TranslationKey; icon: LucideIcon }> = [
  { labelKey: "wizard_goal_ex_server", goalKey: "wizard_goal_ex_server_text", icon: Server },
  { labelKey: "wizard_goal_ex_digest", goalKey: "wizard_goal_ex_digest_text", icon: Rss },
  { labelKey: "wizard_goal_ex_review", goalKey: "wizard_goal_ex_review_text", icon: GitPullRequest },
  { labelKey: "wizard_goal_ex_writer", goalKey: "wizard_goal_ex_writer_text", icon: PenLine },
  { labelKey: "wizard_goal_ex_finance", goalKey: "wizard_goal_ex_finance_text", icon: Banknote },
  { labelKey: "wizard_goal_ex_devops", goalKey: "wizard_goal_ex_devops_text", icon: Terminal },
  { labelKey: "wizard_goal_ex_fullstack", goalKey: "wizard_goal_ex_fullstack_text", icon: Layers },
  { labelKey: "wizard_goal_ex_webdesign", goalKey: "wizard_goal_ex_webdesign_text", icon: Palette },
  { labelKey: "wizard_goal_ex_health", goalKey: "wizard_goal_ex_health_text", icon: HeartPulse },
  { labelKey: "wizard_goal_ex_nutrition", goalKey: "wizard_goal_ex_nutrition_text", icon: Apple },
];

// Schedule chip presets → the cron/interval string the backend understands.
// "" = manual; "custom" reveals the raw input instead of mapping to a value.
const WIZARD_SCHEDULE_CHIPS: Array<{ labelKey: TranslationKey; value: string }> = [
  { labelKey: "wizard_sched_manual", value: "" },
  { labelKey: "wizard_sched_30m", value: "30m" },
  { labelKey: "wizard_sched_hourly", value: "1h" },
  { labelKey: "wizard_sched_daily", value: "09:00" },
  { labelKey: "wizard_sched_custom", value: "custom" },
];

export function WorkersView({
  onAuthError,
  onChat,
}: {
  onAuthError: () => void;
  /** Jump to the panel Chat view with this agent selected. Absent when web
   *  chat is disabled, in which case no "Web Chat" badge is shown. */
  onChat?: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [skills, setSkills] = useState<Named[]>([]);
  const [providers, setProviders] = useState<NamedProvider[]>([]);
  const [backends, setBackends] = useState<NamedBackend[]>([]);
  const [creating, setCreating] = useState(false);
  const [wizarding, setWizarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useWorkerEvents();
  // Deep-link target: a `?worker=<id>` param (set by the Chat profile card's
  // "Edit agent" link) auto-opens that worker's editor once on mount, then the
  // param is stripped so a refresh doesn't keep re-opening it.
  const [autoEditId] = useState<string | null>(() => {
    if (typeof location === "undefined") return null;
    const url = new URL(location.href);
    const id = url.searchParams.get("worker");
    if (!id) return null;
    url.searchParams.delete("worker");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    return id;
  });

  const load = () =>
    api
      .workers()
      .then((r) => {
        setWorkers(r.workers);
        setSkills(r.skills);
        setProviders(r.providers);
        setBackends(r.backends);
      })
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(errorMessage(e, t))));

  useEffect(() => {
    void load();
    // Refresh registry periodically so schedule/running state stays current.
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <Empty>{error}</Empty>;

  return (
    <div className="space-y-4">

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg-dim">{t("workers_crew")}</h2>
        {!creating && !wizarding && (
          <div className="flex gap-2">
            <Button onClick={() => setCreating(true)}>
              {t("workers_new")}
            </Button>
            <Button variant="primary" onClick={() => setWizarding(true)}>
              {t("workers_wizard")}
            </Button>
          </div>
        )}
      </div>

      {!creating && !wizarding && (
        <InfoCard id="workers" title={t("info_workers_title")} body={t("info_workers_body")}>
          <ul className="space-y-1.5">
            <li>{t("info_workers_run")}</li>
            <li>{t("info_workers_lead")}</li>
          </ul>
        </InfoCard>
      )}

      {wizarding && (
        <WorkerWizard
          providers={providers}
          workers={workers}
          onDone={async () => { setWizarding(false); await load(); }}
          onCancel={() => setWizarding(false)}
          onAuthError={onAuthError}
        />
      )}

      {creating && (
        <Card title={t("workers_new_card")}>
          <p className="mb-4 text-xs text-fg-dim">{t("workers_manual_note")}</p>
          <WorkerForm
            skills={skills}
            providers={providers}
            backends={backends}
            workers={workers}
            initial={emptyForm}
            onCancel={() => setCreating(false)}
            onSubmit={async (form) => {
              await api.createWorker(form);
              setCreating(false);
              await load();
            }}
            onAuthError={onAuthError}
          />
        </Card>
      )}

      {workers.length === 0 && !creating && !wizarding ? (
        <Empty
          icon={<CrewArt />}
          title={t("workers_empty")}
          action={
            <Button variant="primary" onClick={() => setWizarding(true)}>
              {t("workers_wizard")}
            </Button>
          }
        >
          {t("onb_step_crew_desc")}
        </Empty>
      ) : (
        (() => {
          const leads = workers.filter((w) => w.role === "lead");
          const assistants = workers.filter((w) => w.role === "assistant");
          const specialists = workers.filter(
            (w) => !w.role || (w.role !== "lead" && w.role !== "assistant"),
          );
          const row = (w: Worker) => (
            <WorkerRow
              key={w.id}
              worker={w}
              skills={skills}
              providers={providers}
              backends={backends}
              workers={workers}
              live={live[w.id]}
              onChange={load}
              onAuthError={onAuthError}
              onChat={onChat}
              autoEdit={w.id === autoEditId}
            />
          );
          const parented = new Set<string>();
          return (
            <>
              {leads.map((lead) => {
                const kids = assistants.filter((a) => a.parentId === lead.id);
                kids.forEach((k) => parented.add(k.id));
                return (
                  <div key={lead.id} className="space-y-4">
                    {row(lead)}
                    {kids.length > 0 && <div className="ml-4 space-y-4">{kids.map(row)}</div>}
                  </div>
                );
              })}
              {assistants.filter((a) => !parented.has(a.id)).map(row)}
              {specialists.map(row)}
            </>
          );
        })()
      )}
    </div>
  );
}

function WorkerRow({
  worker,
  skills,
  providers,
  backends,
  workers,
  live,
  onChange,
  onAuthError,
  onChat,
  autoEdit,
}: {
  worker: Worker;
  skills: Named[];
  providers: NamedProvider[];
  backends: NamedBackend[];
  workers: Worker[];
  live?: LiveRun;
  onChange: () => void;
  onAuthError: () => void;
  /** Open the panel chat with this worker. Absent when web chat is disabled. */
  onChat?: (agentId: string) => void;
  /** Deep-link target: open this row's editor and scroll it into view on mount. */
  autoEdit?: boolean;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(Boolean(autoEdit));
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  // When arrived at via the "Edit agent" deep-link, scroll the (already-open)
  // editor into view so the user lands on it.
  useEffect(() => {
    if (autoEdit && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Run-Agent confirmation modal: an ad-hoc run is intentional (shows cwd +
  // editable prompt) rather than a one-tap fire-and-forget.
  const [runModal, setRunModal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [runs, setRuns] = useState<WorkerRun[]>([]);
  const running = worker.running || live?.status === "running";
  // Resolve the agent's backend provider. With no providerId set it runs on the
  // Anthropic cloud API; otherwise it points at a local/custom provider preset.
  // We always show a type badge (Anthropic / Ollama / LM Studio / Provider) so
  // cloud agents read consistently with local ones, not just a bare model name.
  const provider = providers.find((p) => p.id === worker.providerId);
  const providerKind: ProviderKind = provider?.kind ?? "anthropic";
  const providerLabel =
    providerKind === "custom" ? provider?.name || PROVIDER_KIND_LABEL.custom : PROVIDER_KIND_LABEL[providerKind];
  const isLocalProvider = providerKind === "ollama" || providerKind === "lmstudio";

  const loadRuns = () => api.workerRuns(worker.id).then((r) => setRuns(r.runs));
  useEffect(() => {
    if (open) void loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, live?.status]);

  const run = async (prompt?: string) => {
    try {
      await api.runWorker(worker.id, prompt);
      setRunModal(false);
      setOpen(true);
      onChange();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    }
  };
  const stop = async () => {
    await api.stopWorker(worker.id);
    onChange();
  };
  const del = async () => {
    setConfirmDelete(false);
    await api.deleteWorker(worker.id);
    onChange();
  };

  return (
    <div ref={rowRef} className="scroll-mt-4">
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <Avatar id={worker.id} avatar={worker.avatar} size={32} alt={worker.name} />
        <span className="font-medium text-fg">{worker.name}</span>
        {worker.role === "lead" && <Badge tone="blue">{t("workers_lead")}</Badge>}
        {worker.role === "assistant" && <Badge tone="zinc">{t("workers_assistant")}</Badge>}
        {worker.portfolio && (
          <span title={worker.portfolio}>
            <Badge>
              {worker.portfolio.split(/[\s,]+/).slice(0, 3).join(" ")}
              {worker.portfolio.split(/[\s,]+/).length > 3 ? "…" : ""}
            </Badge>
          </span>
        )}
        {worker.schedule && worker.schedule !== "manual" && (
          <Badge tone="blue">{worker.schedule}</Badge>
        )}
        {/* Unified backend badge: provider type (always) + model (when set), so
            an Anthropic cloud agent reads the same way as a local one. */}
        <span title={provider?.name ?? providerLabel}>
          <Badge tone="blue">
            {isLocalProvider ? "⌂ " : ""}
            {providerLabel}
            {worker.model ? ` · ${shortModel(worker.model)}` : ""}
          </Badge>
        </span>
        {!worker.enabled && <Badge tone="amber">{t("disabled")}</Badge>}
        {worker.escalated && (
          <span title={t("crew_escalated_hint")}>
            <Badge tone="amber">{t("crew_escalated")}</Badge>
          </span>
        )}
        {/* Telegram + Chat: fixed-width slots so badges always align */}
        <span className="flex items-center gap-1.5">
          {worker.listening &&
            (worker.botUsername ? (
              <a
                href={`https://t.me/${worker.botUsername}`}
                target="_blank"
                rel="noreferrer"
                title={t("crew_listening_hint")}
                className="transition-opacity hover:opacity-80"
              >
                <Badge tone="green" className="min-w-[4.5rem] justify-center">{t("crew_listening")}</Badge>
              </a>
            ) : (
              <span title={t("crew_listening_hint")}>
                <Badge tone="green" className="min-w-[4.5rem] justify-center">{t("crew_listening")}</Badge>
              </span>
            ))}
          {worker.role === "lead" && worker.enabled && !worker.telegramToken && (
            <span title={t("crew_no_token_hint")} className="opacity-40">
              <Badge tone="zinc" className="min-w-[4.5rem] justify-center">{t("crew_no_token")}</Badge>
            </span>
          )}
          {onChat && (
            <button
              type="button"
              onClick={() => onChat(worker.id)}
              title={t("crew_web_chat_hint")}
              className="transition-opacity hover:opacity-80"
            >
              <Badge tone="cobalt" className="min-w-[4.5rem] justify-center">{t("crew_web_chat")}</Badge>
            </button>
          )}
        </span>
        {running && <Badge tone="green">{t("running")}</Badge>}
        <span className="ml-auto flex gap-1.5">
          {running ? (
            <Button variant="danger" onClick={stop}>
              {t("stop")}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setRunModal(true)} title={t("workers_run_agent_tooltip")}>
              {t("workers_run_agent")}
            </Button>
          )}
          <Button onClick={() => setOpen((o) => !o)}>{open ? t("hide") : t("details")}</Button>
          <Button onClick={() => setEditing((e) => !e)}>{t("edit")}</Button>
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            {t("delete")}
          </Button>
        </span>
      </div>

      <div className="mt-1 flex items-center gap-1.5">
        <span className="min-w-0 truncate font-mono text-xs text-fg-faint" title={worker.cwd}>
          {worker.cwd || t("workers_no_cwd")}
          {worker.nextRunAt && ` · ${t("workers_next").replace("{time}", relTime(worker.nextRunAt))}`}
        </span>
        {(worker.claudeMdBytes ?? 0) > 6144 && (
          <span
            className="shrink-0 cursor-default text-xs text-warn-fg"
            title={`${t("worker_claude_md_warn").replace("{kb}", "6")} ${t("worker_claude_md_warn_cwd")}`}
          >
            ⚠
          </span>
        )}
      </div>

      {worker.role === "lead" && (
        <div className="mt-1 text-xs text-fg-faint">{t("workers_interact_hint")}</div>
      )}

      {editing && (
        <div className="mt-3 border-t border-line pt-3">
          <WorkerForm
            skills={skills}
            providers={providers}
            backends={backends}
            workers={workers}
            seedId={worker.id}
            initial={{
              name: worker.name,
              cwd: worker.cwd,
              prompt: worker.prompt,
              model: worker.model,
              providerId: worker.providerId,
              backendId: worker.backendId ?? "",
              systemPrompt: worker.systemPrompt,
              skillId: worker.skillId,
              when: worker.when,
              role: worker.role ?? "",
              portfolio: worker.portfolio ?? "",
              parentId: worker.parentId ?? "",
              telegramToken: worker.telegramToken ?? "",
              persona: worker.persona ?? "",
              autonomy: worker.autonomy ?? "full",
              language: worker.language ?? "",
              streamMode: (worker.streamMode ?? "") as "" | "rich" | "draft" | "edit",
              webhookUrl: worker.webhookUrl ?? "",
              avatar: worker.avatar ?? "",
            }}
            enabled={worker.enabled}
            onCancel={() => setEditing(false)}
            onSubmit={async (form, enabled) => {
              await api.updateWorker(worker.id, { ...form, enabled });
              setEditing(false);
              onChange();
            }}
            onAuthError={onAuthError}
          />
        </div>
      )}

      {open && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          <LiveOutput live={live} />
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wider text-fg-dim">
              {t("workers_run_history")}
            </div>
            {runs.length === 0 ? (
              <p className="text-xs text-fg-faint">{t("workers_no_runs")}</p>
            ) : (
              <div className="space-y-1">
                {runs.map((r) => (
                  <RunRow key={r.id} run={r} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {runModal && (
        <RunAgentModal
          worker={worker}
          onCancel={() => setRunModal(false)}
          onConfirm={(prompt) => void run(prompt)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={t("workers_delete")}
          description={t("workers_delete_confirm").replace("{name}", worker.name)}
          confirmLabel={t("delete")}
          onConfirm={() => void del()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </Card>
    </div>
  );
}

/**
 * Confirmation modal for an ad-hoc agent run. Shows the agent's name + role, the
 * working directory the run will use, and an editable prompt (pre-filled with
 * the saved prompt). Confirming fires an autonomous run with the edited prompt
 * without mutating the saved worker; the edit is one-shot.
 */
function RunAgentModal({
  worker,
  onCancel,
  onConfirm,
}: {
  worker: Worker;
  onCancel: () => void;
  onConfirm: (prompt: string) => void;
}) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState(worker.prompt ?? "");
  const role = roleLabel(worker, t);

  return (
    <Modal onClose={onCancel} labelledBy="run-agent-title">
      <div>
        <div className="border-b border-line px-4 py-3">
          <h3 id="run-agent-title" className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
            {t("workers_run_agent")}
            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
              {worker.name}
            </span>
            {worker.model && <Badge tone="blue">{shortModel(worker.model)}</Badge>}
          </h3>
          <div className="mt-0.5 text-xs text-fg-dim">{role}</div>
        </div>
        <div className="space-y-3 px-4 py-3">
          <div>
            <Label>{t("workers_cwd")}</Label>
            <div
              className="mono truncate rounded border border-line bg-base px-2 py-1.5 text-xs text-fg-dim"
              title={worker.cwd}
            >
              {worker.cwd || t("workers_no_cwd")}
            </div>
          </div>
          <div>
            <Label>{t("workers_run_agent_prompt")}</Label>
            <TextArea
              autoFocus
              rows={6}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("workers_task")}
            />
            <p className="mt-1 text-xs text-fg-faint">{t("workers_run_agent_prompt_hint")}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <Button onClick={onCancel}>{t("cancel")}</Button>
          <Button variant="primary" disabled={!prompt.trim()} onClick={() => onConfirm(prompt)}>
            {t("workers_run_agent_confirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * One run-history row. Click to expand the full uncapped transcript fetched from
 * /api/runs/:runId/log (lazily, only when first opened).
 */
function RunRow({ run: r }: { run: WorkerRun }) {
  const { t } = useI18n();
  const hideCost = useSubscription();
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left hover:opacity-80">
        <Badge tone={r.status === "ok" ? "green" : r.status === "error" ? "amber" : "zinc"}>
          {r.status}
        </Badge>
        <span className="tabular text-fg-dim">{relTime(r.startedAt)}</span>
        {r.durationMs != null && <span className="tabular text-fg-faint">{ms(r.durationMs)}</span>}
        {!hideCost && r.costUsd != null && <span className="tabular text-fg-faint">{usd(r.costUsd)}</span>}
        {r.error && <span className="truncate text-critical-fg">{r.error}</span>}
        <span className="ml-auto shrink-0 text-accent">
          {open ? t("workers_hide_full_log") : t("workers_view_full_log")}
        </span>
      </button>
      {open && <RunLog runId={r.id} />}
    </div>
  );
}

// ─── Worker Wizard ───────────────────────────────────────────────────────────

type WizardPhase = "questions" | "generating" | "review";

interface WizardAnswers {
  goal: string;
  context: string;
  cwd: string;
  schedule: string;
  crew: boolean;
}

function WorkerWizard({
  providers,
  workers,
  onDone,
  onCancel,
  onAuthError,
}: {
  providers: NamedProvider[];
  workers: Worker[];
  onDone: () => Promise<void>;
  onCancel: () => void;
  onAuthError: () => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<WizardPhase>("questions");
  const [answers, setAnswers] = useState<WizardAnswers>({
    goal: "", context: "", cwd: "", schedule: "", crew: false,
  });
  // Schedule chip picker: which preset chip is active. "custom" reveals the raw
  // input; an empty string maps to manual. Starts on "Manually".
  const [scheduleChip, setScheduleChip] = useState<string>("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [configs, setConfigs] = useState<Form[]>([]);
  const [created, setCreated] = useState<Set<number>>(new Set());
  const [genError, setGenError] = useState<string | null>(null);

  // Prefill the path with the default workspace so the field is never empty on
  // load (the Add button stays usable). The user can change it freely.
  useEffect(() => {
    api
      .me()
      .then((m) => {
        setAnswers((a) => (a.cwd.trim() ? a : { ...a, cwd: m.defaultWorkdir }));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generate = async () => {
    if (!answers.goal.trim()) return;
    setPhase("generating");
    setGenError(null);
    try {
      const r = await api.workerWizard({
        goal: answers.goal,
        context: answers.context || undefined,
        crew: answers.crew,
        schedule: answers.schedule || undefined,
        cwd: answers.cwd || undefined,
      });
      // Map API response to Form shape, filling in defaults.
      const forms: Form[] = r.configs.map((c) => ({
        name: String(c.name ?? ""),
        cwd: String(c.cwd ?? answers.cwd ?? ""),
        prompt: String(c.prompt ?? ""),
        model: String(c.model ?? ""),
        providerId: String(c.providerId ?? ""),
        // The wizard doesn't draft a backend choice — new workers it creates
        // always start on the default Claude backend.
        backendId: "",
        systemPrompt: String(c.systemPrompt ?? ""),
        skillId: String(c.skillId ?? ""),
        when: String(c.when ?? answers.schedule ?? ""),
        role: (c.role ?? "") as Form["role"],
        portfolio: String(c.portfolio ?? ""),
        parentId: "",  // resolved post-creation by name
        telegramToken: String(c.telegramToken ?? ""),
        persona: String(c.persona ?? ""),
        autonomy: (c.autonomy ?? "full") as Autonomy,
        language: String(c.language ?? ""),
        streamMode: "" as "" | "rich" | "draft" | "edit",
        webhookUrl: "",
        avatar: String(c.avatar ?? ""),
      }));
      setConfigs(forms);
      setCreated(new Set());
      setPhase("review");
    } catch (e) {
      if (e instanceof AuthError) { onAuthError(); return; }
      setGenError(errorMessage(e, t));
      setPhase("questions");
    }
  };

  const createOne = async (idx: number) => {
    try {
      await api.createWorker(configs[idx]);
      setCreated((prev) => new Set([...prev, idx]));
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    }
  };

  const createAll = async () => {
    // Track lead id -> real worker id so assistants get the right parentId.
    const leadIdByIndex = new Map<number, string>();
    for (let i = 0; i < configs.length; i++) {
      if (created.has(i)) continue;
      let cfg = configs[i];
      // If this is an assistant, find the nearest preceding lead in this batch
      // and inject its freshly-created id.
      if (cfg.role === "assistant") {
        for (let j = i - 1; j >= 0; j--) {
          const leadId = leadIdByIndex.get(j);
          if (leadId) { cfg = { ...cfg, parentId: leadId }; break; }
        }
      }
      try {
        const created_worker = await api.createWorker(cfg);
        if (cfg.role === "lead") leadIdByIndex.set(i, created_worker.id);
        setCreated((prev) => new Set([...prev, i]));
      } catch (e) {
        if (e instanceof AuthError) { onAuthError(); return; }
      }
    }
    await onDone();
  };

  const updateConfig = (idx: number, patch: Partial<Form>) => {
    setConfigs((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };

  // ── questions phase ──────────────────────────────────────────────────────
  if (phase === "questions") {
    return (
      <Card title={t("wizard_title")}>
        <p className="mb-4 text-xs text-fg-dim">{t("wizard_subtitle")}</p>
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs text-fg-faint">{t("wizard_goal_freeform_hint")}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {WIZARD_GOAL_EXAMPLES.map((ex) => {
                const Icon = ex.icon;
                const active = answers.goal === t(ex.goalKey);
                return (
                  <button
                    key={ex.labelKey}
                    type="button"
                    onClick={() => setAnswers({ ...answers, goal: t(ex.goalKey) })}
                    className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-center text-xs transition-colors ${
                      active
                        ? "bg-accent/10 border-accent/40 text-fg"
                        : "border-line text-fg-dim hover:text-fg hover:border-accent/40"
                    }`}
                  >
                    <Icon size={18} />
                    <span>{t(ex.labelKey)}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <Label>{t("wizard_q_goal")} <span className="text-critical-fg">*</span></Label>
            <TextArea
              rows={3}
              value={answers.goal}
              onChange={(e) => setAnswers({ ...answers, goal: e.target.value })}
              placeholder={t("wizard_q_goal_placeholder")}
            />
          </div>
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex items-center gap-1 text-xs text-fg-dim transition-colors hover:text-fg"
            >
              <ChevronDown size={14} className={`transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
              {showAdvanced ? t("wizard_advanced_toggle_hide") : t("wizard_advanced_toggle")}
            </button>
          </div>
          {showAdvanced && (
            <div className="space-y-4">
              <div>
                <Label>{t("wizard_q_context")}</Label>
                <TextArea
                  rows={2}
                  value={answers.context}
                  onChange={(e) => setAnswers({ ...answers, context: e.target.value })}
                  placeholder={t("wizard_q_context_placeholder")}
                />
                <p className="mt-1 text-xs text-fg-faint">{t("wizard_context_hint")}</p>
              </div>
              <div>
                <Label>{t("wizard_q_cwd")}</Label>
                <Input
                  value={answers.cwd}
                  onChange={(e) => setAnswers({ ...answers, cwd: e.target.value })}
                  placeholder={t("wizard_q_cwd_placeholder")}
                />
                <p className="mt-1 text-xs text-fg-faint">{t("wizard_q_cwd_help")}</p>
              </div>
              <div>
                <Label>{t("wizard_q_schedule")}</Label>
                <div className="mt-1 flex flex-wrap gap-2">
                  {WIZARD_SCHEDULE_CHIPS.map((chip) => (
                    <button
                      key={chip.labelKey}
                      type="button"
                      onClick={() => {
                        setScheduleChip(chip.value);
                        // "custom" reveals the raw input and keeps the current value;
                        // any other chip writes its mapped schedule string directly.
                        if (chip.value !== "custom") {
                          setAnswers({ ...answers, schedule: chip.value });
                        }
                      }}
                      className={`rounded px-3 py-1.5 text-xs border transition-colors ${
                        scheduleChip === chip.value
                          ? "bg-[var(--accent)] text-white border-transparent"
                          : "border-line text-fg-dim hover:text-fg"
                      }`}
                    >
                      {t(chip.labelKey)}
                    </button>
                  ))}
                </div>
                {scheduleChip === "custom" && (
                  <Input
                    className="mt-2"
                    value={answers.schedule}
                    onChange={(e) => setAnswers({ ...answers, schedule: e.target.value })}
                    placeholder={t("wizard_q_schedule_placeholder")}
                  />
                )}
              </div>
              <div>
                <Label>{t("wizard_q_crew")}</Label>
                <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                  {([false, true] as const).map((val) => (
                    <button
                      key={String(val)}
                      type="button"
                      onClick={() => setAnswers({ ...answers, crew: val })}
                      className={`flex-1 rounded px-3 py-2 text-left text-xs border transition-colors ${
                        answers.crew === val
                          ? "bg-accent/10 border-accent/40 text-fg"
                          : "border-line text-fg-dim hover:text-fg"
                      }`}
                    >
                      <span className="font-medium">{val ? t("wizard_opt_crew") : t("wizard_opt_single")}</span>
                      <span className="mt-0.5 block text-fg-faint">
                        {val ? t("wizard_opt_crew_desc") : t("wizard_opt_single_desc")}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          {genError && (
            <p className="rounded bg-critical-subtle px-3 py-2 text-xs text-critical-fg">
              {t("wizard_error").replace("{error}", genError)}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={generate}
              disabled={!answers.goal.trim()}
            >
              {t("wizard_next")}
            </Button>
            <Button onClick={onCancel}>{t("wizard_cancel")}</Button>
          </div>
        </div>
      </Card>
    );
  }

  // ── generating phase ─────────────────────────────────────────────────────
  if (phase === "generating") {
    return (
      <Card title={t("wizard_title")}>
        <p className="text-xs text-fg-dim animate-pulse">{t("wizard_generating")}</p>
      </Card>
    );
  }

  // ── review phase ─────────────────────────────────────────────────────────
  const allCreated = configs.length > 0 && configs.every((_, i) => created.has(i));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-fg">{t("wizard_result_title")}</h3>
          <p className="text-xs text-fg-dim">{t("wizard_result_subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => { setPhase("questions"); setGenError(null); }}>
            {t("wizard_back")}
          </Button>
          {configs.length > 1 && !allCreated && (
            <Button variant="primary" onClick={createAll}>
              {t("wizard_confirm_all").replace("{n}", String(configs.length))}
            </Button>
          )}
          {allCreated && (
            <Button variant="primary" onClick={onDone}>
              {t("wizard_done")}
            </Button>
          )}
        </div>
      </div>

      {configs.map((cfg, idx) => (
        <Card key={idx} title={cfg.name || `Agent ${idx + 1}`}>
          {created.has(idx) ? (
            <p className="text-xs text-ok-fg">{t("wizard_created")}</p>
          ) : (
            <WizardConfigEditor
              form={cfg}
              onChange={(patch) => updateConfig(idx, patch)}
              providers={providers}
              workers={workers}
              onAuthError={onAuthError}
              onConfirm={() => createOne(idx)}
            />
          )}
        </Card>
      ))}
    </div>
  );
}

function WizardConfigEditor({
  form,
  onChange,
  providers,
  onAuthError,
  onConfirm,
}: {
  form: Form;
  onChange: (patch: Partial<Form>) => void;
  providers: NamedProvider[];
  workers: Worker[];
  onAuthError: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [platform, setPlatform] = useState("");

  // Capture the host platform so the cwd placeholder hint shows a matching
  // (Windows vs Unix) path example.
  useEffect(() => {
    api.me().then((m) => setPlatform(m.platform)).catch(() => {});
  }, []);

  const fetchModels = async (): Promise<string[]> => {
    if (!form.providerId) return [];
    try {
      return (await api.providerModels(form.providerId)).models;
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      return [];
    }
  };

  const confirm = async () => {
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <AvatarPicker
        id={form.name || "new-worker"}
        value={form.avatar}
        onChange={(slug) => onChange({ avatar: slug })}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>{t("workers_name")}</Label>
          <Input value={form.name} onChange={(e) => onChange({ name: e.target.value })} />
        </div>
        <div>
          <Label>{t("workers_cwd")}</Label>
          <Input
            value={form.cwd}
            onChange={(e) => onChange({ cwd: e.target.value })}
            placeholder={t(cwdPlaceholderKey(platform))}
          />
        </div>
      </div>
      <div>
        <Label>{t("workers_task")}</Label>
        <TextArea
          rows={4}
          value={form.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
      </div>
      <div>
        <Label>{t("workers_persona_label")}</Label>
        <TextArea
          rows={2}
          value={form.persona}
          onChange={(e) => onChange({ persona: e.target.value })}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>{t("workers_schedule")}</Label>
          <Input
            value={form.when}
            onChange={(e) => onChange({ when: e.target.value })}
            placeholder={t("workers_schedule_placeholder")}
          />
        </div>
        <div>
          <Label>{t("autonomy")}</Label>
          <div className="mt-1 flex gap-1.5">
            {(["supervised", "standard", "full"] as Autonomy[]).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => onChange({ autonomy: a })}
                className={`rounded px-2 py-1 text-xs border transition-colors ${
                  form.autonomy === a
                    ? "bg-[var(--accent)] text-white border-transparent"
                    : "border-line text-fg-dim hover:text-fg"
                }`}
              >
                {t(AUTONOMY_KEY[a])}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-fg-faint">{t(AUTONOMY_DESC_KEY[form.autonomy])}</p>
        </div>
        {(form.role === "lead" || form.role === "assistant") && (
          <div>
            <Label>{t("wizard_portfolio")}</Label>
            <Input value={form.portfolio} onChange={(e) => onChange({ portfolio: e.target.value })} />
          </div>
        )}
        <div>
          <Label>{t("workers_role")}</Label>
          <Select
            value={form.role}
            onChange={(e) => onChange({ role: e.target.value as Form["role"] })}
          >
            <option value="">{t("workers_role_specialist")}</option>
            <option value="lead">{t("workers_role_lead")}</option>
            <option value="assistant">{t("workers_role_assistant")}</option>
          </Select>
        </div>
        <div>
          <Label>{t("workers_model")}</Label>
          <ModelSelect
            value={form.model}
            onChange={(model) => onChange({ model })}
            suggestions={form.providerId ? [] : MODEL_SUGGESTIONS}
            onFetch={form.providerId ? fetchModels : undefined}
            fetchLabel={t("fetch")}
            placeholder={form.providerId ? t("workers_model_local") : t("workers_model_default")}
          />
        </div>
        <div>
          <Label>{t("workers_provider")}</Label>
          <Select value={form.providerId} onChange={(e) => onChange({ providerId: e.target.value })}>
            <option value="">{t("workers_anthropic_default")}</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
      </div>
      {form.systemPrompt && (
        <div>
          <Label>{t("workers_domain")}</Label>
          <TextArea rows={3} value={form.systemPrompt} onChange={(e) => onChange({ systemPrompt: e.target.value })} />
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <Button
          variant="primary"
          onClick={confirm}
          disabled={busy || !form.name.trim() || !form.cwd.trim() || !form.prompt.trim()}
        >
          {busy ? t("saving") : t("wizard_confirm_one")}
        </Button>
      </div>
    </div>
  );
}

// ─── Live output ─────────────────────────────────────────────────────────────

function LiveOutput({ live }: { live?: LiveRun }) {
  const { t } = useI18n();
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [live?.output]);

  if (!live) return null;
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-fg-dim">
        {t("workers_live_output")}
        {live.status === "running" && <Badge tone="green">{t("workers_streaming")}</Badge>}
        {live.tool && <span className="font-mono normal-case text-fg-faint">🔧 {live.tool}</span>}
      </div>
      <pre
        ref={ref}
        className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-input p-3 text-xs text-fg-muted"
      >
        {live.output || "…"}
      </pre>
    </div>
  );
}

/**
 * Avatar picker: shows the worker's current avatar at ~80px and a Shuffle button
 * that cycles to the next slug in the curated set. No upload — only the cycle.
 * `id` seeds the deterministic default so the preview matches the row/Crew view
 * when no explicit avatar is set yet.
 */
function AvatarPicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (slug: string) => void;
}) {
  const { t } = useI18n();
  const list = useAvatarList();
  // Slugs to cycle through: the fetched set when loaded, else the embedded list.
  // Reserved slugs (e.g. "robot" = Atlas's fixed identity) are excluded from
  // Lead assignment. The embedded fallback has no reserved flags, so drop the
  // known reserved slug there too.
  const slugs =
    list.length > 0
      ? list.filter((a) => !a.reserved).map((a) => a.slug)
      : AVATAR_SLUGS.filter((s) => s !== "robot");
  // The slug shown now (explicit value or the deterministic default for this id).
  const current = resolveAvatarSlug(id, value);
  const shuffle = () => {
    const i = slugs.indexOf(current);
    const next = slugs[(i + 1) % slugs.length] ?? slugs[0];
    onChange(next);
  };
  const label = list.find((a) => a.slug === current)?.label ?? current;

  return (
    <div>
      <Label>{t("workers_avatar_label")}</Label>
      <div className="mt-1 flex items-center gap-3">
        <Avatar id={id} avatar={value} size={80} alt={label} />
        <div className="flex flex-col items-start gap-1.5">
          <Button onClick={shuffle} className="inline-flex items-center gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            {t("workers_avatar_shuffle")}
          </Button>
          <span className="text-xs text-fg-faint">{label}</span>
        </div>
      </div>
    </div>
  );
}

function WorkerForm({
  skills,
  providers,
  backends,
  workers,
  initial,
  seedId,
  enabled: initialEnabled = true,
  onCancel,
  onSubmit,
  onAuthError,
}: {
  skills: Named[];
  providers: NamedProvider[];
  backends: NamedBackend[];
  workers: Worker[];
  initial: Form;
  /** Stable id seeding the avatar's deterministic default (worker id when
   *  editing; absent for a brand-new worker, where the default is fixed). */
  seedId?: string;
  enabled?: boolean;
  onCancel: () => void;
  onSubmit: (form: Form, enabled: boolean) => Promise<void>;
  onAuthError: () => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<Form>(initial);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [platform, setPlatform] = useState("");
  const [defaultWorkdir, setDefaultWorkdir] = useState<string>("");
  const [knownPaths, setKnownPaths] = useState<Array<{ label: string; path: string }>>([]);

  // Prefill the working directory with the user's home dir for a brand-new
  // worker (empty cwd), so the form can be saved straight away instead of the
  // save button staying greyed out until a path is typed. The user can edit it.
  // Also capture the host platform so the placeholder hint shows a matching
  // (Windows vs Unix) path example.
  useEffect(() => {
    api
      .me()
      .then((m) => {
        setPlatform(m.platform);
        setDefaultWorkdir(m.defaultWorkdir);
        setForm((f) => (f.cwd.trim() ? f : { ...f, cwd: m.defaultWorkdir }));
      })
      .catch(() => {});
    api
      .agent()
      .then((a) => setKnownPaths(a.knownPaths ?? []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchModels = async (): Promise<string[]> => {
    if (!form.providerId) return [];
    try {
      return (await api.providerModels(form.providerId)).models;
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      return [];
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit(form, enabled);
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <AvatarPicker
        id={seedId || "new-worker"}
        value={form.avatar}
        onChange={(slug) => setForm({ ...form, avatar: slug })}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>{t("workers_name")}</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <Label>{t("workers_cwd")}</Label>
          <Input
            value={form.cwd}
            onChange={(e) => setForm({ ...form, cwd: e.target.value })}
            placeholder={t(cwdPlaceholderKey(platform))}
          />
          {(defaultWorkdir || knownPaths.length > 0) && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {defaultWorkdir && (
                <button
                  type="button"
                  onClick={() => setForm({ ...form, cwd: defaultWorkdir })}
                  className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs bg-accent/10 text-accent hover:bg-accent/20 transition-colors border border-accent/20"
                >
                  <span className="opacity-60">⌂</span>
                  {t("workers_cwd_default")}
                </button>
              )}
              {knownPaths.map((kp) => (
                <button
                  key={kp.label}
                  type="button"
                  onClick={() => setForm({ ...form, cwd: kp.path })}
                  className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs bg-surface text-fg-dim hover:text-fg hover:bg-accent/10 transition-colors border border-line"
                >
                  {kp.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div>
        <Label>{t("workers_task")}</Label>
        <TextArea
          rows={4}
          value={form.prompt}
          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          placeholder={t("workers_task_placeholder")}
        />
      </div>
      <div>
        <Label>{t("workers_persona_label")}</Label>
        <p className="-mt-0.5 mb-1.5 text-xs text-fg-faint">{t("workers_persona_sub")}</p>
        <div className="flex flex-wrap gap-1 mb-1.5">
          {PERSONA_PRESETS.map((p) => (
            <button
              key={p.labelKey}
              type="button"
              title={t(p.descKey)}
              onClick={() => setForm({ ...form, persona: p.value })}
              className={`rounded px-2 py-0.5 text-xs border transition-colors ${
                form.persona === p.value
                  ? "bg-[var(--accent)] text-white border-transparent"
                  : "border-line text-fg-dim hover:text-fg"
              }`}
            >
              {t(p.labelKey)}
            </button>
          ))}
          {form.persona && !PERSONA_PRESETS.find((p) => p.value === form.persona) && (
            <span className="rounded px-2 py-0.5 text-xs border border-line text-fg-dim">{t("workers_custom")}</span>
          )}
        </div>
        <TextArea
          rows={2}
          value={form.persona}
          onChange={(e) => setForm({ ...form, persona: e.target.value })}
          placeholder={t("workers_persona_placeholder")}
        />
      </div>
      <div>
        <Label>{t("workers_domain")}</Label>
        <p className="-mt-0.5 mb-1.5 text-xs text-fg-faint">{t("workers_domain_sub")}</p>
        <TextArea
          rows={3}
          value={form.systemPrompt}
          onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>{t("workers_ai_backend")}</Label>
          <Select
            value={form.backendId}
            onChange={(e) => {
              const v = e.target.value;
              // Provider/model only mean anything for the Claude backend —
              // clear them so a stale Claude model id can't be sent to a
              // different backend's CLI (which would reject it).
              setForm(v ? { ...form, backendId: v, providerId: "", model: "" } : { ...form, backendId: v });
            }}
          >
            <option value="">{t("workers_ai_backend_default")}</option>
            {backends
              .filter((b) => b.id !== "claude-agent-sdk")
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.displayName}
                </option>
              ))}
          </Select>
          <p className="mt-1 text-xs text-fg-faint">{t("workers_ai_backend_hint")}</p>
        </div>
        {form.backendId && (
          <div>
            <Label>{t("workers_model")}</Label>
            <p className="mt-1 text-xs text-fg-faint">{t("workers_ai_backend_no_model")}</p>
          </div>
        )}
        {!form.backendId && (
          <>
            <div>
              <Label>{t("workers_provider")}</Label>
              <Select
                value={form.providerId}
                onChange={(e) => setForm({ ...form, providerId: e.target.value })}
              >
                <option value="">{t("workers_anthropic_default")}</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>{t("workers_model")}</Label>
              <ModelSelect
                value={form.model}
                onChange={(model) => setForm({ ...form, model })}
                suggestions={form.providerId ? [] : MODEL_SUGGESTIONS}
                onFetch={form.providerId ? fetchModels : undefined}
                fetchLabel={t("fetch")}
                placeholder={form.providerId ? t("workers_model_local") : t("workers_model_default")}
              />
              {!form.providerId && (
                <p className="mt-1 text-xs text-fg-faint">
                  {t("workers_model_hint")} {t("workers_model_hint_url")}
                </p>
              )}
            </div>
          </>
        )}
        <div>
          <Label>{t("workers_skill")}</Label>
          <Select
            value={form.skillId}
            onChange={(e) => setForm({ ...form, skillId: e.target.value })}
          >
            <option value="">{t("workers_skill_none")}</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-fg-faint">{t("workers_skill_hint")}</p>
        </div>
        <div>
          <Label>{t("workers_schedule")}</Label>
          <Input
            value={form.when}
            onChange={(e) => setForm({ ...form, when: e.target.value })}
            placeholder={t("workers_schedule_placeholder")}
          />
        </div>
        <div>
          <Label>{t("workers_role")}</Label>
          <Select
            value={form.role}
            onChange={(e) =>
              setForm({ ...form, role: e.target.value as Form["role"] })
            }
          >
            <option value="">{t("workers_role_specialist")}</option>
            <option value="lead">{t("workers_role_lead")}</option>
            <option value="assistant">{t("workers_role_assistant")}</option>
          </Select>
          <p className="mt-1 text-xs text-fg-faint">
            {t(
              form.role === "lead"
                ? "workers_role_hint_lead"
                : form.role === "assistant"
                  ? "workers_role_hint_assistant"
                  : "workers_role_hint_specialist",
            )}
          </p>
        </div>
        {(form.role === "lead" || form.role === "assistant") && (
          <div>
            <Label>{t("workers_portfolio")}</Label>
            <Input
              value={form.portfolio}
              onChange={(e) => setForm({ ...form, portfolio: e.target.value })}
              placeholder={t("workers_role_portfolio_placeholder")}
            />
          </div>
        )}
        {form.role === "assistant" && (
          <div>
            <Label>{t("workers_parent")}</Label>
            <Select
              value={form.parentId}
              onChange={(e) => setForm({ ...form, parentId: e.target.value })}
            >
              <option value="">{t("workers_parent_none")}</option>
              {workers
                .filter((w) => w.role === "lead")
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </Select>
          </div>
        )}
        {form.role === "lead" && (
          <div>
            <Label>{t("workers_token")}</Label>
            <Input
              value={form.telegramToken}
              onChange={(e) => setForm({ ...form, telegramToken: e.target.value })}
              placeholder={t("workers_token_placeholder_friendly")}
            />
            <p className="mt-1 text-xs text-fg-faint">{t("workers_token_hint")}</p>
          </div>
        )}
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-sm text-fg-muted">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent)]"
            />
            {t("workers_enabled")}
          </label>
        </div>
        <div>
          <Label>{t("autonomy")}</Label>
          <div className="mt-1 flex gap-1.5">
            {(["supervised", "standard", "full"] as Autonomy[]).map((a) => (
              <button
                key={a}
                onClick={() => setForm({ ...form, autonomy: a })}
                className={`rounded px-2 py-1 text-xs border transition-colors ${
                  form.autonomy === a
                    ? "bg-[var(--accent)] text-white border-transparent"
                    : "border-line text-fg-dim hover:text-fg"
                }`}
              >
                {t(AUTONOMY_KEY[a])}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-fg-faint">{t(AUTONOMY_DESC_KEY[form.autonomy])}</p>
        </div>
        <div>
          <Label>{t("workers_lang_label")}</Label>
          <Select
            value={form.language}
            onChange={(e) => setForm({ ...form, language: e.target.value })}
          >
            <option value="">{t("workers_lang_default")}</option>
            {Object.entries(AGENT_LANGUAGES).map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </Select>
        </div>
        {form.role === "lead" && (
          <div>
            <Label>{t("workers_stream_mode_label")}</Label>
            <Select
              value={form.streamMode}
              onChange={(e) => setForm({ ...form, streamMode: e.target.value as "" | "rich" | "draft" | "edit" })}
            >
              <option value="">{t("workers_stream_mode_default")}</option>
              <option value="rich">{t("workers_stream_mode_rich")}</option>
              <option value="draft">{t("workers_stream_mode_draft")}</option>
              <option value="edit">{t("workers_stream_mode_edit")}</option>
            </Select>
            <p className="mt-1 text-xs text-fg-faint">{t("workers_stream_mode_hint")}</p>
          </div>
        )}
      </div>
      <div>
        <Label>{t("workers_webhook")}</Label>
        <Input
          value={form.webhookUrl}
          onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })}
          placeholder={t("workers_webhook_placeholder")}
        />
        <p className="mt-1 text-xs text-fg-faint">{t("workers_webhook_hint")}</p>
      </div>
      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={submit}
          disabled={busy || !form.name.trim() || !form.cwd.trim() || !form.prompt.trim()}
        >
          {busy ? t("saving") : t("workers_save")}
        </Button>
        <Button onClick={onCancel}>{t("cancel")}</Button>
      </div>
    </div>
  );
}
