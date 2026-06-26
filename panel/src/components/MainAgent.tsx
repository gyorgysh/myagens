import { useEffect, useId, useState } from "react";
import { api, AuthError, type MainAgent, type Autonomy, type EmbeddingConfig, type OllamaStatus } from "../api.ts";
import { Badge, Button, Callout, Card, Input, Label, Select, TextArea } from "./ui.tsx";
import { useI18n } from "../lib/useI18n.ts";
import type { TranslationKey } from "../i18n/en.ts";

const MODEL_SUGGESTIONS = ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-8"];

const PERSONA_PRESETS: Array<{ label: TranslationKey; value: string }> = [
  { label: "settings_persona_concise", value: "Concise and direct. Lead with the result, skip preamble, use short sentences." },
  { label: "settings_persona_warm", value: "Warm and encouraging. Acknowledge effort, celebrate wins, frame challenges positively." },
  { label: "settings_persona_formal", value: "Formal and precise. Use structured language, avoid contractions and casual expressions." },
  { label: "settings_persona_analytical", value: "Analytical and methodical. Think through problems step by step, cite specifics." },
  { label: "settings_persona_playful", value: "Witty and playful. Use light humor, analogies, and keep the energy high." },
];

const AUTONOMY_OPTIONS: Array<{ value: Autonomy; label: TranslationKey; description: TranslationKey }> = [
  { value: "supervised", label: "supervised", description: "settings_autonomy_supervised_desc" },
  { value: "standard", label: "standard", description: "settings_autonomy_standard_desc" },
  { value: "full", label: "full", description: "settings_autonomy_full_desc" },
];

