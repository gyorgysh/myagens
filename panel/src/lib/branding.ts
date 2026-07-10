import type { Branding } from "../api.ts";

// The stock favicon href, captured the first time branding is applied so a
// later reset can restore it without a reload.
let defaultFavicon: string | null | undefined;

/**
 * Apply white-label branding to the document chrome (title, favicon, accent,
 * custom CSS). `branding` is the *effective* branding from `/api/me` or
 * `/api/branding`: saved overrides with env-default names as fallback. Cleared
 * fields fall back to the stock look, so this also undoes a previous apply
 * (e.g. after "Reset to defaults").
 */
export function applyBranding(branding: Branding | undefined, brandName: string): void {
  const title = branding?.panelTitle || brandName;
  if (title) document.title = title;

  let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
  if (defaultFavicon === undefined) defaultFavicon = link?.getAttribute("href") ?? null;
  if (branding?.faviconUrl) {
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = branding.faviconUrl;
  } else if (link && defaultFavicon) {
    link.href = defaultFavicon;
  }

  // Override the raw `--accent` token, not the Tailwind `--color-accent` alias:
  // the alias only feeds utility classes, while gradients and the logo cube read
  // `var(--accent)` directly — setting the raw token restyles both.
  if (branding?.accentColor) {
    document.documentElement.style.setProperty("--accent", branding.accentColor);
  } else {
    document.documentElement.style.removeProperty("--accent");
  }

  // Custom CSS drop-in. textContent (never innerHTML), so the sheet is applied
  // verbatim without any HTML parsing.
  let style = document.getElementById("whitelabel-css") as HTMLStyleElement | null;
  if (branding?.customCss) {
    if (!style) {
      style = document.createElement("style");
      style.id = "whitelabel-css";
      document.head.appendChild(style);
    }
    style.textContent = branding.customCss;
  } else {
    style?.remove();
  }
}
