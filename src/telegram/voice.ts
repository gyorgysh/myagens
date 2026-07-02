import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { resolveVoiceSettings } from "../core/voiceSettings.js";
import { safeFetch } from "../core/safeUrl.js";
import { transcribeVosk, voskConfigured } from "./vosk.js";
import { t } from "./i18n/index.js";

/** True if voice transcription is configured for the selected provider. */
export function voiceEnabled(): boolean {
  const { stt } = resolveVoiceSettings();
  if (stt.engine === "vosk") return voskConfigured();
  return Boolean(stt.apiKey);
}

/** A short hint telling the operator how to enable voice for their provider. */
export function voiceSetupHint(lang?: string): string {
  const { stt } = resolveVoiceSettings();
  if (stt.engine === "vosk") return t("voice_hint_vosk", lang);
  if (stt.engine === "xai") return t("voice_hint_xai", lang);
  return t("voice_hint_openai", lang);
}

/** Transcribe a voice/audio file using the configured backend (openai | vosk | xai). */
export async function transcribeAudio(filePath: string): Promise<string> {
  const { stt } = resolveVoiceSettings();
  if (stt.engine === "vosk") return transcribeVosk(filePath);
  if (stt.engine === "xai") return transcribeXai(filePath);
  return transcribeOpenAI(filePath);
}

/**
 * Transcribe via an OpenAI-compatible /audio/transcriptions endpoint (OpenAI,
 * Groq, …). Telegram voice notes are OGG/Opus, which Whisper accepts directly.
 */
async function transcribeOpenAI(filePath: string): Promise<string> {
  const { stt } = resolveVoiceSettings();
  if (!stt.apiKey) {
    throw new Error("Voice transcription is not configured (set an OpenAI-compatible provider or OPENAI_API_KEY).");
  }

  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append("model", stt.model);
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: "audio/ogg" }),
    basename(filePath),
  );

  const res = await safeFetch(`${stt.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${stt.apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Transcription failed (HTTP ${res.status}): ${detail}`);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}

/**
 * Transcribe via xAI's /v1/stt endpoint. Telegram voice notes are OGG/Opus, one
 * of xAI's auto-detected container formats, so the raw bytes go straight into
 * the multipart `file` field — no audio_format/sample_rate (those are only for
 * headerless raw PCM/mulaw/alaw).
 */
async function transcribeXai(filePath: string): Promise<string> {
  const { stt } = resolveVoiceSettings();
  if (!stt.apiKey) {
    throw new Error("Voice transcription is not configured (set an xAI voice provider or XAI_API_KEY).");
  }

  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: "audio/ogg" }),
    basename(filePath),
  );

  const res = await safeFetch(`${stt.baseUrl}/stt`, {
    method: "POST",
    headers: { Authorization: `Bearer ${stt.apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Transcription failed (HTTP ${res.status}): ${detail}`);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}
