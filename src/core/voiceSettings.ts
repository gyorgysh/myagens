import { config } from "../config.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { getProvider, listProviderViews } from "./providers.js";
import { resolveSecret } from "./vault.js";
import { audit } from "./audit.js";

const FILE = "voiceSettings.json";

type SttEngine = "openai" | "vosk" | "xai";
type TtsEngine = "openai" | "piper" | "xai";

/** Panel overrides for voice transcription (STT) and spoken replies (TTS).
 *  Every field falls back to the matching .env var (see config.ts) when unset,
 *  so an existing self-hosted deployment keeps working untouched. */
interface VoiceSettings {
  sttEngine?: SttEngine;
  /** Provider id (purpose "voice") supplying baseUrl + API key for openai/xai STT. */
  sttProviderId?: string;
  sttModel?: string;
  voskModelPath?: string;

  ttsEngine?: TtsEngine;
  /** Provider id (purpose "voice") supplying baseUrl + API key for openai/xai TTS. */
  ttsProviderId?: string;
  ttsModel?: string;
  ttsVoice?: string;
  piperPath?: string;
  piperModel?: string;

  /** Transcode xai/piper WAV output to Opus/OGG so replies send as a real
   *  Telegram voice note instead of a file attachment. Default true. */
  sendVoiceNotes?: boolean;
}

interface VoiceFile {
  version: 1;
  settings: VoiceSettings;
}

function load(): VoiceSettings {
  return loadJson<VoiceFile>(FILE, { version: 1, settings: {} }).settings;
}

export interface VoiceSettingsPatch {
  sttEngine?: SttEngine | "";
  sttProviderId?: string;
  sttModel?: string;
  voskModelPath?: string;
  ttsEngine?: TtsEngine | "";
  ttsProviderId?: string;
  ttsModel?: string;
  ttsVoice?: string;
  piperPath?: string;
  piperModel?: string;
  sendVoiceNotes?: boolean;
}

/** Panel-facing view: raw selection plus resolved provider names (never a token). */
export function voiceSettingsView() {
  const s = load();
  const sttProvider = s.sttProviderId ? getProvider(s.sttProviderId) : undefined;
  const ttsProvider = s.ttsProviderId ? getProvider(s.ttsProviderId) : undefined;
  return {
    sttEngine: s.sttEngine ?? config.TRANSCRIBE_PROVIDER,
    sttProviderId: s.sttProviderId ?? "",
    sttProviderName: sttProvider?.name,
    sttModel: s.sttModel ?? config.TRANSCRIBE_MODEL,
    voskModelPath: s.voskModelPath ?? config.VOSK_MODEL_PATH ?? "",
    ttsEngine: s.ttsEngine ?? config.TTS_PROVIDER,
    ttsProviderId: s.ttsProviderId ?? "",
    ttsProviderName: ttsProvider?.name,
    ttsModel: s.ttsModel ?? config.TTS_MODEL,
    ttsVoice: s.ttsVoice ?? config.TTS_VOICE,
    piperPath: s.piperPath ?? config.PIPER_PATH,
    piperModel: s.piperModel ?? config.PIPER_MODEL ?? "",
    sendVoiceNotes: s.sendVoiceNotes ?? true,
    voiceProviders: listProviderViews({ purpose: "voice" }).map((p) => ({ id: p.id, name: p.name })),
  };
}

