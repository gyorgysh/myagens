import { useEffect, useState } from "react";

/** One entry in the curated avatar set (matches panel/public/avatars/index.json). */
export interface AvatarEntry {
  slug: string;
  label: string;
  /** When true, the slug is excluded from the Lead assignment shuffle (e.g. the
   *  robot avatar is reserved as Atlas's fixed identity). */
  reserved?: boolean;
}

/**
 * Fallback slug list, kept in sync with public/avatars/index.json. Used to
 * derive a deterministic default avatar immediately, before the full index
 * (with labels) has been fetched. The picker uses the fetched list instead.
 */
export const AVATAR_SLUGS = [
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

/** Stable, order-independent string hash (FNV-1a) for deriving a default. */
function simpleHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Resolve the avatar slug to display for a worker: its explicit `avatar` when
 * set, otherwise a deterministic pick from the curated set keyed off its id.
 */
export function resolveAvatarSlug(id: string, avatar?: string): string {
  if (avatar && avatar.trim()) return avatar.trim();
  return AVATAR_SLUGS[simpleHash(id) % AVATAR_SLUGS.length];
}

/** Public path to an avatar's circular SVG (scales crisply at any size). */
export function avatarSrc(slug: string): string {
  return `/avatars/${slug}.svg`;
}

/** Public path to an avatar's 64px PNG, for small fixed-size bubble avatars. */
export function avatarPng64Src(slug: string): string {
  return `/avatars/64/${slug}.png`;
}

/**
 * Fetch the curated avatar set from /avatars/index.json once. Falls back to the
 * embedded slug list (no labels) if the fetch fails, so the picker still works.
 */
export function useAvatarList(): AvatarEntry[] {
  const [list, setList] = useState<AvatarEntry[]>([]);
  useEffect(() => {
    let alive = true;
    fetch("/avatars/index.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { avatars?: AvatarEntry[] }) => {
        if (alive && Array.isArray(data.avatars)) setList(data.avatars);
      })
      .catch(() => {
        if (alive) setList(AVATAR_SLUGS.map((slug) => ({ slug, label: slug })));
      });
    return () => {
      alive = false;
    };
  }, []);
  return list;
}
