import { useCallback, useEffect, useState } from "react";
import { en, type TranslationKey } from "../i18n/en.ts";
import { hu } from "../i18n/hu.ts";

const STORAGE_KEY = "myagens.panel.lang";
// Pre-rename key, so a browser's saved language preference survives the
// myhq->MyAgens rename.
const LEGACY_STORAGE_KEY = "myhq.panel.lang";

/** Available panel interface languages. */
export const INTERFACE_LANGUAGES: Record<string, string> = {
  en: "English",
  hu: "Magyar",
};

const TRANSLATIONS: Record<string, typeof en> = { en, hu };

function getStored(): string {
  const lang = localStorage.getItem(STORAGE_KEY);
  if (lang) return lang;
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacy) {
    localStorage.setItem(STORAGE_KEY, legacy);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return legacy;
  }
  return "en";
}

function load(code: string): typeof en {
  return TRANSLATIONS[code] ?? en;
}

/** Global singleton so all components share the same language state. */
let currentLang = getStored();
const listeners = new Set<() => void>();

function setGlobal(lang: string): void {
  if (!TRANSLATIONS[lang]) return;
  currentLang = lang;
  localStorage.setItem(STORAGE_KEY, lang);
  listeners.forEach((fn) => fn());
}

/**
 * Hook: returns `{ t, lang, setLang }`.
 * `t(key)` returns the translated string for the current language.
 * Re-renders automatically when the language changes (even across components).
 */
export function useI18n() {
  const [, tick] = useState(0);

  useEffect(() => {
    const notify = () => tick((n) => n + 1);
    listeners.add(notify);
    return () => { listeners.delete(notify); };
  }, []);

  const t = useCallback((key: TranslationKey): string => {
    return load(currentLang)[key] ?? en[key] ?? key;
  }, []);

  return { t, lang: currentLang, setLang: setGlobal };
}
