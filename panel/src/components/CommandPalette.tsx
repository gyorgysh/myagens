import { useEffect, useRef, useState } from "react";
import { Settings, Search, CornerDownLeft, type LucideIcon } from "lucide-react";
import { useI18n } from "../lib/useI18n.ts";
import { NAV, type Tab } from "./Sidebar.tsx";
import type { TranslationKey } from "../i18n/en.ts";

type PaletteItem = {
  id: Tab | "settings";
  label: string;
  group: string;
  hint: string;
  icon: LucideIcon;
};

function scoreMatch(item: PaletteItem, query: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const label = item.label.toLowerCase();
  const hint = item.hint.toLowerCase();
  const group = item.group.toLowerCase();

  // Exact prefix match on label gets the highest score
  if (label.startsWith(q)) return 3;
  // Substring in label
  if (label.includes(q)) return 2;
  // Word prefix — any word in label starts with query
  if (label.split(/\s+/).some((w) => w.startsWith(q))) return 1.8;
  // Substring in hint or group
  if (hint.includes(q) || group.includes(q)) return 1;
  // Fuzzy: every character of query appears in order in label
  let ci = 0;
  for (let i = 0; i < label.length && ci < q.length; i++) {
    if (label[i] === q[ci]) ci++;
  }
  if (ci === q.length) return 0.5;
  // Same fuzzy pass on hint
  ci = 0;
  for (let i = 0; i < hint.length && ci < q.length; i++) {
    if (hint[i] === q[ci]) ci++;
  }
  if (ci === q.length) return 0.3;
  return 0;
}

export function CommandPalette({
  open,
  onClose,
  onSelect,
  chatEnabled = true,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (tab: Tab | "settings") => void;
  chatEnabled?: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Build the flat item list from NAV + settings, translated at render time
  const allItems: PaletteItem[] = [
    ...NAV.flatMap((g) =>
      g.items
        .filter((i) => i.id !== "chat" || chatEnabled)
        .map((i) => ({
          id: i.id,
          label: t(i.labelKey as TranslationKey),
          group: t(g.headingKey as TranslationKey),
          hint: i.hintKey ? t(i.hintKey as TranslationKey) : "",
          icon: i.icon,
        })),
    ),
    {
      id: "settings" as const,
      label: t("nav_settings"),
      group: "",
      hint: t("nav_settings_hint"),
      icon: Settings,
    },
  ];

  const filtered = query
    ? allItems
        .map((item) => ({ item, score: scoreMatch(item, query) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .map(({ item }) => item)
    : allItems;

  // Reset active index when query or open state changes
  useEffect(() => {
    setActive(0);
  }, [query, open]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const chosen = filtered[active];
        if (chosen) {
          onSelect(chosen.id);
          onClose();
        }
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, active, onClose, onSelect]);

  // Scroll active item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      role="dialog"
      aria-modal="true"
      aria-label={t("cmd_open")}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Palette card */}
      <div className="relative mx-4 w-full max-w-lg rounded-xl border border-line bg-surface shadow-2xl">
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-fg-dim" aria-hidden="true" strokeWidth={1.75} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("cmd_placeholder")}
            className="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-faint"
            aria-label={t("cmd_placeholder")}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <kbd className="mono-xs hidden rounded border border-line px-1.5 py-0.5 text-fg-faint sm:inline">
            esc
          </kbd>
        </div>

        {/* Results */}
        <ul
          ref={listRef}
          role="listbox"
          className="max-h-80 overflow-y-auto py-2"
        >
          {filtered.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-fg-dim">
              {t("cmd_no_results")}
            </li>
          )}
          {filtered.map((item, idx) => {
            const isActive = idx === active;
            const Icon = item.icon;
            return (
              <li
                key={item.id}
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  onSelect(item.id);
                  onClose();
                }}
                onMouseEnter={() => setActive(idx)}
                className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors ${
                  isActive ? "bg-accent/10 text-fg" : "text-fg-muted hover:bg-surface-2"
                }`}
              >
                <Icon
                  className={`h-[18px] w-[18px] shrink-0 ${isActive ? "text-accent" : "text-fg-dim"}`}
                  strokeWidth={isActive ? 2.25 : 1.75}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">{item.label}</span>
                    {item.group && (
                      <span className="text-xs uppercase tracking-wider text-fg-faint">
                        {item.group}
                      </span>
                    )}
                  </div>
                  {item.hint && (
                    <div className="mt-0.5 truncate text-xs text-fg-dim">
                      {item.hint}
                    </div>
                  )}
                </div>
                {isActive && (
                  <kbd className="mono-xs flex shrink-0 items-center rounded border border-line px-1.5 py-1 text-fg-faint">
                    <CornerDownLeft className="h-3 w-3" strokeWidth={1.75} />
                  </kbd>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
