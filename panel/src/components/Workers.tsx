import { useEffect, useId, useRef, useState } from "react";
import { api, AuthError, type Worker, type WorkerRun, type Autonomy } from "../api.ts";
import { useWorkerEvents, type LiveRun } from "../lib/useWorkerEvents.ts";
import { useI18n } from "../lib/useI18n.ts";
import type { TranslationKey } from "../i18n/en.ts";
import { Badge, Button, Card, Empty, Input, Label, Select, TextArea } from "./ui.tsx";
import { ms, relTime, usd } from "../lib/format.ts";
import { AGENT_LANGUAGES } from "../i18n/languages.ts";

const emptyForm = {
  name: "",
  cwd: "",
  prompt: "",
  model: "",
  providerId: "",
  systemPrompt: "",
  skillId: "",
  when: "",
  role: "" as "" | "lead" | "assistant",
  portfolio: "",
  parentId: "",
  telegramToken: "",
  persona: "",
  autonomy: "full" as Autonomy,
  language: "",
};
type Form = typeof emptyForm;

type Named = { id: string; name: string };

/** Short, readable label for a model id badge (e.g. "haiku-4-5"). */
function shortModel(id: string): string {
  return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

// Suggested Anthropic model ids (free-text, so local model names work too).
const MODEL_SUGGESTIONS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-8",
];

const PERSONA_PRESETS: Array<{ labelKey: TranslationKey; value: string }> = [
  { labelKey: "settings_persona_concise", value: "Concise and direct. Lead with the result, skip preamble, use short sentences." },
  { labelKey: "settings_persona_warm", value: "Warm and encouraging. Acknowledge effort, celebrate wins, frame challenges positively." },
  { labelKey: "settings_persona_formal", value: "Formal and precise. Use structured language, avoid contractions and casual expressions." },
  { labelKey: "settings_persona_analytical", value: "Analytical and methodical. Think through problems step by step, cite specifics." },
  { labelKey: "settings_persona_playful", value: "Witty and playful. Use light humor, analogies, and keep the energy high." },
];

const AUTONOMY_KEY: Record<Autonomy, TranslationKey> = {
  supervised: "supervised",
  standard: "standard",
  full: "full",
  auto_until_error: "auto_until_error",
};

