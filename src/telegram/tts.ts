import { spawn } from "node:child_process";
import type { Telegram } from "telegraf";
import { resolveVoiceSettings } from "../core/voiceSettings.js";
import { safeFetch } from "../core/safeUrl.js";
import { log } from "../logger.js";

/** True if text-to-speech is configured for the selected provider. */
export function ttsEnabled(): boolean {
  const { tts } = resolveVoiceSettings();
  if (tts.engine === "piper") return Boolean(tts.piperModel);
  return Boolean(tts.apiKey);
}

/** A short hint telling the operator how to enable spoken replies. */
export function ttsSetupHint(): string {
  const { tts } = resolveVoiceSettings();
  if (tts.engine === "piper")
    return "Set PIPER_PATH + PIPER_MODEL (a local .onnx voice), or configure Voice settings in the panel, to enable spoken replies.";
  if (tts.engine === "xai")
    return "Add an xAI voice provider in Settings → Voice (or set XAI_API_KEY) to enable spoken replies.";
  return "Add an OpenAI-compatible voice provider in Settings → Voice (or set OPENAI_API_KEY) to enable spoken replies.";
}

/**
 * Telegram voice messages must be OGG/Opus. None of the backends are assumed
 * to emit that directly — "openai" covers arbitrary OpenAI-compatible
 * providers (Groq, proxies, etc.) whose supported `response_format` values
 * vary and can't be assumed to include opus, so all backends emit WAV and we
 * transcode to Opus/OGG via ffmpeg (same runtime dependency already used to
 * decode incoming voice notes for Vosk) so replies still arrive as a real
 * voice note; if ffmpeg is unavailable or `sendVoiceNotes` is off, the WAV is
 * sent as a plain audio file instead. The caller picks the send method from
 * `format`.
 */
export interface SpeechResult {
  audio: Buffer;
  /** "ogg" → Telegram voice note (sendVoice); "wav" → audio file (sendAudio). */
  format: "ogg" | "wav";
}

