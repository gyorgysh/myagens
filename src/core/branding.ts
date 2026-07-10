import { config } from "../config.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";

const FILE = "branding.json";

/**
 * White-label branding overrides for the panel + product chrome. Free to use:
 * whatever is saved here is applied (folded into `/api/me`, so the panel
 * renders it), with the env-default names (`ATLAS_NAME`/`BRAND_NAME`) as the
 * fallback for anything left blank.
 */
export interface Branding {
  /** Product name (login/setup header, page title prefix). "" = BRAND_NAME env. */
  brandName?: string;
  /** Main agent display name. "" = ATLAS_NAME env. */
  agentName?: string;
  /** Browser tab / panel title. "" = falls back to brandName. */
  panelTitle?: string;
  /** Sidebar logo: a data: URL or absolute https URL to a small image. */
  logoUrl?: string;
  /** Favicon: a data: URL or absolute https URL. */
  faviconUrl?: string;
  /** Footer line appended to outbound emails / notifications. */
  emailFooter?: string;
  /** Accent colour override (CSS colour, e.g. #6d28d9). "" = theme default. */
  accentColor?: string;
}

interface BrandingFile {
  version: 1;
  branding: Branding;
}

const EMPTY: Branding = {};

function load(): Branding {
  const f = loadJson<BrandingFile>(FILE, { version: 1, branding: EMPTY });
  return f.branding ?? EMPTY;
}

/** The saved branding overrides. */
export function getBranding(): Branding {
  return load();
}

const HEX = /^#[0-9a-fA-F]{3,8}$/;
/** Only http(s) and inline data: image URLs are allowed (no javascript: etc.). */
const SAFE_URL = /^(https:\/\/|data:image\/)/i;

function sanitizeUrl(v: string | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s) return "";
  return SAFE_URL.test(s) ? s.slice(0, 256_000) : undefined;
}

function sanitizeText(v: string | undefined, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.trim().slice(0, max);
}

/** Persist a branding draft. Unknown/invalid fields are dropped, not rejected. */
export function setBranding(patch: Partial<Branding>): Branding {
  const cur = load();
  const next: Branding = { ...cur };
  if (patch.brandName !== undefined) next.brandName = sanitizeText(patch.brandName, 60);
  if (patch.agentName !== undefined) next.agentName = sanitizeText(patch.agentName, 60);
  if (patch.panelTitle !== undefined) next.panelTitle = sanitizeText(patch.panelTitle, 60);
  if (patch.emailFooter !== undefined) next.emailFooter = sanitizeText(patch.emailFooter, 280);
  if (patch.logoUrl !== undefined) {
    const u = sanitizeUrl(patch.logoUrl);
    if (u !== undefined) next.logoUrl = u;
  }
  if (patch.faviconUrl !== undefined) {
    const u = sanitizeUrl(patch.faviconUrl);
    if (u !== undefined) next.faviconUrl = u;
  }
  if (patch.accentColor !== undefined) {
    const c = (patch.accentColor ?? "").trim();
    next.accentColor = c === "" || HEX.test(c) ? c : cur.accentColor;
  }
  saveJson<BrandingFile>(FILE, { version: 1, branding: next });
  audit("branding.update", {});
  return next;
}

/**
 * The branding the panel should actually render: the saved overrides, with the
 * env-default names filling anything left blank.
 */
export function effectiveBranding(): Required<Pick<Branding, "brandName" | "agentName">> & Branding {
  const draft = load();
  return {
    brandName: draft.brandName || config.BRAND_NAME,
    agentName: draft.agentName || config.ATLAS_NAME,
    panelTitle: draft.panelTitle || undefined,
    logoUrl: draft.logoUrl || undefined,
    faviconUrl: draft.faviconUrl || undefined,
    emailFooter: draft.emailFooter || undefined,
    accentColor: draft.accentColor || undefined,
  };
}
