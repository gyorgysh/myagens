import { useEffect, useState } from "react";
import { api, AuthError, type MainAgent, type Autonomy, type Provider, type PlanView, type PlanType, type ProbeResult, type EmbeddingConfig, type OllamaStatus, type LmStudioStatus, type PreferredBackend, type PushView, type Branding, type PromptExcludeKey } from "../api.ts";
import { Accordion, Badge, Button, Card, Input, Label, ModelSelect, Select, Skeleton, TextArea } from "./ui.tsx";
import { MODEL_SUGGESTIONS } from "../lib/models.ts";
import { useI18n, INTERFACE_LANGUAGES } from "../lib/useI18n.ts";
import { useTheme, type Theme } from "../lib/useTheme.ts";
import { applyBranding } from "../lib/branding.ts";
import { errorMessage } from "../lib/errorMessage.ts";
import { toast } from "../lib/useToast.ts";
import type { TranslationKey } from "../i18n/en.ts";
import { AGENT_LANGUAGES } from "../i18n/languages.ts";
import { uptime } from "../lib/format.ts";
import { VaultView } from "./Vault.tsx";
import { ConnectorsView } from "./Connectors.tsx";
import { PromptView_ } from "./Prompt.tsx";
import { SkillsView } from "./Skills.tsx";
import { VoiceView } from "./Voice.tsx";

const PERSONA_PRESETS: Array<{ labelKey: TranslationKey; value: string }> = [
  { labelKey: "settings_persona_concise", value: "Concise and direct. Lead with the result, skip preamble, use short sentences." },
  { labelKey: "settings_persona_warm", value: "Warm and encouraging. Acknowledge effort, celebrate wins, frame challenges positively." },
  { labelKey: "settings_persona_formal", value: "Formal and precise. Use structured language, avoid contractions and casual expressions." },
  { labelKey: "settings_persona_analytical", value: "Analytical and methodical. Think through problems step by step, cite specifics." },
  { labelKey: "settings_persona_playful", value: "Witty and playful. Use light humor, analogies, and keep the energy high." },
];

const AUTONOMY_OPTIONS: Array<{ value: Autonomy; labelKey: TranslationKey; descKey: TranslationKey }> = [
  { value: "supervised", labelKey: "supervised", descKey: "settings_autonomy_supervised_desc" },
  { value: "standard", labelKey: "standard", descKey: "settings_autonomy_standard_desc" },
  { value: "full", labelKey: "full", descKey: "settings_autonomy_full_desc" },
  { value: "auto_until_error", labelKey: "auto_until_error", descKey: "settings_autonomy_auto_until_error_desc" },
];