/** Synthesize speech for `text` using the configured backend (openai | piper | xai). */
export async function synthesizeSpeech(text: string): Promise<SpeechResult> {
  const clipped = text.slice(0, TTS_MAX_CHARS).trim();
  if (!clipped) throw new Error("Nothing to speak.");
  const resolved = resolveVoiceSettings();
  const wav =
    resolved.tts.engine === "openai"
      ? await synthesizeOpenAI(clipped)
      : resolved.tts.engine === "piper"
        ? await synthesizePiper(clipped)
        : await synthesizeXai(clipped);
  if (!resolved.sendVoiceNotes) return { audio: wav, format: "wav" };
  try {
    const opus = await transcodeToOgg(wav);
    return { audio: opus, format: "ogg" };
  } catch (err) {
    log.warn("WAV→Opus transcode failed, sending as audio file instead", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { audio: wav, format: "wav" };
  }
}

/** Cap how much text we send to TTS so a long reply doesn't run for minutes. */
const TTS_MAX_CHARS = 2000;

/** Synthesize via an OpenAI-compatible /audio/speech endpoint, returning WAV. */
async function synthesizeOpenAI(text: string): Promise<Buffer> {
  const { tts } = resolveVoiceSettings();
  if (!tts.apiKey) {
    throw new Error("Text-to-speech is not configured (set an OpenAI-compatible provider or OPENAI_API_KEY).");
  }
  const res = await safeFetch(`${tts.baseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: tts.model,
      voice: tts.voice,
      input: text,
      response_format: "wav",
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Speech synthesis failed (HTTP ${res.status}): ${detail}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Synthesize via xAI's /v1/tts endpoint, requesting WAV output — xAI's TTS
 * doesn't offer an Opus/OGG codec (mp3/wav/pcm/mulaw/alaw only), so the result
 * goes through the ffmpeg transcode step above. `language` is required by the
 * API; "auto" lets it detect from `text`. The voice setting's schema default
 * ("alloy") is an OpenAI voice name, not a real xAI one, so an unset/default
 * voice substitutes xAI's own default ("eve") instead.
 */
async function synthesizeXai(text: string): Promise<Buffer> {
  const { tts } = resolveVoiceSettings();
  if (!tts.apiKey) {
    throw new Error("Text-to-speech is not configured (set an xAI voice provider or XAI_API_KEY).");
  }
  const voiceId = tts.voice === "alloy" ? "eve" : tts.voice;
  const res = await safeFetch(`${tts.baseUrl}/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voice_id: voiceId,
      language: "auto",
      output_format: { codec: "wav", sample_rate: 24000 },
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Speech synthesis failed (HTTP ${res.status}): ${detail}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Synthesize via a local Piper binary, returning WAV bytes on stdout. */
function synthesizePiper(text: string): Promise<Buffer> {
  const { tts } = resolveVoiceSettings();
  if (!tts.piperModel) {
    throw new Error("Local TTS is not configured (set PIPER_MODEL, or configure Voice settings in the panel).");
  }
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      tts.piperPath,
      ["--model", tts.piperModel, "--output_file", "-"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        log.warn("Piper TTS exited non-zero", { code, stderr: stderr.slice(0, 300) });
        reject(new Error(`Piper exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

/** Transcode WAV bytes to Opus-in-OGG via ffmpeg, for a true Telegram voice note. */
function transcodeToOgg(wav: Buffer): Promise<Buffer> {
  const { ffmpegPath } = resolveVoiceSettings();
  return new Promise<Buffer>((resolve, reject) => {
    const args = ["-i", "pipe:0", "-c:a", "libopus", "-f", "ogg", "-loglevel", "error", "pipe:1"];
    const ff = spawn(ffmpegPath, args);
    const out: Buffer[] = [];
    const errOut: string[] = [];
    ff.stdout.on("data", (d: Buffer) => out.push(d));
    ff.stderr.on("data", (d: Buffer) => errOut.push(d.toString()));
    ff.on("error", (err) => {
      reject(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error("ffmpeg not found (set FFMPEG_PATH) — required to send voice replies as voice notes.")
          : err,
      );
    });
    ff.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${errOut.join("").slice(0, 300)}`));
    });
    ff.stdin.write(wav);
    ff.stdin.end();
  });
}

/**
 * Reduce a markdown reply to plain text suitable for speaking: drop code blocks,
 * inline-code/formatting markers, links (keep the label), list bullets, and the
 * "---" log delimiter, then collapse whitespace.
 */
export function speechText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images → label
    .replace(/^[ \t]*[-*+]\s+/gm, "") // list bullets
    .replace(/^>\s?/gm, "") // blockquotes
    .replace(/[*_#~]/g, "") // bold/italic/heading/strike markers
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Synthesize `markdown` and deliver it to `chatId` as a spoken message. Opus
 * output is sent as a true Telegram voice note; WAV (when transcoding wasn't
 * possible) goes as an audio file. Best-effort: logs and swallows any failure
 * so a TTS hiccup never breaks the (already-sent) text reply.
 */
export async function sendVoiceReply(tg: Telegram, chatId: number, markdown: string): Promise<void> {
  const spoken = speechText(markdown);
  if (!spoken) return;
  try {
    const { audio, format } = await synthesizeSpeech(spoken);
    if (format === "ogg") {
      await tg.sendVoice(chatId, { source: audio });
    } else {
      await tg.sendAudio(chatId, { source: audio, filename: "reply.wav" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Voice reply failed", { chatId, error: message });
    if (message.includes("terms acceptance")) {
      const url = message.match(/https?:\/\/\S+/)?.[0]?.replace(/[)\].,]+$/, "");
      const hint = `Voice reply failed: the TTS model needs one-time terms acceptance in the provider console before it'll work.${url ? ` Accept them here: ${url}` : ""}`;
      try {
        await tg.sendMessage(chatId, hint);
      } catch {
        // best-effort notice only; a failure here isn't worth surfacing further
      }
    }
  }
}
