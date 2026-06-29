/**
 * Server-side avatar slug resolution, mirroring panel/src/lib/avatar.ts so the
 * backend derives the same default avatar the panel shows. Keep the slug list
 * and hash in sync with the panel copy and panel/public/avatars/index.json.
 */

/** Curated avatar slugs (excludes nothing — reserved filtering is a UI concern). */
const AVATAR_SLUGS = [
  "panda",
  "koala",
  "trex",
  "robot",
  "fox",
  "octopus",
  "owl",
  "axolotl",
  "capybara",
  "raccoon",
  "chameleon",
  "narwhal",
  "red_panda",
] as const;

/** Stable, order-independent string hash (FNV-1a), identical to the panel's. */
function simpleHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic default avatar slug for a worker id (panel-matching). */
export function defaultAvatarSlug(id: string): string {
  return AVATAR_SLUGS[simpleHash(id) % AVATAR_SLUGS.length];
}

/** Explicit avatar when set, otherwise the deterministic default from the id. */
export function resolveAvatarSlug(id: string, avatar?: string): string {
  if (avatar && avatar.trim()) return avatar.trim();
  return defaultAvatarSlug(id);
}
