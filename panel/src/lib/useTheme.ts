import { useCallback, useState } from "react";

type Theme = "light" | "dark";
const KEY = "cct.panel.theme";

function current(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Read/toggle the light/dark theme; the `.dark` class on <html> is the source
 *  of truth (set pre-paint by an inline script), persisted to localStorage. */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(current);

  const toggle = useCallback(() => {
    const next: Theme = current() === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* storage unavailable — theme still applies for the session */
    }
    setTheme(next);
  }, []);

  return { theme, toggle };
}