/** Configure the main bot agent: model, provider, persona, autonomy, lifecycle controls. */
export function MainAgentCard({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [agent, setAgent] = useState<MainAgent | null>(null);
  const [model, setModel] = useState("");
  const [providerId, setProviderId] = useState("");
  const [persona, setPersona] = useState("");
  const [autonomy, setAutonomy] = useState<Autonomy>("standard");
  const [embeddings, setEmbeddings] = useState<EmbeddingConfig | null>(null);
  const [embEnabled, setEmbEnabled] = useState(false);
  const [embProvider, setEmbProvider] = useState<"ollama" | "openai">("ollama");
  const [embBaseUrl, setEmbBaseUrl] = useState("");
  const [embModel, setEmbModel] = useState("");
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [fetched, setFetched] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const listId = useId();

  const load = () =>
    api
      .agent()
      .then((a) => {
        setAgent(a);
        setModel(a.model);
        setProviderId(a.providerId);
        setPersona(a.persona ?? "");
        setAutonomy(a.autonomy ?? "standard");
        setEmbeddings(a.embeddings);
        setEmbEnabled(a.embeddings.enabled);
        setEmbProvider(a.embeddings.provider);
        setEmbBaseUrl(a.embeddings.baseUrl);
        setEmbModel(a.embeddings.model);
      })
      .catch((e) => e instanceof AuthError && onAuthError());

  useEffect(() => {
    void load();
    // Best-effort: probe for a locally running Ollama to offer one-click connect.
    api.ollamaStatus().then(setOllama).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!agent) return null;

  const dirty =
    model !== agent.model ||
    providerId !== agent.providerId ||
    persona !== (agent.persona ?? "") ||
    autonomy !== (agent.autonomy ?? "standard");

  const flash = (m: string) => {
    setStatus(m);
    setTimeout(() => setStatus(null), 2500);
  };

  const save = async () => {
    setBusy("save");
    try {
      const next = await api.saveAgent({ model, providerId, persona, autonomy });
      setAgent(next);
      flash(t("agent_saved"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      flash(String(e));
    } finally {
      setBusy(null);
    }
  };

  const fetchModels = async () => {
    if (!providerId) return;
    setBusy("fetch");
    try {
      setFetched((await api.providerModels(providerId)).models);
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    if (!confirm(t("settings_reset_confirm"))) return;
    setBusy("reset");
    try {
      const r = await api.resetAgent();
      flash(t("settings_reset_done").replace("{sessions}", String(r.sessions)).replace("{aborted}", String(r.aborted)));
    } finally {
      setBusy(null);
    }
  };

  const saveEmbeddingSettings = async () => {
    setBusy("emb");
    try {
      const r = await api.saveEmbeddings({ enabled: embEnabled, provider: embProvider, baseUrl: embBaseUrl, model: embModel });
      setEmbeddings(r.embeddings);
      flash(t("agent_saved"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      flash(String(e));
    } finally {
      setBusy(null);
    }
  };

  // One-click: register Ollama as a provider + enable embeddings against it.
  const connectOllama = async () => {
    setBusy("ollama");
    try {
      const r = await api.ollamaConnect();
      setOllama(r.status);
      // Reflect the (possibly) freshly-enabled embeddings into the form + agent.
      if (r.embeddingsEnabled) {
        setEmbEnabled(r.status.embeddingsOn);
        setEmbProvider("ollama");
        setEmbBaseUrl(r.status.baseUrl);
        setEmbModel("nomic-embed-text");
        await load();
      }
      flash(t("ollama_connected"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      flash(String(e));
    } finally {
      setBusy(null);
    }
  };

  const restart = async () => {
    if (!confirm(t("settings_restart_confirm"))) return;
    setBusy("restart");
    try {
      await api.restartAgent();
      flash(t("agent_restarting"));
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={agent.effectiveModel ? `${agent.effectiveModel}` : t("agent_main_title")}
      right={<Badge tone="blue">{agent.effectiveModel}</Badge>}
    >
      <p className="mb-3 text-sm text-fg-dim">
        {t("agent_desc_pre")}<code>claude</code>{t("agent_desc_post")}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>{t("provider")}</Label>
          <Select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">{t("settings_anthropic_default")}</option>
            {agent.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>{t("model")}</Label>
          <div className="flex gap-2">
            <Input
              list={listId}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={providerId ? t("settings_model_local") : t("settings_model_default")}
            />
            {providerId && (
              <Button onClick={fetchModels} disabled={busy === "fetch"} className="shrink-0">
                {busy === "fetch" ? "…" : t("fetch")}
              </Button>
            )}
          </div>
          <datalist id={listId}>
            {[...new Set([...(providerId ? fetched : MODEL_SUGGESTIONS), ...fetched])].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
      </div>

      <div className="mt-3">
        <Label>{t("agent_persona_label")}</Label>
        <div className="flex flex-wrap gap-1 mb-1.5">
          {PERSONA_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setPersona(p.value)}
              className={`rounded px-2 py-0.5 text-xs border transition-colors ${
                persona === p.value
                  ? "bg-[var(--accent)] text-white border-transparent"
                  : "border-line text-fg-dim hover:text-fg"
              }`}
            >
              {t(p.label)}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPersona("")}
            className={`rounded px-2 py-0.5 text-xs border transition-colors ${
              !persona
                ? "bg-[var(--accent)] text-white border-transparent"
                : "border-line text-fg-dim hover:text-fg"
            }`}
          >
            {t("agent_default")}
          </button>
          {persona && !PERSONA_PRESETS.find((p) => p.value === persona) && (
            <span className="rounded px-2 py-0.5 text-xs border border-line text-fg-dim">{t("agent_custom")}</span>
          )}
        </div>
        <TextArea
          rows={2}
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          placeholder={t("settings_persona_placeholder")}
        />
      </div>

      <div className="mt-3">
        <Label>{t("autonomy")}</Label>
        <div className="mt-1 flex gap-2 flex-wrap">
          {AUTONOMY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setAutonomy(opt.value)}
              title={t(opt.description)}
              className={`rounded px-2.5 py-1 text-xs font-medium border transition-colors ${
                autonomy === opt.value
                  ? "bg-[var(--accent)] text-white border-transparent"
                  : "border-line text-fg-dim hover:text-fg"
              }`}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </div>

      {embeddings && (
        <div className="mt-4 border-t border-line pt-4">
          <div className="flex items-center justify-between mb-2">
            <Label>{t("settings_embeddings")}</Label>
            <button
              type="button"
              role="switch"
              aria-checked={embEnabled}
              onClick={() => setEmbEnabled((v) => !v)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${embEnabled ? "bg-accent" : "bg-line"}`}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${embEnabled ? "translate-x-4" : "translate-x-1"}`} />
            </button>
          </div>
          {ollama?.running && (
            <div className="mb-3">
              <Callout title={t("ollama_detected_title")}>
                <div className="space-y-2">
                  <p>
                    {t("ollama_detected_body").replace("{count}", String(ollama.models.length))}
                  </p>
                  {!ollama.hasEmbedModel && (
                    <p className="text-fg-faint">
                      {t("ollama_no_embed_model")} <code className="mono">ollama pull nomic-embed-text</code>
                    </p>
                  )}
                  {ollama.providerExists && ollama.embeddingsOn ? (
                    <p className="font-medium text-accent">{t("ollama_connected")}</p>
                  ) : (
                    <Button onClick={connectOllama} disabled={busy === "ollama"}>
                      {busy === "ollama" ? t("ollama_connecting") : t("ollama_connect")}
                    </Button>
                  )}
                </div>
              </Callout>
            </div>
          )}
          {embEnabled && (
            <div className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <Label>{t("settings_emb_provider")}</Label>
                  <Select value={embProvider} onChange={(e) => setEmbProvider(e.target.value as "ollama" | "openai")}>
                    <option value="ollama">Ollama</option>
                    <option value="openai">OpenAI / LM Studio</option>
                  </Select>
                </div>
                <div>
                  <Label>{t("settings_emb_base_url")}</Label>
                  <Input value={embBaseUrl} onChange={(e) => setEmbBaseUrl(e.target.value)} placeholder="http://localhost:11434" />
                </div>
                <div>
                  <Label>{t("settings_emb_model")}</Label>
                  <Input value={embModel} onChange={(e) => setEmbModel(e.target.value)} placeholder="nomic-embed-text" />
                </div>
              </div>
            </div>
          )}
          <div className="mt-2">
            <Button onClick={saveEmbeddingSettings} disabled={busy === "emb"}>
              {busy === "emb" ? t("saving") : t("save")}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={save} disabled={!dirty || busy === "save"}>
          {busy === "save" ? t("saving") : t("save")}
        </Button>
        <Button onClick={reset} disabled={busy === "reset"}>
          {t("settings_new_context")}
        </Button>
        <Button
          variant="danger"
          onClick={restart}
          disabled={!agent.serviceInstalled || busy === "restart"}
          title={agent.serviceInstalled ? "" : t("settings_no_service")}
        >
          {t("settings_restart_service")}
        </Button>
        {status && <span className="text-xs text-fg-dim">{status}</span>}
      </div>
    </Card>
  );
}