export function WorkersView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [skills, setSkills] = useState<Named[]>([]);
  const [providers, setProviders] = useState<Named[]>([]);
  const [creating, setCreating] = useState(false);
  const [wizarding, setWizarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useWorkerEvents();

  const load = () =>
    api
      .workers()
      .then((r) => {
        setWorkers(r.workers);
        setSkills(r.skills);
        setProviders(r.providers);
      })
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));

  useEffect(() => {
    void load();
    // Refresh registry periodically so schedule/running state stays current.
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <Empty>{t("workers_failed_load").replace("{error}", error)}</Empty>;

  return (
    <div className="space-y-4">

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg-dim">{t("workers_crew")}</h2>
        {!creating && !wizarding && (
          <div className="flex gap-2">
            <Button onClick={() => setWizarding(true)}>
              {t("workers_wizard")}
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t("workers_new")}
            </Button>
          </div>
        )}
      </div>

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
          <WorkerForm
            skills={skills}
            providers={providers}
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

      {workers.length === 0 && !creating ? (
        <Empty>{t("workers_empty")}</Empty>
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
              workers={workers}
              live={live[w.id]}
              onChange={load}
              onAuthError={onAuthError}
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
  workers,
  live,
  onChange,
  onAuthError,
}: {
  worker: Worker;
  skills: Named[];
  providers: Named[];
  workers: Worker[];
  live?: LiveRun;
  onChange: () => void;
  onAuthError: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<WorkerRun[]>([]);
  const running = worker.running || live?.status === "running";
  const providerName = providers.find((p) => p.id === worker.providerId)?.name;

  const loadRuns = () => api.workerRuns(worker.id).then((r) => setRuns(r.runs));
  useEffect(() => {
    if (open) void loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, live?.status]);

  const run = async () => {
    try {
      await api.runWorker(worker.id);
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
    if (!confirm(t("workers_delete_confirm").replace("{name}", worker.name))) return;
    await api.deleteWorker(worker.id);
    onChange();
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{worker.name}</span>
        {worker.role === "lead" && <Badge tone="blue">{t("workers_lead")}</Badge>}
        {worker.role === "assistant" && <Badge tone="zinc">{t("workers_assistant")}</Badge>}
        {worker.portfolio && <Badge>{worker.portfolio}</Badge>}
        <Badge tone={worker.schedule === "manual" ? "zinc" : "blue"}>{worker.schedule}</Badge>
        {worker.model && <Badge>{shortModel(worker.model)}</Badge>}
        {providerName && <Badge tone="blue">⌂ {providerName}</Badge>}
        {!worker.enabled && <Badge tone="amber">{t("disabled")}</Badge>}
        {running && <Badge tone="green">{t("running")}</Badge>}
        <span className="ml-auto flex gap-1.5">
          {running ? (
            <Button variant="danger" onClick={stop}>
              {t("stop")}
            </Button>
          ) : (
            <Button variant="primary" onClick={run}>
              {t("workers_run_now")}
            </Button>
          )}
          <Button onClick={() => setOpen((o) => !o)}>{open ? t("hide") : t("details")}</Button>
          <Button onClick={() => setEditing((e) => !e)}>{t("edit")}</Button>
          <Button variant="danger" onClick={del}>
            {t("delete")}
          </Button>
        </span>
      </div>

      <div className="mt-1 truncate font-mono text-xs text-fg-faint" title={worker.cwd}>
        {worker.cwd || t("workers_no_cwd")}
        {worker.nextRunAt && ` · ${t("workers_next").replace("{time}", relTime(worker.nextRunAt))}`}
      </div>

      {editing && (
        <div className="mt-3 border-t border-line pt-3">
          <WorkerForm
            skills={skills}
            providers={providers}
            workers={workers}
            initial={{
              name: worker.name,
              cwd: worker.cwd,
              prompt: worker.prompt,
              model: worker.model,
              providerId: worker.providerId,
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
                  <div key={r.id} className="flex items-center gap-2 text-xs">
                    <Badge tone={r.status === "ok" ? "green" : r.status === "error" ? "amber" : "zinc"}>
                      {r.status}
                    </Badge>
                    <span className="tabular text-fg-dim">{relTime(r.startedAt)}</span>
                    {r.durationMs != null && (
                      <span className="tabular text-fg-faint">{ms(r.durationMs)}</span>
                    )}
                    {r.costUsd != null && (
                      <span className="tabular text-fg-faint">{usd(r.costUsd)}</span>
                    )}
                    {r.error && <span className="truncate text-red-400">{r.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
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
  providers: Named[];
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
  const [configs, setConfigs] = useState<Form[]>([]);
  const [created, setCreated] = useState<Set<number>>(new Set());
  const [genError, setGenError] = useState<string | null>(null);

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
      }));
      setConfigs(forms);
      setCreated(new Set());
      setPhase("review");
    } catch (e) {
      if (e instanceof AuthError) { onAuthError(); return; }
      setGenError(String(e));
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
            <Label>{t("wizard_q_goal")} <span className="text-red-400">*</span></Label>
            <TextArea
              rows={3}
              value={answers.goal}
              onChange={(e) => setAnswers({ ...answers, goal: e.target.value })}
              placeholder={t("wizard_q_goal_placeholder")}
            />
          </div>
          <div>
            <Label>{t("wizard_q_context")}</Label>
            <TextArea
              rows={2}
              value={answers.context}
              onChange={(e) => setAnswers({ ...answers, context: e.target.value })}
              placeholder={t("wizard_q_context_placeholder")}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{t("wizard_q_cwd")}</Label>
              <Input
                value={answers.cwd}
                onChange={(e) => setAnswers({ ...answers, cwd: e.target.value })}
                placeholder={t("wizard_q_cwd_placeholder")}
              />
            </div>
            <div>
              <Label>{t("wizard_q_schedule")}</Label>
              <Input
                value={answers.schedule}
                onChange={(e) => setAnswers({ ...answers, schedule: e.target.value })}
                placeholder={t("wizard_q_schedule_placeholder")}
              />
            </div>
          </div>
          <div>
            <Label>{t("wizard_q_crew")}</Label>
            <div className="mt-1 flex gap-2">
              {([false, true] as const).map((val) => (
                <button
                  key={String(val)}
                  type="button"
                  onClick={() => setAnswers({ ...answers, crew: val })}
                  className={`rounded px-3 py-1.5 text-xs border transition-colors ${
                    answers.crew === val
                      ? "bg-[var(--accent)] text-white border-transparent"
                      : "border-line text-fg-dim hover:text-fg"
                  }`}
                >
                  {val ? t("wizard_opt_crew") : t("wizard_opt_single")}
                </button>
              ))}
            </div>
          </div>
          {genError && (
            <p className="rounded bg-red-500/10 px-3 py-2 text-xs text-red-400">
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
              Done
            </Button>
          )}
        </div>
      </div>

      {configs.map((cfg, idx) => (
        <Card key={idx} title={cfg.name || `Agent ${idx + 1}`}>
          {created.has(idx) ? (
            <p className="text-xs text-emerald-400">{t("wizard_created")}</p>
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
  providers: Named[];
  workers: Worker[];
  onAuthError: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [fetched, setFetched] = useState<string[]>([]);
  const listId = useId();

  const fetchModels = async () => {
    if (!form.providerId) return;
    try {
      const r = await api.providerModels(form.providerId);
      setFetched(r.models);
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    }
  };

  const confirm = async () => {
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
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
            placeholder={t("workers_cwd_placeholder")}
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
          <div className="flex gap-2">
            <Input
              list={listId}
              value={form.model}
              onChange={(e) => onChange({ model: e.target.value })}
              placeholder={form.providerId ? t("workers_model_local") : t("workers_model_default")}
            />
            {form.providerId && (
              <Button onClick={fetchModels} className="shrink-0">{t("fetch")}</Button>
            )}
          </div>
          <datalist id={listId}>
            {[...new Set([...(form.providerId ? fetched : MODEL_SUGGESTIONS), ...fetched])].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
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

function WorkerForm({
  skills,
  providers,
  workers,
  initial,
  enabled: initialEnabled = true,
  onCancel,
  onSubmit,
  onAuthError,
}: {
  skills: Named[];
  providers: Named[];
  workers: Worker[];
  initial: Form;
  enabled?: boolean;
  onCancel: () => void;
  onSubmit: (form: Form, enabled: boolean) => Promise<void>;
  onAuthError: () => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<Form>(initial);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [fetched, setFetched] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const listId = useId();

  const fetchModels = async () => {
    if (!form.providerId) return;
    setFetchingModels(true);
    try {
      const r = await api.providerModels(form.providerId);
      setFetched(r.models);
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    } finally {
      setFetchingModels(false);
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
            placeholder={t("workers_cwd_placeholder")}
          />
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
        <div className="flex flex-wrap gap-1 mb-1.5">
          {PERSONA_PRESETS.map((p) => (
            <button
              key={p.labelKey}
              type="button"
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
        <TextArea
          rows={3}
          value={form.systemPrompt}
          onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
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
          <div className="flex gap-2">
            <Input
              list={listId}
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder={form.providerId ? t("workers_model_local") : t("workers_model_default")}
            />
            {form.providerId && (
              <Button onClick={fetchModels} disabled={fetchingModels} className="shrink-0">
                {fetchingModels ? "…" : t("fetch")}
              </Button>
            )}
          </div>
          <datalist id={listId}>
            {[...new Set([...(form.providerId ? fetched : MODEL_SUGGESTIONS), ...fetched])].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {form.providerId && fetched.length > 0 && (
            <p className="mt-1 text-xs text-fg-faint">{t("workers_models_available").replace("{n}", String(fetched.length))}</p>
          )}
        </div>
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
              placeholder={t("workers_token_placeholder")}
            />
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
