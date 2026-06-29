import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import type { Telegram } from "telegraf";
import { repoRoot } from "../config.js";
import { log } from "../logger.js";

/** Full-size (512px) PNG path for a curated avatar slug, or undefined if absent. */
function avatarPngPath(slug: string): string | undefined {
  // Slug comes from the curated set / worker record; constrain it to a safe
  // charset so it can't escape the avatars directory.
  if (!/^[a-z0-9_]+$/.test(slug)) return undefined;
  const p = join(repoRoot, "panel", "public", "avatars", `${slug}.png`);
  return existsSync(p) ? p : undefined;
}

/**
 * Set a bot's Telegram profile photo to a curated avatar PNG.
 *
 * Uses the Bot API `setMyProfilePhoto` method, which takes an InputProfilePhoto
 * JSON object plus a multipart file attachment referenced by `attach://`. A bare
 * `-F photo=@file` fails with "photo isn't specified"; telegraf's callApi packs
 * the sibling `{ source }` entry as the named attachment, mirroring the curl
 * form in work.md.
 *
 * Telegram persists the photo, so calling this on every startup is idempotent.
 * Returns true on success; never throws — a photo is cosmetic and must never
 * block bot startup.
 */
export async function setBotProfilePhoto(tg: Telegram, slug: string): Promise<boolean> {
  const path = avatarPngPath(slug);
  if (!path) {
    log.warn("Bot profile photo skipped: no PNG for avatar", { slug });
    return false;
  }
  try {
    await (tg as unknown as { callApi: (m: string, p: Record<string, unknown>) => Promise<unknown> }).callApi(
      "setMyProfilePhoto",
      {
        photo: { type: "static", photo: "attach://av" },
        av: { source: createReadStream(path) },
      },
    );
    return true;
  } catch (err) {
    log.warn("setMyProfilePhoto failed", { slug, error: String(err) });
    return false;
  }
}