export function SettingsView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-fg">{t("settings_title")}</h1>
      </div>
      <ServiceControl onAuthError={onAuthError} />
      <AppearanceSettings />
      <LanguageSettings onAuthError={onAuthError} />
      <MainAgentSettings onAuthError={onAuthError} />
      <KnownPathsSettings onAuthError={onAuthError} />
      <ProvidersSettings onAuthError={onAuthError} />
      <PlanBudgetSettings onAuthError={onAuthError} />
      <NotificationsSettings onAuthError={onAuthError} />
      <WhitelabelSettings onAuthError={onAuthError} />

      {/* Configuration — low-traffic config surfaces folded in as collapsible
          accordion sections (each remains deep-linkable via its own route). */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-dim">
          {t("settings_group_config")}
        </h2>
        <Accordion id="settings-vault" title={t("settings_section_vault")}>
          <VaultView onAuthError={onAuthError} />
        </Accordion>
        <Accordion id="settings-connectors" title={t("settings_section_connectors")}>
          <ConnectorsView onAuthError={onAuthError} />
        </Accordion>
        <Accordion id="settings-voice" title={t("settings_section_voice")}>
          <VoiceView onAuthError={onAuthError} />
        </Accordion>
        <Accordion id="settings-prompt" title={t("settings_section_prompt")}>
          <PromptView_ onAuthError={onAuthError} />
        </Accordion>
        <Accordion id="settings-skills" title={t("settings_section_skills")}>
          <SkillsView onAuthError={onAuthError} />
        </Accordion>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications — Web Push (mobile/desktop OS notifications when the tab is closed)
// ---------------------------------------------------------------------------

/** Decode a base64url VAPID public key into the Uint8Array the PushManager wants. */
// Return type is pinned to Uint8Array<ArrayBuffer> (backed by an explicit
// ArrayBuffer, not the default ArrayBufferLike which also admits SharedArrayBuffer)
// so it satisfies pushManager.subscribe's `applicationServerKey: BufferSource`.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function NotificationsSettings({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [view, setView] = useState<PushView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Whether THIS browser's current SW registration is already subscribed.
  const [localSubscribed, setLocalSubscribed] = useState<boolean | null>(null);

  // Web Push needs a service worker + PushManager + Notification API. In dev
  // (vite) the SW is disabled, and Safari/older browsers may lack PushManager.
  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  const load = () =>
    api
      .push()
      .then(setView)
      .catch((e) => e instanceof AuthError && onAuthError());

  useEffect(() => {
    void load();
    if (!supported) {
      setLocalSubscribed(false);
      return;
    }
    // Detect whether this browser already has a live push subscription.
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setLocalSubscribed(!!sub))
      .catch(() => setLocalSubscribed(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enable = async () => {
    if (!supported) return;
    setBusy("enable");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        toast.error(t("settings_push_denied"));
        return;
      }
      const cfg = view ?? (await api.push());
      if (!cfg.publicKey) {
        toast.error(t("settings_push_unconfigured"));
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(cfg.publicKey),
        }));
      const label =
        navigator.userAgent.match(/(iPhone|iPad|Android|Macintosh|Windows|Linux)/)?.[1] ??
        "This device";
      await api.pushSubscribe(sub.toJSON() as PushSubscriptionJSON, label);
      setLocalSubscribed(true);
      toast.success(t("settings_push_enabled"));
      await load();
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  };

  const removeDevice = async (id: string) => {
    setBusy(id);
    try {
      await api.pushUnsubscribe(id);
      toast.success(t("settings_push_removed"));
      await load();
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy("test");
    try {
      const r = await api.pushTest();
      toast.success(t("settings_push_test_sent").replace("{n}", String(r.subscribers)));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  };

  const configured = view?.configured ?? false;
  const devices = view?.subscriptions ?? [];

  return (
    <Card
      title={t("settings_push")}
      right={
        configured ? (
          devices.length > 0 ? (
            <Badge tone="green">{t("settings_push_active")}</Badge>
          ) : (
            <Badge tone="zinc">{t("settings_push_off")}</Badge>
          )
        ) : (
          <Badge tone="amber">{t("settings_push_unconfigured_badge")}</Badge>
        )
      }
    >
      <p className="mb-4 text-sm text-fg-dim">{t("settings_push_desc")}</p>

      {!supported && (
        <p className="mb-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-fg-faint">
          {t("settings_push_unsupported")}
        </p>
      )}

      {devices.length > 0 && (
        <ul className="mb-4 space-y-2">
          {devices.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between rounded-lg border border-line bg-surface-2 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-fg">{d.label || t("settings_push_device")}</p>
                <p className="text-xs text-fg-faint">
                  {new Date(d.createdAt).toLocaleString()}
                </p>
              </div>
              <Button
                variant="danger"
                disabled={busy === d.id}
                onClick={() => removeDevice(d.id)}
              >
                {t("remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button
          variant="primary"
          disabled={!supported || !configured || busy === "enable" || localSubscribed === true}
          onClick={enable}
        >
          {localSubscribed === true
            ? t("settings_push_this_device_on")
            : t("settings_push_enable")}
        </Button>
        <Button
          disabled={devices.length === 0 || busy === "test"}
          onClick={sendTest}
        >
          {t("settings_push_test")}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Control — service-level actions (restart the whole MyAgens process)
// ---------------------------------------------------------------------------

function ServiceControl({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [serviceInstalled, setServiceInstalled] = useState(false);
  const [brand, setBrand] = useState("MyAgens");
  const [busy, setBusy] = useState(false);
  const [processUptimeSec, setProcessUptimeSec] = useState<number | null>(null);

  useEffect(() => {
    api
      .agent()
      .then((a) => setServiceInstalled(a.serviceInstalled))
      .catch((e) => e instanceof AuthError && onAuthError());
    api.me().then((m) => m.brandName && setBrand(m.brandName)).catch(() => {});
    // Refresh uptime on mount and every 30s so it ticks up live and a restart is visible.
    const loadUptime = () =>
      api.health().then((h) => setProcessUptimeSec(h.processUptimeSec)).catch(() => {});
    void loadUptime();
    const id = setInterval(loadUptime, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restart = async () => {
    if (!confirm(t("settings_restart_confirm"))) return;
    setBusy(true);
    try {
      await api.restartAgent();
      toast.info(t("settings_restarting"));
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t("settings_control")}>
      <p className="mb-4 text-sm text-fg-dim">{t("settings_control_desc")}</p>
      {processUptimeSec != null && (
        <div className="mb-4 flex items-baseline gap-2 text-sm">
          <span className="text-fg-faint">{t("settings_uptime").replace("{brand}", brand)}</span>
          <span className="font-medium text-fg tabular">{uptime(processUptimeSec)}</span>
        </div>
      )}
      <Button
        variant="danger"
        onClick={restart}
        disabled={!serviceInstalled || busy}
        title={serviceInstalled ? "" : t("settings_no_service")}
      >
        {busy ? t("settings_restarting") : t("settings_restart_app").replace("{brand}", brand)}
      </Button>
      {!serviceInstalled && (
        <p className="mt-2 text-xs text-fg-dim">{t("settings_no_service")}</p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Whitelabel
// ---------------------------------------------------------------------------

function WhitelabelSettings({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  // Full white-label configuration: saved values apply immediately (the panel
  // chrome re-reads them from /api/me).
  const [b, setB] = useState<Branding>({});
  const [saved, setSaved] = useState<Branding>({});
  const [busy, setBusy] = useState(false);
  const [genPrompt, setGenPrompt] = useState("");
  const [genBusy, setGenBusy] = useState(false);

  useEffect(() => {
    api
      .branding()
      .then((v) => {
        setB(v.branding);
        setSaved(v.branding);
      })
      .catch((e) => e instanceof AuthError && onAuthError());
  }, [onAuthError]);

  const dirty = JSON.stringify(b) !== JSON.stringify(saved);
  const set = (patch: Partial<Branding>) => setB((cur) => ({ ...cur, ...patch }));

  const onFile = (key: "logoUrl" | "faviconUrl") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => set({ [key]: String(reader.result) });
    reader.readAsDataURL(file);
  };

  const save = async () => {
    setBusy(true);
    try {
      const v = await api.saveBranding(b);
      setSaved(v.branding);
      setB(v.branding);
      applyBranding(v.effective, v.effective.brandName ?? "");
      toast.success(t("settings_whitelabel_saved"));
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!confirm(t("settings_whitelabel_reset_confirm"))) return;
    setBusy(true);
    try {
      const v = await api.resetBranding();
      setSaved(v.branding);
      setB(v.branding);
      applyBranding(v.effective, v.effective.brandName ?? "");
      toast.success(t("settings_whitelabel_reset_done"));
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    } finally {
      setBusy(false);
    }
  };

  // One-shot AI pass: describe the look, get a theme-CSS draft into the editor.
  // Nothing applies until the user reviews and saves.
  const generate = async () => {
    const prompt = genPrompt.trim();
    if (!prompt) return;
    setGenBusy(true);
    try {
      const { css } = await api.generateBrandingCss(prompt);
      set({ customCss: css });
      toast.success(t("settings_whitelabel_generated"));
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else toast.error(t("settings_whitelabel_generate_failed"));
    } finally {
      setGenBusy(false);
    }
  };

  return (
    <Card
      title={t("settings_whitelabel")}
      right={<Badge tone="green">{t("settings_whitelabel_active")}</Badge>}
    >
      <p className="mb-3 text-sm text-fg-dim">{t("settings_whitelabel_desc")}</p>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>{t("settings_whitelabel_brand")}</Label>
            <Input placeholder="MyAgens" value={b.brandName ?? ""} onChange={(e) => set({ brandName: e.target.value })} />
          </div>
          <div>
            <Label>{t("settings_whitelabel_agent_name")}</Label>
            <Input placeholder="Atlas" value={b.agentName ?? ""} onChange={(e) => set({ agentName: e.target.value })} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>{t("settings_whitelabel_panel_title")}</Label>
            <Input placeholder="Command Center" value={b.panelTitle ?? ""} onChange={(e) => set({ panelTitle: e.target.value })} />
          </div>
          <div>
            <Label>{t("settings_whitelabel_accent")}</Label>
            <div className="flex items-center gap-2">
              <input type="color" className="h-9 w-12 cursor-pointer rounded border border-line bg-transparent" value={b.accentColor || "#6d28d9"} onChange={(e) => set({ accentColor: e.target.value })} />
              <Input placeholder="#6d28d9" value={b.accentColor ?? ""} onChange={(e) => set({ accentColor: e.target.value })} />
            </div>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>{t("settings_whitelabel_logo")}</Label>
            <div className="flex items-center gap-3">
              {b.logoUrl && <img src={b.logoUrl} alt="" className="h-9 w-9 rounded object-contain" />}
              <input type="file" accept="image/*" onChange={onFile("logoUrl")} className="text-sm text-fg-dim" />
              {b.logoUrl && <Button onClick={() => set({ logoUrl: "" })}>{t("remove")}</Button>}
            </div>
          </div>
          <div>
            <Label>{t("settings_whitelabel_favicon")}</Label>
            <div className="flex items-center gap-3">
              {b.faviconUrl && <img src={b.faviconUrl} alt="" className="h-9 w-9 rounded object-contain" />}
              <input type="file" accept="image/*" onChange={onFile("faviconUrl")} className="text-sm text-fg-dim" />
              {b.faviconUrl && <Button onClick={() => set({ faviconUrl: "" })}>{t("remove")}</Button>}
            </div>
          </div>
        </div>
        <div>
          <Label>{t("settings_whitelabel_email_footer")}</Label>
          <TextArea rows={2} placeholder={t("settings_whitelabel_email_footer_ph")} value={b.emailFooter ?? ""} onChange={(e) => set({ emailFooter: e.target.value })} />
        </div>
        <div>
          <Label>{t("settings_whitelabel_custom_css")}</Label>
          <p className="mb-2 text-xs text-fg-dim">{t("settings_whitelabel_custom_css_hint")}</p>
          <div className="mb-2 flex gap-2">
            <Input
              placeholder={t("settings_whitelabel_ai_ph")}
              value={genPrompt}
              onChange={(e) => setGenPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void generate()}
            />
            <Button onClick={generate} disabled={genBusy || !genPrompt.trim()} className="shrink-0">
              {genBusy ? t("settings_whitelabel_generating") : t("settings_whitelabel_generate")}
            </Button>
          </div>
          <TextArea
            rows={8}
            className="text-xs"
            placeholder={':root { --accent: #6d28d9; }\n[data-theme="dark"] { --accent: #a78bfa; }'}
            value={b.customCss ?? ""}
            onChange={(e) => set({ customCss: e.target.value })}
          />
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Button variant="primary" disabled={!dirty || busy} onClick={save}>
            {busy ? t("saving") : t("save")}
          </Button>
          <Button variant="danger" disabled={busy} onClick={reset}>
            {t("settings_whitelabel_reset")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main Agent
// ---------------------------------------------------------------------------

/** The four prompt-slimming keys with their i18n label keys, in display order. */
const PROMPT_EXCLUDE_OPTIONS: Array<{ key: PromptExcludeKey; labelKey: TranslationKey }> = [
  { key: "workMd", labelKey: "settings_prompt_exclude_workmd" },
  { key: "persona", labelKey: "settings_prompt_exclude_persona" },
  { key: "knownPaths", labelKey: "settings_prompt_exclude_knownpaths" },
  { key: "memory", labelKey: "settings_prompt_exclude_memory" },
];

/** Order-independent equality of two prompt-exclude selections. */
function sameExclude(a: PromptExcludeKey[], b: PromptExcludeKey[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((k) => set.has(k));
}

function MainAgentSettings({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [agent, setAgent] = useState<MainAgent | null>(null);
  const [model, setModel] = useState("");
  const [providerId, setProviderId] = useState("");
  const [backendId, setBackendId] = useState("");
  const [persona, setPersona] = useState("");
  const [autonomy, setAutonomy] = useState<Autonomy>("standard");
  const [dryRun, setDryRun] = useState(false);
  const [updateNotifyOptOut, setUpdateNotifyOptOut] = useState(false);
  const [promptExclude, setPromptExclude] = useState<PromptExcludeKey[]>([]);
  const [fallbackProviderId, setFallbackProviderId] = useState("");
  const [fallbackBackendId, setFallbackBackendId] = useState("");
  const [fallbackModel, setFallbackModel] = useState("");
  const [fallbackThreshold, setFallbackThreshold] = useState(95);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    api
      .agent()
      .then((a) => {
        setAgent(a);
        setModel(a.model);
        setProviderId(a.providerId);
        setBackendId(a.backendId);
        setPersona(a.persona ?? "");
        setAutonomy(a.autonomy ?? "standard");
        setDryRun(a.dryRun === true);
        setUpdateNotifyOptOut(a.updateNotifyOptOut === true);
        setPromptExclude(a.promptExclude ?? []);
        setFallbackProviderId(a.fallbackProviderId ?? "");
        setFallbackBackendId(a.fallbackBackendId ?? "");
        setFallbackModel(a.fallbackModel ?? "");
        setFallbackThreshold(a.fallbackThreshold ?? 95);
      })
      .catch((e) => e instanceof AuthError && onAuthError());

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty =
    agent != null &&
    (model !== agent.model ||
      providerId !== agent.providerId ||
      backendId !== agent.backendId ||
      persona !== (agent.persona ?? "") ||
      autonomy !== (agent.autonomy ?? "standard") ||
      dryRun !== (agent.dryRun === true) ||
      updateNotifyOptOut !== (agent.updateNotifyOptOut === true) ||
      !sameExclude(promptExclude, agent.promptExclude ?? []) ||
      fallbackProviderId !== (agent.fallbackProviderId ?? "") ||
      fallbackBackendId !== (agent.fallbackBackendId ?? "") ||
      fallbackModel !== (agent.fallbackModel ?? "") ||
      fallbackThreshold !== (agent.fallbackThreshold ?? 95));

  // Warn before leaving (tab close / reload) while there are unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  if (!agent) {
    return (
      <Card
        title={t("settings_agent")}
        right={<Skeleton className="h-5 w-24" />}
      >
        <Skeleton className="mb-4 h-4 w-3/4" />
        <div className="space-y-2">
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-9 w-full rounded-lg" />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Skeleton className="h-8 w-20 rounded-lg" />
          <Skeleton className="h-8 w-20 rounded-lg" />
          <Skeleton className="h-8 w-24 rounded-lg" />
        </div>
      </Card>
    );
  }

  const save = async () => {
    setBusy("save");
    try {
      const next = await api.saveAgent({
        model,
        providerId,
        backendId,
        persona,
        autonomy,
        dryRun,
        updateNotifyOptOut,
        promptExclude,
        fallbackProviderId,
        fallbackBackendId,
        fallbackModel,
        fallbackThreshold,
      });
      setAgent(next);
      toast.success(t("saved"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  };

  const fetchModels = async (): Promise<string[]> => {
    if (!providerId) return [];
    try {
      return (await api.providerModels(providerId)).models;
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      return [];
    }
  };

  const reset = async () => {
    if (!confirm(t("settings_reset_confirm"))) return;
    setBusy("reset");
    try {
      const r = await api.resetAgent();
      toast.success(t("settings_reset_done").replace("{sessions}", String(r.sessions)).replace("{aborted}", String(r.aborted)));
    } finally {
      setBusy(null);
    }
  };

  const dirtyDot = dirty ? (
    <span
      className="h-1.5 w-1.5 rounded-full bg-warn"
      title={t("settings_unsaved")}
      aria-label={t("settings_unsaved")}
    />
  ) : undefined;

  return (
    <Card
      title={t("settings_agent")}
      right={<Badge tone="blue">{agent.effectiveModel}</Badge>}
    >
      <p className="mb-4 text-sm text-fg-dim">{t("settings_agent_desc")}</p>

      <div className="space-y-2">
        <Accordion id="agent-model" title={t("settings_section_model")} defaultOpen badge={dirtyDot}>
          <div className="mb-3">
            <Label>{t("settings_ai_backend")}</Label>
            <Select
              value={backendId}
              onChange={(e) => {
                const v = e.target.value;
                setBackendId(v);
                // Provider/model only mean anything for the Claude backend —
                // clear them so a stale Claude model id can't be sent to a
                // different backend's CLI (which would reject it).
                if (v) {
                  setModel("");
                  setProviderId("");
                }
              }}
            >
              <option value="">{t("settings_ai_backend_default")}</option>
              {agent.backends
                .filter((b) => b.id !== "claude-agent-sdk")
                .map((b) => (
                  <option key={b.id} value={b.id}>{b.displayName}</option>
                ))}
            </Select>
            <p className="mt-1 text-xs text-fg-dim">{t("settings_ai_backend_hint")}</p>
          </div>
          {backendId === "ollama" ? (
            // Ollama runs plain local chat: keep the Model field (it's the
            // installed Ollama model name) but drop Provider, which never
            // applies to this backend's own auth. The fetch button lists the
            // models installed on the local daemon.
            <div>
              <Label>{t("model")}</Label>
              <ModelSelect
                value={model}
                onChange={setModel}
                suggestions={[]}
                onFetch={() => api.ollamaStatus().then((s) => s.models).catch(() => [])}
                fetchLabel={t("fetch")}
                placeholder={t("settings_model_local")}
              />
              <p className="mt-1 text-xs text-fg-dim">{t("settings_ai_backend_ollama_hint")}</p>
            </div>
          ) : backendId ? (
            <p className="text-xs text-fg-dim">{t("settings_ai_backend_no_model")}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>{t("provider")}</Label>
                <Select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                  <option value="">{t("settings_anthropic_default")}</option>
                  {agent.providers.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>{t("model")}</Label>
                <ModelSelect
                  value={model}
                  onChange={setModel}
                  suggestions={providerId ? [] : MODEL_SUGGESTIONS}
                  onFetch={providerId ? fetchModels : undefined}
                  fetchLabel={t("fetch")}
                  placeholder={providerId ? t("settings_model_local") : t("settings_model_default")}
                />
              </div>
            </div>
          )}
        </Accordion>

        <Accordion id="agent-identity" title={t("settings_section_identity")}>
          <Label>{t("persona")}</Label>
          <div className="flex flex-wrap gap-1 mb-1.5">
            {PERSONA_PRESETS.map((p) => (
              <button
                key={p.labelKey}
                type="button"
                onClick={() => setPersona(p.value)}
                className={`rounded px-2 py-0.5 text-xs border transition-colors ${
                  persona === p.value
                    ? "bg-[var(--accent)] text-white border-transparent"
                    : "border-line text-fg-dim hover:text-fg"
                }`}
              >
                {t(p.labelKey)}
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
              {t("settings_persona_default")}
            </button>
            {persona && !PERSONA_PRESETS.find((p) => p.value === persona) && (
              <span className="rounded px-2 py-0.5 text-xs border border-line text-fg-dim">{t("settings_persona_custom")}</span>
            )}
          </div>
          <TextArea
            rows={2}
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            placeholder={t("settings_persona_placeholder")}
          />

          <div className="mt-4 border-t border-line pt-4">
            <span className="text-sm font-medium text-fg">{t("settings_prompt_exclude")}</span>
            <p className="mt-0.5 mb-2 text-xs text-fg-dim">{t("settings_prompt_exclude_desc")}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {PROMPT_EXCLUDE_OPTIONS.map((opt) => (
                <label key={opt.key} className="flex cursor-pointer items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={promptExclude.includes(opt.key)}
                    onChange={(e) =>
                      setPromptExclude((prev) =>
                        e.target.checked
                          ? [...prev, opt.key]
                          : prev.filter((k) => k !== opt.key),
                      )
                    }
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  <span className="text-sm text-fg">{t(opt.labelKey)}</span>
                </label>
              ))}
            </div>
          </div>
        </Accordion>

        <Accordion id="agent-autonomy" title={t("settings_section_autonomy")}>
          <Label>{t("autonomy")}</Label>
          <div className="mt-1 flex gap-2 flex-wrap">
            {AUTONOMY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setAutonomy(opt.value)}
                title={t(opt.descKey)}
                className={`rounded px-2.5 py-1 text-xs font-medium border transition-colors ${
                  autonomy === opt.value
                    ? "bg-[var(--accent)] text-white border-transparent"
                    : "border-line text-fg-dim hover:text-fg"
                }`}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>

          <div className="mt-4 border-t border-line pt-4">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
              />
              <span>
                <span className="text-sm font-medium text-fg">{t("settings_dryrun")}</span>
                <span className="block text-xs text-fg-dim">{t("settings_dryrun_desc")}</span>
              </span>
            </label>
            {dryRun && (
              <p className="mt-2 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-xs text-warn-fg">
                {t("settings_dryrun_active")}
              </p>
            )}
          </div>

          <div className="mt-4 border-t border-line pt-4">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={!updateNotifyOptOut}
                onChange={(e) => setUpdateNotifyOptOut(!e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
              />
              <span>
                <span className="text-sm font-medium text-fg">{t("settings_update_notify")}</span>
                <span className="block text-xs text-fg-dim">{t("settings_update_notify_desc")}</span>
              </span>
            </label>
          </div>

          <div className="mt-4 border-t border-line pt-4">
            <span className="text-sm font-medium text-fg">{t("settings_fallback")}</span>
            <p className="mt-0.5 mb-2 text-xs text-fg-dim">{t("settings_fallback_desc")}</p>
            {agent.degraded?.active && (
              <p className="mb-2 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-xs text-warn-fg">
                {t("settings_fallback_active")
                  .replace("{provider}", agent.degraded.provider ?? "")
                  .replace("{reason}", agent.degraded.reason ?? "")}
              </p>
            )}
            <div className="mb-3">
              <Label>{t("settings_fallback_backend")}</Label>
              <Select
                value={fallbackBackendId}
                onChange={(e) => {
                  const v = e.target.value;
                  setFallbackBackendId(v);
                  // Providers only apply to the Claude backend — clear a stale
                  // one so it isn't sent alongside a non-Claude fallback backend.
                  if (v) setFallbackProviderId("");
                }}
              >
                <option value="">{t("settings_ai_backend_default")}</option>
                {agent.backends
                  .filter((b) => b.id !== "claude-agent-sdk")
                  .map((b) => (
                    <option key={b.id} value={b.id}>{b.displayName}</option>
                  ))}
              </Select>
              <p className="mt-1 text-xs text-fg-dim">{t("settings_fallback_backend_hint")}</p>
            </div>
            {fallbackBackendId ? (
              // A non-Claude fallback backend manages its own auth, so the
              // provider input doesn't apply — keep only the model name (for
              // Ollama, the fetch button lists the installed local models).
              <div>
                <Label>{t("model")}</Label>
                <ModelSelect
                  value={fallbackModel}
                  onChange={setFallbackModel}
                  suggestions={[]}
                  onFetch={
                    fallbackBackendId === "ollama"
                      ? () => api.ollamaStatus().then((s) => s.models).catch(() => [])
                      : undefined
                  }
                  fetchLabel={t("fetch")}
                  placeholder={t("settings_fallback_model_ph")}
                />
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label>{t("settings_fallback_provider")}</Label>
                  <Select
                    value={fallbackProviderId}
                    onChange={(e) => setFallbackProviderId(e.target.value)}
                  >
                    <option value="">{t("settings_fallback_none")}</option>
                    {agent.providers.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label>{t("model")}</Label>
                  <ModelSelect
                    value={fallbackModel}
                    onChange={setFallbackModel}
                    suggestions={fallbackProviderId ? [] : MODEL_SUGGESTIONS}
                    onFetch={
                      fallbackProviderId
                        ? () => api.providerModels(fallbackProviderId).then((r) => r.models).catch(() => [])
                        : undefined
                    }
                    fetchLabel={t("fetch")}
                    placeholder={t("settings_fallback_model_ph")}
                    disabled={!fallbackProviderId}
                  />
                </div>
              </div>
            )}
            {(fallbackProviderId || fallbackBackendId) && (
              <div className="mt-3">
                <Label>{t("settings_fallback_threshold")}</Label>
                <Input
                  type="number"
                  min={50}
                  max={100}
                  value={fallbackThreshold}
                  onChange={(e) => setFallbackThreshold(Number(e.target.value))}
                  className="max-w-[7rem]"
                />
                <p className="mt-0.5 text-xs text-fg-dim">{t("settings_fallback_threshold_desc")}</p>
              </div>
            )}
          </div>
        </Accordion>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button variant="primary" onClick={save} disabled={!dirty || busy === "save"}>
          {busy === "save" ? t("saving") : t("save")}
        </Button>
        <Button onClick={reset} disabled={busy === "reset"}>
          {t("settings_new_context")}
        </Button>
        {dirty && <span className="text-xs text-warn-fg">{t("settings_unsaved")}</span>}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Known Paths — named directory shortcuts injected into the system prompt
// ---------------------------------------------------------------------------

function KnownPathsSettings({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [paths, setPaths] = useState<Array<{ label: string; path: string }>>([]);
  const [loaded, setLoaded] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newPath, setNewPath] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .agent()
      .then((a) => {
        setPaths(a.knownPaths ?? []);
        setLoaded(true);
      })
      .catch((e) => e instanceof AuthError && onAuthError());

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (next: Array<{ label: string; path: string }>) => {
    setBusy(true);
    try {
      const a = await api.saveAgent({ knownPaths: next });
      setPaths(a.knownPaths ?? []);
      toast.success(t("saved"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const label = newLabel.trim();
    const path = newPath.trim();
    if (!label || !path) return;
    const next = [...paths, { label, path }];
    setNewLabel("");
    setNewPath("");
    await save(next);
  };

  const remove = async (idx: number) => {
    await save(paths.filter((_, i) => i !== idx));
  };

  return (
    <Card title={t("settings_known_paths")}>
      <p className="mb-4 text-sm text-fg-dim">{t("settings_known_paths_desc")}</p>

      {!loaded ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-9 w-full rounded-lg" />
        </div>
      ) : paths.length > 0 ? (
        <ul className="mb-4 space-y-2">
          {paths.map((p, i) => (
            <li
              key={i}
              className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2"
            >
              <span className="w-28 shrink-0 text-sm font-medium text-fg">{p.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-faint" title={p.path}>
                {p.path}
              </span>
              <Button variant="danger" disabled={busy} onClick={() => remove(i)}>
                {t("remove")}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-sm text-fg-faint">{t("settings_known_paths_empty")}</p>
      )}

      <div className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
        <div className="w-28 shrink-0">
          <Label>{t("settings_known_paths_label")}</Label>
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder={t("settings_known_paths_label_ph")}
          />
        </div>
        <div className="flex-1 min-w-0">
          <Label>{t("settings_known_paths_path")}</Label>
          <Input
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder={t("settings_known_paths_path_ph")}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
        </div>
        <Button
          variant="primary"
          disabled={!newLabel.trim() || !newPath.trim() || busy}
          onClick={add}
        >
          {t("add")}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Language Settings
// ---------------------------------------------------------------------------

/** Theme picker (light / dark / high-contrast). Reads and writes `data-theme`
 *  via useTheme; no props needed since the theme lives on <html>. "Hacker"
 *  stays a hidden easter egg, so it's only listed here when already active. */
function AppearanceSettings() {
  const { t } = useI18n();
  const { theme, set } = useTheme();
  const options: Array<{ id: Theme; labelKey: TranslationKey }> = [
    { id: "light", labelKey: "theme_light" },
    { id: "dark", labelKey: "theme_dark" },
    { id: "contrast", labelKey: "theme_contrast" },
  ];
  // Keep the easter-egg theme selectable (to leave it) once it's on, without
  // advertising it to everyone else.
  if (theme === "matrix") options.push({ id: "matrix", labelKey: "theme_matrix" });

  return (
    <Card title={t("settings_appearance")}>
      <p className="mb-4 text-sm text-fg-dim">{t("settings_appearance_desc")}</p>
      <div>
        <Label>{t("settings_theme_label")}</Label>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {options.map((opt) => (
            <button
              key={opt.id}
              onClick={() => set(opt.id)}
              aria-pressed={theme === opt.id}
              className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                theme === opt.id
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-line text-fg-dim hover:text-fg"
              }`}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}

function LanguageSettings({ onAuthError }: { onAuthError: () => void }) {
  const { t, lang, setLang } = useI18n();
  const [agent, setAgent] = useState<MainAgent | null>(null);
  const [agentLang, setAgentLang] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .agent()
      .then((a) => {
        setAgent(a);
        setAgentLang(a.defaultLanguage ?? "en");
      })
      .catch((e) => e instanceof AuthError && onAuthError());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.saveAgent({ defaultLanguage: agentLang });
      setAgent(next);
      toast.success(t("saved"));
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    } finally {
      setBusy(false);
    }
  };

  const dirty = agent ? agentLang !== (agent.defaultLanguage ?? "en") : false;

  return (
    <Card title={t("settings_language")}>
      <p className="mb-4 text-sm text-fg-dim">{t("settings_language_desc")}</p>

      <div className="space-y-4">
        {/* Panel interface language */}
        <div>
          <Label>{t("lang_interface")}</Label>
          <div className="mt-1.5 flex gap-2">
            {Object.entries(INTERFACE_LANGUAGES).map(([code, label]) => (
              <button
                key={code}
                onClick={() => setLang(code)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm border transition-colors ${
                  lang === code
                    ? "bg-[var(--accent)] text-white border-transparent"
                    : "border-line text-fg-dim hover:text-fg"
                }`}
              >
                <span className="text-base">{code === "en" ? "🇬🇧" : "🇭🇺"}</span>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Agent communication language */}
        <div>
          <Label>{t("lang_agent")}</Label>
          <p className="mt-0.5 mb-1.5 text-xs text-fg-faint">{t("lang_agent_desc")}</p>
          <div className="flex gap-2 items-start">
            <div className="flex-1">
              <Select
                value={agentLang}
                onChange={(e) => setAgentLang(e.target.value)}
              >
                {Object.entries(AGENT_LANGUAGES).map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="primary"
              onClick={save}
              disabled={!dirty || busy}
            >
              {busy ? t("saving") : t("save")}
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-fg-faint">{t("settings_lang_override")}</p>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Plan / Budget
// ---------------------------------------------------------------------------

const PLAN_OPTIONS: Array<{ value: PlanType; labelKey: TranslationKey; subKey: TranslationKey }> = [
  { value: "pro", labelKey: "plan_pro", subKey: "plan_pro_sub" },
  { value: "max", labelKey: "plan_max", subKey: "plan_max_sub" },
  { value: "api", labelKey: "plan_api", subKey: "plan_api_sub" },
];

const INTERVAL_OPTIONS: Array<{ labelKey: TranslationKey; value: number }> = [
  { labelKey: "interval_never", value: 0 },
  { labelKey: "interval_hourly", value: 3_600_000 },
  { labelKey: "interval_6h", value: 21_600_000 },
  { labelKey: "interval_daily", value: 86_400_000 },
  { labelKey: "interval_weekly", value: 604_800_000 },
];

const PROBE_INTERVAL_OPTIONS: Array<{ labelKey: TranslationKey; value: number }> = [
  { labelKey: "interval_off", value: 0 },
  { labelKey: "interval_15m", value: 900_000 },
  { labelKey: "interval_30m", value: 1_800_000 },
  { labelKey: "interval_1h", value: 3_600_000 },
  { labelKey: "interval_3h", value: 10_800_000 },
];

function PlanBudgetSettings({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [, setPlanState] = useState<PlanView | null>(null);
  const [form, setForm] = useState({
    plan: "api" as PlanType,
    monthlyCap: 0,
    billingDay: 1,
    alertThresholdPct: 80,
    costCheckIntervalMs: 0,
    probeIntervalMs: 1_800_000,
  });
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probeRunning, setProbeRunning] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadPlan = () =>
    api
      .plan()
      .then((p) => {
        setPlanState(p);
        setForm({
          plan: p.plan,
          monthlyCap: p.monthlyCap,
          billingDay: p.billingDay,
          alertThresholdPct: p.alertThresholdPct,
          costCheckIntervalMs: p.costCheckIntervalMs ?? 0,
          probeIntervalMs: p.probeIntervalMs ?? 1_800_000,
        });
      })
      .catch((e) => e instanceof AuthError && onAuthError());

  useEffect(() => {
    void loadPlan();
    api.usageProbe().then(setProbe).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      await api.savePlan({
        ...form,
        costCheckIntervalMs: form.costCheckIntervalMs || undefined,
        probeIntervalMs: form.probeIntervalMs,
      });
      await loadPlan();
      toast.success(t("saved"));
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    } finally {
      setBusy(false);
    }
  };

  const testReport = async () => {
    setBusy(true);
    try {
      const { sent } = await api.testReport();
      if (sent) toast.success(t("plan_report_sent"));
      else toast.error(t("plan_report_failed"));
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    } finally {
      setBusy(false);
    }
  };

  const runCheck = async () => {
    setProbeRunning(true);
    await api.runProbe().catch(() => {});
    let attempts = 0;
    const poll = setInterval(async () => {
      const p = await api.usageProbe().catch(() => null);
      if (p) setProbe(p);
      if (++attempts >= 15) clearInterval(poll);
    }, 2000);
    setTimeout(() => { clearInterval(poll); setProbeRunning(false); }, 30_000);
  };

  // Auto-detect from OAuth probe
  const detectedPlan: string | null =
    probe?.account?.hasMax ? t("plan_max") :
    probe?.account?.hasPro ? t("plan_pro") :
    null;
  const isSubscription = Boolean(probe?.account?.hasPro || probe?.account?.hasMax);
  const planLabelKey = PLAN_OPTIONS.find((o) => o.value === form.plan)?.labelKey;
  const effectivePlanLabel = detectedPlan ?? (planLabelKey ? t(planLabelKey) : "");

  return (
    <Card title={t("plan_title")}>
      <div className="space-y-5">

        {/* Account: auto-detected or manual selector */}
        <div className="rounded-lg border border-line bg-input p-3 space-y-3">
          <div className="flex flex-wrap items-start gap-3 justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium text-fg">{t("plan_account")}</p>
              {probe?.account?.email && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-fg-faint">{t("plan_logged_in")}</span>
                  <BlurredEmail email={probe.account.email} />
                </div>
              )}
              {detectedPlan ? (
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                    {detectedPlan}
                  </span>
                  <span className="text-xs text-fg-faint">{t("plan_autodetected")}</span>
                </div>
              ) : probe?.source === "fallback" ? (
                <p className="text-xs text-warn-fg">{t("plan_oauth_unavailable")}</p>
              ) : (
                <p className="text-xs text-fg-faint">{t("plan_click_detect")}</p>
              )}
            </div>
            <Button onClick={runCheck} disabled={probeRunning}>
              {probeRunning ? t("checking") : t("plan_check_now")}
            </Button>
          </div>

          {/* Compact limit preview */}
          {probe?.source === "oauth" && probe.limits.length > 0 && (
            <div className="space-y-1.5">
              {probe.limits.slice(0, 2).map((lim) => (
                <div key={lim.label} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 text-xs text-fg-dim">{lim.label}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${lim.severity === "critical" ? "bg-critical" : lim.severity === "warning" ? "bg-warn" : "bg-accent"}`}
                      style={{ width: `${Math.min(100, lim.percent)}%` }}
                    />
                  </div>
                  <span className="w-8 tabular text-right text-xs text-fg-dim">{lim.percent}%</span>
                  <span className="text-xs text-fg-faint hidden sm:inline">
                    {t("plan_resets").replace("{time}", new Date(lim.resetsAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }))}
                  </span>
                </div>
              ))}
              {probe.probedAt && (
                <p className="text-xs text-fg-faint">{t("plan_last_checked").replace("{time}", new Date(probe.probedAt).toLocaleTimeString())}</p>
              )}
            </div>
          )}

          {/* Auto-refresh interval */}
          <div>
            <p className="text-xs text-fg-faint mb-1.5">{t("plan_autorefresh")}</p>
            <div className="flex flex-wrap gap-1.5">
              {PROBE_INTERVAL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setForm({ ...form, probeIntervalMs: opt.value })}
                  className={`rounded px-2 py-0.5 text-xs border transition-colors ${
                    form.probeIntervalMs === opt.value
                      ? "bg-[var(--accent)] text-white border-transparent"
                      : "border-line text-fg-dim hover:text-fg"
                  }`}
                >
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Manual plan override — only shown when auto-detect fails */}
        {!detectedPlan && (
          <div>
            <Label>{t("plan_manual")}</Label>
            <p className="mt-0.5 mb-2 text-xs text-fg-faint">
              {t("plan_manual_desc")}
            </p>
            <div className="flex flex-wrap gap-2">
              {PLAN_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    const cap = opt.value === "pro" ? 20 : opt.value === "max" ? 100 : form.monthlyCap;
                    setForm({ ...form, plan: opt.value, monthlyCap: cap });
                  }}
                  className={`flex flex-col rounded-lg border px-3 py-2 text-left transition-colors ${
                    form.plan === opt.value ? "border-[var(--accent)] bg-accent/10" : "border-line hover:border-fg-dim"
                  }`}
                >
                  <span className={`text-sm font-medium ${form.plan === opt.value ? "text-accent" : "text-fg"}`}>{t(opt.labelKey)}</span>
                  <span className="text-xs text-fg-faint">{t(opt.subKey)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Budget cap — always available for tracking; labeled by plan */}
        <div>
          <Label>{isSubscription ? t("plan_budget_ref").replace("{plan}", effectivePlanLabel) : t("plan_monthly_cap")}</Label>
          {isSubscription && (
            <p className="mt-0.5 mb-1 text-xs text-fg-faint">
              {t("plan_budget_ref_desc").replace("{plan}", effectivePlanLabel)}
            </p>
          )}
          <div className="mt-1 grid gap-3 sm:grid-cols-3">
            <div>
              <input
                type="number"
                min={0}
                step={1}
                value={form.monthlyCap}
                onChange={(e) => setForm({ ...form, monthlyCap: Number(e.target.value) })}
                className="w-full rounded-lg border border-line bg-input px-3 py-2 text-sm text-fg focus:border-[var(--accent)] focus:outline-none"
                placeholder={t("plan_cap_placeholder")}
              />
            </div>
            <div>
              <input
                type="number"
                min={1}
                max={28}
                value={form.billingDay}
                onChange={(e) => setForm({ ...form, billingDay: Number(e.target.value) })}
                className="w-full rounded-lg border border-line bg-input px-3 py-2 text-sm text-fg focus:border-[var(--accent)] focus:outline-none"
                placeholder={t("plan_billing_day")}
                title={t("plan_billing_day")}
              />
            </div>
            <div>
              <input
                type="number"
                min={0}
                max={100}
                value={form.alertThresholdPct}
                onChange={(e) => setForm({ ...form, alertThresholdPct: Number(e.target.value) })}
                className="w-full rounded-lg border border-line bg-input px-3 py-2 text-sm text-fg focus:border-[var(--accent)] focus:outline-none"
                placeholder={t("plan_alert_pct")}
                title={t("plan_alert_title")}
              />
            </div>
          </div>
          <p className="mt-1 text-xs text-fg-faint">{t("plan_cap_help")}</p>
        </div>

        {/* Telegram cost report */}
        <div>
          <Label>{t("plan_report_interval")}</Label>
          <p className="mt-0.5 mb-1.5 text-xs text-fg-faint">
            {t("plan_report_desc")}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {INTERVAL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setForm({ ...form, costCheckIntervalMs: opt.value })}
                className={`rounded px-2.5 py-1 text-xs border transition-colors ${
                  form.costCheckIntervalMs === opt.value
                    ? "bg-[var(--accent)] text-white border-transparent"
                    : "border-line text-fg-dim hover:text-fg"
                }`}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
          {/* Preview / test send — info block */}
          <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-line bg-input/40 px-3 py-2">
            <p className="text-xs text-fg-faint">{t("plan_report_test_hint")}</p>
            <button
              onClick={testReport}
              disabled={busy}
              className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-2 disabled:opacity-50"
            >
              {t("plan_report_test")}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={save} disabled={busy}>{busy ? t("saving") : t("save")}</Button>
        </div>
      </div>
    </Card>
  );
}

function BlurredEmail({ email }: { email: string }) {
  const { t } = useI18n();
  return (
    <span
      className="text-xs font-mono text-fg-faint select-none cursor-default transition-all duration-200"
      style={{ filter: "blur(5px)" }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.filter = "blur(0)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.filter = "blur(5px)"; }}
      title={t("plan_reveal_hover")}
    >
      {email}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Providers (moved from Workers)
// ---------------------------------------------------------------------------

const blankProvider = { name: "", baseUrl: "", authToken: "" };

const PROVIDER_PRESETS = [
  { name: "LM Studio", baseUrl: "http://localhost:1234", authToken: "lmstudio" },
  { name: "Ollama", baseUrl: "http://localhost:11434", authToken: "ollama" },
];

/** Map a saved provider's base URL to a known local embedding backend. */
function backendKind(baseUrl: string): PreferredBackend | null {
  if (baseUrl.includes("11434")) return "ollama";
  if (baseUrl.includes("1234")) return "lmstudio";
  return null;
}

interface ProviderStatus {
  kind: PreferredBackend | null;
  /** undefined = not a known local backend (no live probe). */
  running?: boolean;
  models: string[];
  embedCapable: boolean;
  /** Wired up as the active embeddings backend. */
  connected: boolean;
}

function ProvidersSettings({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState(blankProvider);
  const [probe, setProbe] = useState<{ busy: boolean; models?: string[]; error?: string }>({ busy: false });
  // Embeddings + live local-backend status, merged in from the agent card.
  const [embeddings, setEmbeddings] = useState<EmbeddingConfig | null>(null);
  const [embEnabled, setEmbEnabled] = useState(false);
  const [embProvider, setEmbProvider] = useState<"ollama" | "openai">("ollama");
  const [embBaseUrl, setEmbBaseUrl] = useState("");
  const [embModel, setEmbModel] = useState("");
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [lmStudio, setLmStudio] = useState<LmStudioStatus | null>(null);
  const [preferred, setPreferred] = useState<PreferredBackend | null>(null);
  const [active, setActive] = useState<PreferredBackend | null>(null);
  const [embAuto, setEmbAuto] = useState(true);
  const [embEnvMode, setEmbEnvMode] = useState<"auto" | "on" | "off">("auto");
  const [manualOpen, setManualOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    api
      .providers()
      .then((r) => setProviders(r.providers))
      .catch((e) => e instanceof AuthError && onAuthError());

  const loadEmbeddings = () =>
    api
      .agent()
      .then((a) => {
        setEmbeddings(a.embeddings);
        setEmbEnabled(a.embeddings.enabled);
        setEmbProvider(a.embeddings.provider);
        setEmbBaseUrl(a.embeddings.baseUrl);
        setEmbModel(a.embeddings.model);
        setPreferred(a.preferredBackend);
        setActive(a.activeBackend);
        setEmbAuto(a.embeddingAuto);
        setEmbEnvMode(a.embeddingEnvMode);
        // A pinned-on backend (not auto, enabled) opens the manual section.
        setManualOpen(!a.embeddingAuto && a.embeddings.enabled);
      })
      .catch((e) => e instanceof AuthError && onAuthError());

  const probeBackends = async () => {
    setBusy("probe");
    try {
      await Promise.all([
        api.ollamaStatus().then(setOllama).catch(() => {}),
        api.lmStudioStatus().then(setLmStudio).catch(() => {}),
      ]);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void load();
    void loadEmbeddings();
    void probeBackends();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const testModels = async () => {
    setProbe({ busy: true });
    try {
      const r = await api.fetchModels(form.baseUrl, form.authToken);
      setProbe({ busy: false, models: r.models });
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      setProbe({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const save = async () => {
    try {
      if (editing === "new") await api.createProvider(form);
      else if (editing) await api.updateProvider(editing, form);
      setEditing(null);
      await load();
      await probeBackends();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    }
  };

  const del = async (id: string) => {
    if (!confirm(t("settings_provider_delete_confirm"))) return;
    await api.deleteProvider(id);
    await load();
  };

  // Manual pin: save the custom endpoint and switch embeddings on against it.
  const saveManual = async () => {
    setBusy("emb");
    try {
      const r = await api.saveEmbeddings({ enabled: true, provider: embProvider, baseUrl: embBaseUrl, model: embModel });
      setEmbeddings(r.embeddings);
      setEmbEnabled(true);
      setActive(r.activeBackend);
      setEmbAuto(r.embeddingAuto);
      toast.success(t("saved"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  };

  // Return to auto-detect: clear any pin and re-probe the local backends now.
  const chooseAuto = async () => {
    setBusy("emb");
    try {
      const r = await api.embeddingsAuto();
      setEmbeddings(r.embeddings);
      setEmbEnabled(r.embeddings.enabled);
      setActive(r.activeBackend);
      setEmbAuto(r.embeddingAuto);
      setManualOpen(false);
      await probeBackends();
      toast.success(t("saved"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  };

  // Explicitly turn embeddings off (recall falls back to keyword search).
  const chooseOff = async () => {
    setBusy("emb");
    try {
      const r = await api.saveEmbeddings({ enabled: false });
      setEmbeddings(r.embeddings);
      setEmbEnabled(false);
      setActive(r.activeBackend);
      setEmbAuto(r.embeddingAuto);
      setManualOpen(false);
      toast.success(t("saved"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  };

  // One-click: register a local backend as a provider + enable embeddings on it.
  const connectOllama = async () => {
    setBusy("ollama");
    try {
      const r = await api.ollamaConnect();
      setOllama(r.status);
      if (r.embeddingsEnabled) {
        setEmbEnabled(r.status.embeddingsOn);
        setEmbProvider("ollama");
        setEmbBaseUrl(r.status.baseUrl);
        setEmbModel("nomic-embed-text");
      }
      await load();
      await loadEmbeddings();
      toast.success(t("ollama_connected"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  };

  const connectLmStudio = async () => {
    setBusy("lmstudio");
    try {
      const r = await api.lmStudioConnect();
      setLmStudio(r.status);
      if (r.embeddingsEnabled) {
        setEmbEnabled(r.status.embeddingsOn);
        setEmbProvider("openai");
        setEmbBaseUrl(r.status.baseUrl);
        if (r.status.embedModel) setEmbModel(r.status.embedModel);
      }
      await load();
      await loadEmbeddings();
      toast.success(t("lmstudio_connected"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  };

  const choosePreferred = async (pref: PreferredBackend | null) => {
    setPreferred(pref);
    try {
      await api.savePreferredBackend(pref);
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    }
  };

  const statusFor = (p: Provider): ProviderStatus => {
    const kind = backendKind(p.baseUrl);
    if (kind === "ollama" && ollama) {
      return { kind, running: ollama.running, models: ollama.models, embedCapable: ollama.hasEmbedModel, connected: ollama.providerExists && ollama.embeddingsOn };
    }
    if (kind === "lmstudio" && lmStudio) {
      return { kind, running: lmStudio.running, models: lmStudio.models, embedCapable: !!lmStudio.embedModel, connected: lmStudio.providerExists && lmStudio.embeddingsOn };
    }
    return { kind, models: [], embedCapable: false, connected: false };
  };

  // Topmost = the backend that's connected and embeddings-ready, then reachable, then name.
  const rank = (s: ProviderStatus) => (s.connected ? 2 : s.running ? 1 : 0);
  const ordered = [...providers].sort((a, b) => rank(statusFor(b)) - rank(statusFor(a)) || a.name.localeCompare(b.name));

  // When editing an existing provider, the plaintext token isn't available
  // (SEC-2); show its masked hint and treat a blank field as "keep existing".
  const editingProvider = editing && editing !== "new" ? providers.find((p) => p.id === editing) : undefined;
  const editingHasToken = !!editingProvider?.hasToken;
  const editingTokenHint = editingProvider?.tokenHint ?? "";

  const bothRunning = !!ollama?.running && !!lmStudio?.running;

  // Embeddings mode shown in the segmented control. When .env pins it ("on"/"off")
  // the control is locked and we display that state instead.
  const envLocked = embEnvMode !== "auto";
  const currentMode: "auto" | "manual" | "off" = envLocked
    ? (embEnvMode === "on" ? "manual" : "off")
    : manualOpen
      ? "manual"
      : embAuto
        ? "auto"
        : embEnabled
          ? "manual"
          : "off";

  return (
    <Card
      title={t("settings_providers")}
      right={
        !editing ? (
          <Button variant="primary" onClick={() => { setForm(blankProvider); setEditing("new"); setProbe({ busy: false }); }}>
            {t("settings_provider_new")}
          </Button>
        ) : null
      }
    >
      <p className="mb-3 text-sm text-fg-dim">{t("settings_providers_desc")}</p>

      {/* Embeddings header: mode (Auto / Manual / Off) + probe-result chip + refresh */}
      {embeddings && (
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Label>{t("settings_embeddings")}</Label>
            {currentMode !== "off" && (
              active === "ollama" ? (
                <Badge tone="green">{t("emb_status_ollama")}</Badge>
              ) : active === "lmstudio" ? (
                <Badge tone="green">{t("emb_status_lmstudio")}</Badge>
              ) : currentMode === "auto" ? (
                <Badge tone="amber">{t("emb_status_keyword_only")}</Badge>
              ) : null
            )}
          </div>
          <div className="flex items-center gap-3">
            {!envLocked && currentMode !== "off" && (
              <button
                type="button"
                onClick={probeBackends}
                disabled={busy === "probe"}
                className="text-xs text-fg-dim hover:text-fg disabled:opacity-50"
              >
                {busy === "probe" ? t("emb_refreshing") : t("emb_refresh")}
              </button>
            )}
            {envLocked ? (
              <span className="text-xs text-fg-faint">
                {t("emb_env_locked").replace("{mode}", embEnvMode)}
              </span>
            ) : (
              <div className="inline-flex overflow-hidden rounded-md border border-line text-xs">
                {(["auto", "manual", "off"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={busy === "emb"}
                    onClick={() => (m === "auto" ? chooseAuto() : m === "off" ? chooseOff() : (setManualOpen(true), setEmbEnabled(true)))}
                    className={`px-2.5 py-1 font-medium transition-colors disabled:opacity-50 ${
                      currentMode === m ? "bg-[var(--accent)] text-white" : "text-fg-dim hover:text-fg"
                    }`}
                  >
                    {t(`emb_mode_${m}` as TranslationKey)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {embeddings && !envLocked && (
        <p className="mb-3 text-xs text-fg-faint">{t("emb_mode_hint")}</p>
      )}

      {editing && (
        <div className="mb-4 space-y-3 rounded-lg border border-line bg-input p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-fg-dim">{t("settings_provider_prefill")}</span>
            {PROVIDER_PRESETS.map((p) => (
              <Button key={p.name} onClick={() => { setForm(p); setProbe({ busy: false }); }}>
                {p.name}
              </Button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label>{t("settings_provider_name")}</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="LM Studio" />
            </div>
            <div>
              <Label>{t("settings_provider_base_url")}</Label>
              <Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="http://localhost:1234" />
            </div>
            <div>
              <Label>{t("settings_provider_auth")}</Label>
              <Input
                value={form.authToken}
                onChange={(e) => setForm({ ...form, authToken: e.target.value })}
                placeholder={
                  editing !== "new" && editingHasToken
                    ? `${editingTokenHint} — ${t("settings_provider_auth_keep")}`
                    : "lmstudio"
                }
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={save} disabled={!form.name.trim() || !form.baseUrl.trim()}>{t("save")}</Button>
            <Button onClick={testModels} disabled={!form.baseUrl.trim() || probe.busy}>
              {probe.busy ? t("fetching") : t("settings_provider_test")}
            </Button>
            <Button onClick={() => setEditing(null)}>{t("cancel")}</Button>
          </div>
          {probe.error && <p className="text-xs text-critical-fg">{probe.error}</p>}
          {probe.models && (
            <p className="text-xs text-ok-fg">
              {t("settings_provider_models")
                .replace("{n}", String(probe.models.length))
                .replace("{models}", probe.models.join(", "))}
            </p>
          )}
        </div>
      )}

      {providers.length === 0 && !editing ? (
        <p className="text-sm text-fg-dim">
          {t("settings_provider_empty")}
        </p>
      ) : (
        <div className="space-y-2">
          {ordered.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              status={statusFor(p)}
              busy={busy}
              hideConnect={envLocked}
              onConnect={() => (backendKind(p.baseUrl) === "ollama" ? connectOllama() : connectLmStudio())}
              onEdit={() => { setForm({ name: p.name, baseUrl: p.baseUrl, authToken: "" }); setEditing(p.id); }}
              onDelete={() => del(p.id)}
            />
          ))}
        </div>
      )}

      {/* Preferred backend — only relevant when both local servers are live */}
      {bothRunning && !envLocked && currentMode !== "off" && (
        <div className="mt-4">
          <Label>{t("emb_preferred_label")}</Label>
          <p className="mb-1.5 text-xs text-fg-dim">{t("emb_preferred_hint")}</p>
          <div className="flex flex-wrap gap-1">
            {([
              { value: "ollama" as const, label: "Ollama" },
              { value: "lmstudio" as const, label: "LM Studio" },
            ]).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => choosePreferred(opt.value)}
                className={`rounded px-2.5 py-1 text-xs font-medium border transition-colors ${
                  preferred === opt.value
                    ? "bg-[var(--accent)] text-white border-transparent"
                    : "border-line text-fg-dim hover:text-fg"
                }`}
              >
                {opt.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => choosePreferred(null)}
              className={`rounded px-2.5 py-1 text-xs font-medium border transition-colors ${
                !preferred ? "bg-[var(--accent)] text-white border-transparent" : "border-line text-fg-dim hover:text-fg"
              }`}
            >
              {t("emb_preferred_auto")}
            </button>
          </div>
        </div>
      )}

      {/* Manual embeddings endpoint (for custom / non-detected servers) */}
      {/* Also shown in auto mode as an optional override so the user can force */}
      {/* a specific endpoint without restarting or switching to Manual mode.   */}
      {embeddings && !envLocked && (currentMode === "manual" || currentMode === "auto") && (
        <div className="mt-4">
          {currentMode === "auto" && (
            <div className="mb-2">
              <p className="text-xs font-medium text-fg-dim">{t("emb_override_label")}</p>
              <p className="text-xs text-fg-faint">{t("emb_override_hint")}</p>
            </div>
          )}
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
          <div className="mt-3 flex items-center gap-2">
            <Button onClick={saveManual} disabled={busy === "emb"}>
              {busy === "emb" ? t("saving") : t("save")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * One provider entry: name, base URL, live status (up/down/ready + model count),
 * available-model chips, an embeddings connect/connected control for local
 * backends, and Edit/Delete. Mirrors the Status page so the views feel unified.
 */
function ProviderRow({
  provider,
  status,
  busy,
  hideConnect,
  onConnect,
  onEdit,
  onDelete,
}: {
  provider: Provider;
  status: ProviderStatus;
  busy: string | null;
  hideConnect?: boolean;
  onConnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const probed = status.running !== undefined; // known local backend with a live probe
  const state = !probed ? "unknown" : !status.running ? "down" : status.connected ? "up" : "idle";
  const dot =
    state === "down" ? "bg-critical" : state === "up" ? "bg-ok" : state === "idle" ? "bg-warn" : "bg-fg-faint";
  const pill =
    state === "down"
      ? "bg-critical-subtle text-critical-fg"
      : state === "up"
        ? "bg-ok-subtle text-ok-fg"
        : state === "idle"
          ? "bg-warn-subtle text-warn-fg"
          : "bg-surface-2 text-fg-faint";
  const pillLabel = state === "down" ? t("status_down") : state === "up" ? t("status_up") : state === "idle" ? t("emb_backend_idle") : "—";
  const connectBusy = busy === status.kind;

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
            <span className="font-medium text-fg">{provider.name}</span>
          </div>
          <div className="mono mt-1 truncate text-xs text-fg-faint" title={provider.baseUrl}>
            {provider.baseUrl}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {probed && (
            <span className="tabular text-xs text-fg-dim">{t("status_models").replace("{n}", String(status.models.length))}</span>
          )}
          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${pill}`}>{pillLabel}</span>
        </div>
      </div>

      {status.models.length > 0 && (
        <div className="mono mt-2 flex flex-wrap gap-1.5">
          {status.models.map((m) => (
            <span key={m} className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-fg-muted">
              {m}
            </span>
          ))}
        </div>
      )}

      {status.kind && status.running && !status.embedCapable && (
        <p className="mt-2 text-xs text-fg-faint">
          {status.kind === "ollama" ? t("ollama_no_embed_model") + " ollama pull nomic-embed-text" : t("lmstudio_no_embed_model")}
        </p>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <div>
          {!hideConnect && status.kind && status.running && (
            status.connected ? (
              <span className="text-xs font-medium text-accent">
                {status.kind === "ollama" ? t("ollama_connected") : t("lmstudio_connected")}
              </span>
            ) : (
              <Button onClick={onConnect} disabled={connectBusy || !status.embedCapable}>
                {connectBusy
                  ? status.kind === "ollama" ? t("ollama_connecting") : t("lmstudio_connecting")
                  : status.kind === "ollama" ? t("ollama_connect") : t("lmstudio_connect")}
              </Button>
            )
          )}
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button onClick={onEdit}>{t("edit")}</Button>
          <Button variant="danger" onClick={onDelete}>{t("delete")}</Button>
        </div>
      </div>
    </div>
  );
}