export function setVoiceSettings(patch: VoiceSettingsPatch): void {
  const s = load();
  if (patch.sttEngine !== undefined) s.sttEngine = patch.sttEngine || undefined;
  if (patch.sttProviderId !== undefined) s.sttProviderId = patch.sttProviderId || undefined;
  if (patch.sttModel !== undefined) s.sttModel = patch.sttModel.trim() || undefined;
  if (patch.voskModelPath !== undefined) s.voskModelPath = patch.voskModelPath.trim() || undefined;
  if (patch.ttsEngine !== undefined) s.ttsEngine = patch.ttsEngine || undefined;
  if (patch.ttsProviderId !== undefined) s.ttsProviderId = patch.ttsProviderId || undefined;
  if (patch.ttsModel !== undefined) s.ttsModel = patch.ttsModel.trim() || undefined;
  if (patch.ttsVoice !== undefined) s.ttsVoice = patch.ttsVoice.trim() || undefined;
  if (patch.piperPath !== undefined) s.piperPath = patch.piperPath.trim() || undefined;
  if (patch.piperModel !== undefined) s.piperModel = patch.piperModel.trim() || undefined;
  if (patch.sendVoiceNotes !== undefined) s.sendVoiceNotes = patch.sendVoiceNotes;
  saveJson<VoiceFile>(FILE, { version: 1, settings: s });
  audit("voiceSettings.update", { sttEngine: s.sttEngine, ttsEngine: s.ttsEngine });
}

/** A resolved {baseUrl, apiKey} pair for an openai/xai voice engine: the linked
 *  provider's credentials when set, else the legacy env-var fallback. */
function resolveCredential(
  providerId: string | undefined,
  fallback: { baseUrl: string; apiKey: string },
): { baseUrl: string; apiKey: string } {
  const provider = providerId ? getProvider(providerId) : undefined;
  if (!provider) return fallback;
  return { baseUrl: provider.baseUrl, apiKey: resolveSecret(provider.authToken) };
}

export interface ResolvedVoiceSettings {
  stt: {
    engine: SttEngine;
    baseUrl: string;
    apiKey: string;
    model: string;
    voskModelPath: string;
  };
  tts: {
    engine: TtsEngine;
    baseUrl: string;
    apiKey: string;
    model: string;
    voice: string;
    piperPath: string;
    piperModel: string;
  };
  ffmpegPath: string;
  sendVoiceNotes: boolean;
}

/** xAI has no "OpenAI-compatible base URL" env var to fall back to — it's
 *  always been a fixed host, matching the previous hardcoded behavior. */
const XAI_BASE_URL = "https://api.x.ai/v1";

/** Resolve the effective voice config for this turn: panel settings first,
 *  falling back to the .env values so an unconfigured panel keeps working. */
export function resolveVoiceSettings(): ResolvedVoiceSettings {
  const s = load();
  const sttEngine = s.sttEngine ?? config.TRANSCRIBE_PROVIDER;
  const ttsEngine = s.ttsEngine ?? config.TTS_PROVIDER;
  const stt = resolveCredential(s.sttProviderId, {
    baseUrl: sttEngine === "xai" ? XAI_BASE_URL : config.TRANSCRIBE_BASE_URL,
    apiKey: sttEngine === "xai" ? (config.XAI_API_KEY ?? "") : (config.OPENAI_API_KEY ?? ""),
  });
  const tts = resolveCredential(s.ttsProviderId, {
    baseUrl: ttsEngine === "xai" ? XAI_BASE_URL : config.TTS_BASE_URL,
    apiKey: ttsEngine === "xai" ? (config.XAI_API_KEY ?? "") : (config.OPENAI_API_KEY ?? ""),
  });
  return {
    stt: {
      engine: sttEngine,
      baseUrl: stt.baseUrl,
      apiKey: stt.apiKey,
      model: s.sttModel ?? config.TRANSCRIBE_MODEL,
      voskModelPath: s.voskModelPath ?? config.VOSK_MODEL_PATH ?? "",
    },
    tts: {
      engine: ttsEngine,
      baseUrl: tts.baseUrl,
      apiKey: tts.apiKey,
      model: s.ttsModel ?? config.TTS_MODEL,
      voice: s.ttsVoice ?? config.TTS_VOICE,
      piperPath: s.piperPath ?? config.PIPER_PATH,
      piperModel: s.piperModel ?? config.PIPER_MODEL ?? "",
    },
    ffmpegPath: config.FFMPEG_PATH,
    sendVoiceNotes: s.sendVoiceNotes ?? true,
  };
}
