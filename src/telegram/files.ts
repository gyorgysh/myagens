import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path, { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Telegram } from "telegraf";
import type { ImageInput } from "../claude/runner.js";

/** Map known image extensions to the MIME types the model accepts. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** True if the path looks like an image the model can view inline. */
export function isViewableImage(path: string): boolean {
  return extname(path).toLowerCase() in IMAGE_MEDIA_TYPES;
}

/**
 * Read a saved image file into an inline-vision ImageInput, or return undefined
 * if it isn't a supported image type.
 */
export async function readImageInput(path: string): Promise<ImageInput | undefined> {
  const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase()];
  if (!mediaType) return undefined;
  const base64 = (await readFile(path)).toString("base64");
  return { base64, mediaType };
}

/**
 * Download an incoming Telegram file into <cwd>/uploads and return the absolute
 * path, so the next prompt can point Claude at it.
 */
export async function downloadIncomingFile(
  tg: Telegram,
  fileId: string,
  suggestedName: string,
  cwd: string,
): Promise<string> {
  const dir = join(cwd, "uploads");
  await mkdir(dir, { recursive: true });

  const link = await tg.getFileLink(fileId);
  const res = await fetch(link.href);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download file (HTTP ${res.status})`);
  }

  const safeName =
    (suggestedName.replace(/[^\w.\-]+/g, "_") || `file_${Date.now()}`).replace(/^\.+/, "") ||
    `file_${Date.now()}`;
  const dest = join(dir, safeName);
  if (!dest.startsWith(dir + path.sep) && dest !== dir) {
    throw new Error("path traversal blocked");
  }
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
  return dest;
}
