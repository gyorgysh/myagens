import { useState } from "react";
import { api, AuthError } from "../api.ts";
import { Button, Card, InfoCard, Label, TextArea } from "./ui.tsx";
import { toast } from "../lib/useToast.ts";
import { useI18n } from "../lib/useI18n.ts";
import type { TranslationKey } from "../i18n/en.ts";

type Kind = "bug" | "suggestion" | "other";

const KINDS: Array<{ id: Kind; label: TranslationKey; icon: string }> = [
  { id: "bug", label: "feedback_kind_bug", icon: "🐞" },
  { id: "suggestion", label: "feedback_kind_suggestion", icon: "💡" },
  { id: "other", label: "feedback_kind_other", icon: "💬" },
];

export function FeedbackView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<Kind>("bug");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const send = async () => {
    const text = message.trim();
    if (!text) return;
    setBusy(true);
    try {
      await api.sendFeedback(kind, text);
      setMessage("");
      setSent(true);
      toast.success(t("feedback_sent"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(t("feedback_failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <InfoCard
        id="feedback"
        title={t("feedback_info_title")}
        body={t("feedback_info_body")}
      />

      <Card title={t("feedback_title")}>
        <p className="mb-4 text-sm text-fg-dim">{t("feedback_desc")}</p>

        <Label>{t("feedback_kind")}</Label>
        <div className="mb-4 grid gap-2 sm:grid-cols-3">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => setKind(k.id)}
              aria-pressed={kind === k.id}
              className={`flex items-center gap-2 rounded-lg border p-2.5 text-left text-sm transition-colors ${
                kind === k.id
                  ? "border-accent bg-accent/10 text-fg"
                  : "border-line text-fg-dim hover:bg-surface-2"
              }`}
            >
              <span className="text-base leading-none">{k.icon}</span>
              <span className="font-medium">{t(k.label)}</span>
            </button>
          ))}
        </div>

        <Label>{t("feedback_message")}</Label>
        <TextArea
          rows={6}
          maxLength={5000}
          placeholder={t("feedback_message_placeholder")}
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            if (sent) setSent(false);
          }}
        />
        <div className="mt-1 flex items-center justify-between">
          <p className="text-xs text-fg-faint">{t("feedback_privacy")}</p>
          <span className="tabular text-xs text-fg-faint">{message.length}/5000</span>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" onClick={send} disabled={busy || !message.trim()}>
            {busy ? t("feedback_sending") : t("feedback_send")}
          </Button>
          {sent && !busy && (
            <span className="text-sm text-emerald-400">{t("feedback_thanks")}</span>
          )}
        </div>
      </Card>
    </div>
  );
}
