import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveVoiceSettings } from "../core/voiceSettings.js";
import { log } from "../logger.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// `vosk` ships no useful types and is loaded lazily (optional native dep), so
// it's typed loosely here behind a narrow surface.

const SAMPLE_RATE = 16000;

/** True if the local Vosk backend is configured (model path present). */
export function voskConfigured(): boolean {
  return Boolean(resolveVoiceSettings().stt.voskModelPath);
}

// Loading the acoustic model is expensive (hundreds of MB) — do it once. We
// also cache the loaded module namespace (Recognizer etc.).
let vosk: any;
let modelPromise: Promise<any> | undefined;

// Non-literal specifier so TS doesn't require this optional native dep at build.
const VOSK_MODULE = "vosk";

async function getModel(): Promise<any> {
  const modelPath = resolveVoiceSettings().stt.voskModelPath;
  if (!modelPath) {
    throw new Error("Vosk model path is not set (configure Voice settings in the panel, or set VOSK_MODEL_PATH).");
  }
  if (!existsSync(modelPath)) {
    throw new Error(`Vosk model not found at ${modelPath}.`);
  }
  if (!modelPromise) {
    modelPromise = (async () => {
      let mod: any;
      try {
        mod = await import(VOSK_MODULE);
      } catch (err) {
        throw new Error(
          "The 'vosk' package isn't installed. Run `npm install vosk` " +
            `(it's an optional native dependency). Original error: ${errText(err)}`,
        );
      }
      vosk = mod.default ?? mod;
      vosk.setLogLevel(-1);
      log.info("Loading Vosk model", { path: modelPath });
      return new vosk.Model(modelPath);
    })().catch((err) => {
      modelPromise = undefined; // allow a later retry after fixing the setup
      throw err;
    });
  }
  return modelPromise;
}

/** Transcribe an OGG/Opus (or any ffmpeg-readable) audio file locally via Vosk. */
export async function transcribeVosk(filePath: string): Promise<string> {
  const [model, pcm] = await Promise.all([getModel(), decodeToPcm(filePath)]);

  const rec = new vosk.Recognizer({ model, sampleRate: SAMPLE_RATE });
  try {
    // Feed in modest chunks so very long notes don't spike memory.
    const CHUNK = 8000;
    for (let i = 0; i < pcm.length; i += CHUNK) {
      rec.acceptWaveform(pcm.subarray(i, i + CHUNK));
    }
    const result = rec.finalResult() as { text?: string };
    return (result.text ?? "").trim();
  } finally {
    rec.free();
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Decode any audio file to raw 16kHz mono signed-16-bit PCM using ffmpeg. */
function decodeToPcm(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ["-i", filePath, "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "-loglevel", "error", "pipe:1"];
    const ff = spawn(resolveVoiceSettings().ffmpegPath, args);
    const out: Buffer[] = [];
    const errOut: string[] = [];
    ff.stdout.on("data", (d: Buffer) => out.push(d));
    ff.stderr.on("data", (d: Buffer) => errOut.push(d.toString()));
    ff.on("error", (err) => {
      reject(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`ffmpeg not found (set FFMPEG_PATH). It's required to decode voice notes for Vosk.`)
          : err,
      );
    });
    ff.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${errOut.join("").slice(0, 300)}`));
    });
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
