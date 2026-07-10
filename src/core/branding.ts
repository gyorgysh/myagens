import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";
import { isResult, type SdkMessage } from "../claude/events.js";
import { log } from "../logger.js";

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
  /**
   * Custom CSS drop-in, injected as a `<style>` tag into the panel. Meant for
   * overriding the theme's CSS custom properties (`--accent`, `--surface`, …)
   * but any CSS works. "" = none.
   */
  customCss?: string;
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
  // The custom CSS is rendered via `style.textContent` in the owner's own
  // authenticated panel (never parsed as HTML), so a size cap is the only
  // guard needed here; the panel CSP still blocks external @import/url() loads.
  if (patch.customCss !== undefined) next.customCss = sanitizeText(patch.customCss, 50_000);
  saveJson<BrandingFile>(FILE, { version: 1, branding: next });
  audit("branding.update", {});
  return next;
}

/** Wipe every branding override back to the env/theme defaults. */
export function resetBranding(): Branding {
  saveJson<BrandingFile>(FILE, { version: 1, branding: {} });
  audit("branding.reset", {});
  return {};
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
    customCss: draft.customCss || undefined,
  };
}

/**
 * The panel's theme contract: every colour is a CSS custom property set on
 * `:root` (light) and `[data-theme="dark"]` (dark) in panel/src/index.css.
 * Handed to the model so generated CSS targets real variables. Keep in sync
 * with index.css when adding tokens.
 */
const THEME_VARS = `--page (app background), --surface (cards), --surface-2 (nested panels), --line (borders), --input (form fields background), --fg (main text), --fg-muted, --fg-dim, --fg-faint (progressively fainter text), --accent (brand/interactive colour), --accent-fg (text ON the accent colour), --signal (live-activity indicator, brighter accent step), --ok / --ok-fg / --ok-subtle (success), --warn / --warn-fg / --warn-subtle (warning), --critical / --critical-fg / --critical-subtle (error)`;

/**
 * Generate a theme-CSS drop-in from a plain-language description via a one-shot
 * Haiku call on the bot's existing Claude connection (same pattern as memory
 * maintenance). Returns null when the model is unreachable or replies unusably;
 * the result is a *draft* for the user to review and save, never auto-applied.
 */
export async function generateThemeCss(description: string): Promise<string | null> {
  const prompt =
    `Design a colour theme for a web management panel based on this description:\n"${description}"\n\n` +
    `The panel is themed entirely through CSS custom properties. Output CSS that overrides them: ` +
    `one \`:root { … }\` block (light mode) and one \`[data-theme="dark"] { … }\` block (dark mode).\n` +
    `Available variables (set the ones the description calls for, at minimum the accent + surface + text families):\n${THEME_VARS}\n\n` +
    `Rules:\n` +
    `- Only those two selectors; only the listed variables; plain CSS colours as values.\n` +
    `- Keep text readable: --fg on --surface and --accent-fg on --accent must hold ~4.5:1 contrast in both blocks.\n` +
    `- No @import, no url(), no fonts, no other properties or selectors.\n` +
    `- Start each block with a short /* comment */ naming the theme.\n` +
    `Reply with ONLY the CSS.`;
  try {
    const response = query({
      prompt,
      options: {
        model: "claude-haiku-4-5-20251001",
        systemPrompt: "You are a careful UI theme designer. Reply with ONLY CSS, no prose.",
        maxTurns: 1,
        permissionMode: "bypassPermissions",
      },
    }) as unknown as AsyncIterable<SdkMessage>;
    let out: string | null = null;
    for await (const msg of response) {
      if (isResult(msg) && msg.result) out = msg.result;
    }
    if (!out) return null;
    // Unwrap a ```css fence if the model added one despite the instruction.
    const fenced = /```(?:css)?\s*([\s\S]*?)```/.exec(out);
    const css = (fenced ? fenced[1] : out).trim();
    // The reply must look like the contract we asked for — otherwise treat it
    // as a refusal/hallucination rather than saving garbage into the draft.
    if (!css.includes(":root") || !css.includes("{") || /@import|url\s*\(/i.test(css)) return null;
    return css.slice(0, 50_000);
  } catch (err) {
    log.warn("Theme CSS generation failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
