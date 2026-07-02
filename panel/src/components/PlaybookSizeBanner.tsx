// Warns the user when work.md is large enough to meaningfully bloat the system
// prompt. work.md is read and injected by the bot on every single turn, so
// keeping it lean directly reduces token cost and latency.
// (CLAUDE.md warnings are per-worker, shown on the Workers page instead.)

import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useI18n } from "../lib/useI18n.ts";

const WARN_BYTES = 6144; // mirrors PROMPT_FILE_SIZE_WARN_BYTES in playbook.ts
// Dismissed state survives the current tab session but resets on next open,
// so a persistent large file keeps nudging the user periodically.
const SESSION_KEY = "myagens_prompt_size_dismissed";

interface Props {
  onGotoPrompt: () => void;
}

export function PlaybookSizeBanner({ onGotoPrompt }: Props) {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(SESSION_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [workBytes, setWorkBytes] = useState(0);

  useEffect(() => {
    api
      .prompt()
      .then((p) => setWorkBytes(p.workBytes ?? 0))
      .catch(() => {
        /* non-critical — silently skip the banner if the fetch fails */
      });
  }, []);

  if (workBytes <= WARN_BYTES || dismissed) return null;

  const kb = Math.round(WARN_BYTES / 1024);
  const body = t("prompt_size_banner_body").replace("{kb}", String(kb));

  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      /* storage unavailable — in-memory dismiss still works */
    }
  };

  return (
    <div role="status" aria-live="polite" className="sticky top-0 z-20 bg-page">
      <div className="border-b border-warn/30 bg-warn-subtle px-4 py-2 text-sm text-warn-fg">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-1">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warn opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-warn" />
          </span>
          <span className="font-medium">{t("prompt_size_banner_title")}</span>
          <span className="text-fg-dim">{body}</span>
          <span className="ml-auto flex items-center gap-2">
            <button
              onClick={onGotoPrompt}
              className="rounded-md border border-current/30 px-2 py-0.5 text-xs font-medium hover:bg-current/10"
            >
              {t("prompt_size_banner_go")}
            </button>
            <button
              onClick={dismiss}
              className="rounded-md border border-current/30 px-2 py-0.5 text-xs font-medium hover:bg-current/10"
            >
              {t("prompt_size_banner_dismiss")}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
