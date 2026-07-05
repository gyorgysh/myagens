import { useEffect, useState } from "react";
import { api, AuthError, type Provider } from "../api.ts";
import { useI18n } from "../lib/useI18n.ts";
import { errorMessage } from "../lib/errorMessage.ts";
import { toast } from "../lib/useToast.ts";
import { Badge, Button, Card, Input, Label, ModelSelect, Select, Skeleton } from "./ui.tsx";

type SttEngine = "openai" | "vosk" | "xai";
type TtsEngine = "openai" | "piper" | "xai";

const blankProvider = { name: "", baseUrl: "", authToken: "" };
const XAI_BASE_URL = "https://api.x.ai/v1";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const VOXTRAL_BASE_URL = "https://api.mistral.ai/v1";
// Built-in fallbacks shown when no voice provider is selected (env-based auth).
// Provider-backed pickers replace these with models fetched live from the provider.
const STT_MODEL_SUGGESTIONS = ["whisper-1"];
const TTS_MODEL_SUGGESTIONS = ["tts-1", "tts-1-hd"];

export function VoiceView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [providers, setProviders] = useState<Provider[]>([]);

  const [sttEngine, setSttEngine] = useState<SttEngine>("openai");
  const [sttProviderId, setSttProviderId] = useState("");
  const [sttModel, setSttModel] = useState("");
  const [voskModelPath, setVoskModelPath] = useState("");
  const [ttsEngine, setTtsEngine] = useState<TtsEngine>("openai");
  const [ttsProviderId, setTtsProviderId] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  const [ttsVoice, setTtsVoice] = useState("");
  const [piperPath, setPiperPath] = useState("");
  const [piperModel, setPiperModel] = useState("");
  const [sendVoiceNotes, setSendVoiceNotes] = useState(true);
  // The last-loaded server state, to diff against for the unsaved-changes dot.
  const [saved, setSaved] = useState<{
    sttEngine: SttEngine; sttProviderId: string; sttModel: string; voskModelPath: string;
    ttsEngine: TtsEngine; ttsProviderId: string; ttsModel: string; ttsVoice: string;
    piperPath: string; piperModel: string; sendVoiceNotes: boolean;
  } | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [editingProvider, setEditingProvider] = useState<string | "new" | null>(null);
  const [providerForm, setProviderForm] = useState(blankProvider);

  const load = () =>
    Promise.all([api.voiceSettings(), api.providers("voice")])
      .then(([v, p]) => {
        setSttEngine(v.sttEngine);
        setSttProviderId(v.sttProviderId);
        setSttModel(v.sttModel);
        setVoskModelPath(v.voskModelPath);
        setTtsEngine(v.ttsEngine);
        setTtsProviderId(v.ttsProviderId);
        setTtsModel(v.ttsModel);
        setTtsVoice(v.ttsVoice);
        setPiperPath(v.piperPath);
        setPiperModel(v.piperModel);
        setSendVoiceNotes(v.sendVoiceNotes);
        setSaved({
          sttEngine: v.sttEngine, sttProviderId: v.sttProviderId, sttModel: v.sttModel, voskModelPath: v.voskModelPath,
          ttsEngine: v.ttsEngine, ttsProviderId: v.ttsProviderId, ttsModel: v.ttsModel, ttsVoice: v.ttsVoice,
          piperPath: v.piperPath, piperModel: v.piperModel, sendVoiceNotes: v.sendVoiceNotes,
        });
        setProviders(p.providers);
      })
      .catch((e) => e instanceof AuthError && onAuthError());

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!saved) {
    return (
      <Card title={t("settings_voice_title")}>
        <Skeleton className="mb-4 h-4 w-3/4" />
        <div className="space-y-2">
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-9 w-full rounded-lg" />
        </div>
      </Card>
    );
  }

  const dirty =
    sttEngine !== saved.sttEngine ||
    sttProviderId !== saved.sttProviderId ||
    sttModel !== saved.sttModel ||
    voskModelPath !== saved.voskModelPath ||
    ttsEngine !== saved.ttsEngine ||
    ttsProviderId !== saved.ttsProviderId ||
    ttsModel !== saved.ttsModel ||
    ttsVoice !== saved.ttsVoice ||
    piperPath !== saved.piperPath ||
    piperModel !== saved.piperModel ||
    sendVoiceNotes !== saved.sendVoiceNotes;

  const dirtyDot = dirty ? (
    <span
      className="h-1.5 w-1.5 rounded-full bg-warn"
      title={t("settings_unsaved")}
      aria-label={t("settings_unsaved")}
    />
  ) : undefined;

  const save = async () => {
    setBusy("save");
    try {
      const next = await api.updateVoiceSettings({
        sttEngine, sttProviderId, sttModel, voskModelPath,
        ttsEngine, ttsProviderId, ttsModel, ttsVoice, piperPath, piperModel,
        sendVoiceNotes,
      });
      setSaved({
        sttEngine: next.sttEngine, sttProviderId: next.sttProviderId, sttModel: next.sttModel, voskModelPath: next.voskModelPath,
        ttsEngine: next.ttsEngine, ttsProviderId: next.ttsProviderId, ttsModel: next.ttsModel, ttsVoice: next.ttsVoice,
        piperPath: next.piperPath, piperModel: next.piperModel, sendVoiceNotes: next.sendVoiceNotes,
      });
      toast.success(t("saved"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  };

  const fetchSttModels = async (): Promise<string[]> => {
    if (!sttProviderId) return [];
    try {
      return (await api.providerModels(sttProviderId)).models;
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      return [];
    }
  };

  const fetchTtsModels = async (): Promise<string[]> => {
    if (!ttsProviderId) return [];
    try {
      return (await api.providerModels(ttsProviderId)).models;
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      return [];
    }
  };

  const startNewProvider = (engine: "openai" | "xai" | "voxtral") => {
    const preset = {
      xai: { name: "xAI Voice", baseUrl: XAI_BASE_URL },
      voxtral: { name: "Voxtral (Mistral)", baseUrl: VOXTRAL_BASE_URL },
      openai: { name: "OpenAI Voice", baseUrl: OPENAI_BASE_URL },
    }[engine];
    setProviderForm({ ...preset, authToken: "" });
    setEditingProvider("new");
  };

  const editingProviderRow =
    editingProvider && editingProvider !== "new" ? providers.find((p) => p.id === editingProvider) : undefined;

  const saveProvider = async () => {
    try {
      const savedProvider =
        editingProvider === "new"
          ? await api.createProvider({ ...providerForm, purpose: "voice" })
          : await api.updateProvider(editingProvider!, providerForm);
      setProviders((prev) => {
        const idx = prev.findIndex((p) => p.id === savedProvider.id);
        if (idx === -1) return [...prev, savedProvider];
        const next = [...prev];
        next[idx] = savedProvider;
        return next;
      });
      setEditingProvider(null);
      toast.success(t("saved"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    }
  };

  const deleteProvider = async (id: string) => {
    if (!confirm(t("settings_provider_delete_confirm"))) return;
    try {
      await api.deleteProvider(id);
      setProviders((prev) => prev.filter((p) => p.id !== id));
      if (sttProviderId === id) setSttProviderId("");
      if (ttsProviderId === id) setTtsProviderId("");
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    }
  };

  return (
    <Card title={t("settings_voice_title")} right={dirtyDot}>
      <p className="mb-4 text-sm text-fg-dim">{t("settings_voice_desc")}</p>

      {/* Transcription (STT) */}
      <div>
        <Label>{t("settings_voice_stt_engine")}</Label>
        <Select value={sttEngine} onChange={(e) => setSttEngine(e.target.value as SttEngine)}>
          <option value="openai">{t("settings_voice_engine_openai")}</option>
          <option value="vosk">{t("settings_voice_engine_vosk")}</option>
          <option value="xai">{t("settings_voice_engine_xai")}</option>
        </Select>

        {sttEngine === "vosk" ? (
          <div className="mt-2">
            <Label>{t("settings_voice_vosk_path")}</Label>
            <Input
              value={voskModelPath}
              onChange={(e) => setVoskModelPath(e.target.value)}
              placeholder="/path/to/vosk-model"
            />
          </div>
        ) : (
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{t("settings_voice_provider")}</Label>
              <Select value={sttProviderId} onChange={(e) => setSttProviderId(e.target.value)}>
                <option value="">{t("settings_voice_provider_env")}</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </div>
            {sttEngine === "openai" && (
              <div>
                <Label>{t("model")}</Label>
                <ModelSelect
                  value={sttModel}
                  onChange={setSttModel}
                  suggestions={sttProviderId ? [] : STT_MODEL_SUGGESTIONS}
                  onFetch={sttProviderId ? fetchSttModels : undefined}
                  fetchLabel={t("fetch")}
                  placeholder="whisper-1"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Spoken replies (TTS) */}
      <div className="mt-5 border-t border-line pt-4">
        <Label>{t("settings_voice_tts_engine")}</Label>
        <Select value={ttsEngine} onChange={(e) => setTtsEngine(e.target.value as TtsEngine)}>
          <option value="openai">{t("settings_voice_engine_openai")}</option>
          <option value="piper">{t("settings_voice_engine_piper")}</option>
          <option value="xai">{t("settings_voice_engine_xai")}</option>
        </Select>

        {ttsEngine === "piper" ? (
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{t("settings_voice_piper_path")}</Label>
              <Input value={piperPath} onChange={(e) => setPiperPath(e.target.value)} placeholder="piper" />
            </div>
            <div>
              <Label>{t("settings_voice_piper_model")}</Label>
              <Input
                value={piperModel}
                onChange={(e) => setPiperModel(e.target.value)}
                placeholder="/path/to/voice.onnx"
              />
            </div>
          </div>
        ) : (
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{t("settings_voice_provider")}</Label>
              <Select value={ttsProviderId} onChange={(e) => setTtsProviderId(e.target.value)}>
                <option value="">{t("settings_voice_provider_env")}</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>{t("settings_voice_voice")}</Label>
              <Input
                value={ttsVoice}
                onChange={(e) => setTtsVoice(e.target.value)}
                placeholder={ttsEngine === "xai" ? "eve" : "alloy"}
              />
            </div>
            {ttsEngine === "openai" && (
              <div>
                <Label>{t("model")}</Label>
                <ModelSelect
                  value={ttsModel}
                  onChange={setTtsModel}
                  suggestions={ttsProviderId ? [] : TTS_MODEL_SUGGESTIONS}
                  onFetch={ttsProviderId ? fetchTtsModels : undefined}
                  fetchLabel={t("fetch")}
                  placeholder="tts-1"
                />
              </div>
            )}
          </div>
        )}

        <label className="mt-3 flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={sendVoiceNotes}
            onChange={(e) => setSendVoiceNotes(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
          />
          <span>
            <span className="text-sm font-medium text-fg">{t("settings_voice_send_notes")}</span>
            <span className="block text-xs text-fg-dim">{t("settings_voice_send_notes_desc")}</span>
          </span>
        </label>
      </div>

      <div className="mt-4 flex gap-2 border-t border-line pt-4">
        <Button variant="primary" onClick={save} disabled={!dirty || busy === "save"}>
          {t("save")}
        </Button>
      </div>

      {/* Voice provider keys (xAI / OpenAI-compatible) */}
      <div className="mt-6 border-t border-line pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-fg">{t("settings_voice_providers_title")}</h3>
          <div className="flex gap-2">
            <Button onClick={() => startNewProvider("openai")}>+ {t("settings_voice_engine_openai")}</Button>
            <Button onClick={() => startNewProvider("xai")}>+ {t("settings_voice_engine_xai")}</Button>
            <Button onClick={() => startNewProvider("voxtral")}>+ {t("settings_voice_engine_voxtral")}</Button>
          </div>
        </div>
        <p className="mt-1 text-xs text-fg-dim">{t("settings_voice_providers_desc")}</p>

        {editingProvider && (
          <div className="my-3 space-y-3 rounded-lg border border-line bg-input p-3">
            <div>
              <Label>{t("settings_provider_name")}</Label>
              <Input
                value={providerForm.name}
                onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })}
              />
            </div>
            <div>
              <Label>{t("settings_provider_base_url")}</Label>
              <Input
                value={providerForm.baseUrl}
                onChange={(e) => setProviderForm({ ...providerForm, baseUrl: e.target.value })}
              />
            </div>
            <div>
              <Label>{t("settings_provider_auth")}</Label>
              <Input
                type="password"
                value={providerForm.authToken}
                onChange={(e) => setProviderForm({ ...providerForm, authToken: e.target.value })}
                placeholder={
                  editingProviderRow?.hasToken
                    ? `${editingProviderRow.tokenHint} — ${t("settings_provider_auth_keep")}`
                    : "sk-…"
                }
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={saveProvider}
                disabled={!providerForm.name.trim() || !providerForm.baseUrl.trim()}
              >
                {t("save")}
              </Button>
              <Button onClick={() => setEditingProvider(null)}>{t("cancel")}</Button>
            </div>
          </div>
        )}

        {providers.length === 0 && !editingProvider ? (
          <p className="mt-2 text-xs text-fg-faint">{t("settings_voice_providers_empty")}</p>
        ) : (
          <div className="mt-3 space-y-2">
            {providers.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-line p-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{p.name}</span>
                    <Badge>{p.hasToken ? p.tokenHint : t("settings_voice_no_token")}</Badge>
                  </div>
                  <p className="mono mt-0.5 text-xs text-fg-faint">{p.baseUrl}</p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    onClick={() => {
                      setProviderForm({ name: p.name, baseUrl: p.baseUrl, authToken: "" });
                      setEditingProvider(p.id);
                    }}
                  >
                    {t("edit")}
                  </Button>
                  <Button variant="danger" onClick={() => deleteProvider(p.id)}>
                    {t("delete")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
