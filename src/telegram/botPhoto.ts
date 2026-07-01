import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
 * `-F photo=@file` fails with "photo isn't specified".
 *
 * telegraf 4.16.3 cannot pack this request: its multipart builder only treats a
 * field as a file when the object carries a `media` property, so an
 * InputProfilePhoto (`{ type, photo: "attach://av" }`) plus a sibling
 * `av: { source }` is silently dropped and Telegram rejects the call. So we
 * build the multipart form directly against the bot's own token, mirroring the
 * working curl form in work.md:
 *   -F 'photo={"type":"static","photo":"attach://av"}' -F "av=@fox.png"
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
    const { token, options } = tg as unknown as {
      token: string;
      options: { apiRoot: string; apiMode?: string };
    };
    const apiRoot = options.apiRoot.replace(/\/+$/, "");
    const apiMode = options.apiMode ?? "bot";
    const url = `${apiRoot}/${apiMode}${token}/setMyProfilePhoto`;

    const png = await readFile(path);
    const form = new FormData();
    form.append("photo", JSON.stringify({ type: "static", photo: "attach://av" }));
    form.append("av", new Blob([png], { type: "image/png" }), `${slug}.png`);

    const res = await fetch(url, { method: "POST", body: form });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!res.ok || !data?.ok) {
      log.warn("setMyProfilePhoto rejected", {
        slug,
        status: res.status,
        description: data?.description,
      });
      return false;
    }
    return true;
  } catch (err) {
    log.warn("setMyProfilePhoto failed", { slug, error: String(err) });
    return false;
  }
}
