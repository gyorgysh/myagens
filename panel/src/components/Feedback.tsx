import { useEffect, useState } from "react";
import { api, ApiError, AuthError } from "../api.ts";
import { Button, Callout, Card, InfoCard, Input, Label, TextArea } from "./ui.tsx";
import { toast } from "../lib/useToast.ts";
import { useI18n } from "../lib/useI18n.ts";
import type { TranslationKey } from "../i18n/en.ts";

type Kind = "bug" | "suggestion" | "other";

const KINDS: Array<{ id: Kind; label: TranslationKey; icon: string }> = [
  { id: "bug", label: "feedback_kind_bug", icon: "🐞" },
  { id: "suggestion", label: "feedback_kind_suggestion", icon: "💡" },
  { id: "other", label: "feedback_kind_other", icon: "💬" },
];

// Light client-side check; the server validates too. Kept loose on purpose.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function FeedbackView({
  onAuthError,
  onGoto,
}: {
  onAuthError: () => void;
  onGoto?: (tab: "updates") => void;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<Kind>("bug");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  // Soft nudge: if an update is available, the user's bug may already be fixed.
  const [behindBy, setBehindBy] = useState(0);

  // Non-blocking check on mount; failures are ignored (the form still works).
  useEffect(() => {
    api
      .updateStatus()
      .then((s) => {
        if (s.available) setBehindBy(s.behindBy);
      })
      .catch((e) => {
        if (e instanceof AuthError) onAuthError();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emailInvalid = email.trim().length > 0 && !EMAIL_RE.test(email.trim());

  const send = async () => {
    const text = message.trim();
    if (!text) return;
    const mail = email.trim();
    if (mail && !EMAIL_RE.test(mail)) {
      toast.error(t("feedback_email_invalid"));
      return;
    }
    setBusy(true);
    try {
      await api.sendFeedback(kind, text, mail || undefined);
      setMessage("");
      setEmail("");
      setSent(true);
      toast.success(t("feedback_sent"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      if (e instanceof ApiError && e.status === 429) {
        toast.error(t("feedback_rate_limited"));
        return;
      }
      toast.error(t("feedback_failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {behindBy > 0 && (
        <Callout title={t("feedback_update_nudge_title")}>
          <p>{t("feedback_update_nudge_body").replace("{n}", String(behindBy))}</p>
          {onGoto && (
            <button
              type="button"
              onClick={() => onGoto("updates")}
              className="mt-2 font-medium text-accent underline underline-offset-2 hover:opacity-80"
            >
              {t("feedback_update_nudge_action")}
            </button>
          )}
        </Callout>
      )}

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
          <span className="tabular text-xs text-fg-faint">{message.length}/5000</span>
        </div>

        {kind === "bug" && (
          <p className="mt-2 rounded-lg border border-line bg-surface-2 p-2.5 text-xs text-fg-dim">
            {t("feedback_bug_logs_hint")}
          </p>
        )}

        <div className="mt-4">
          <Label>{t("feedback_email")}</Label>
          <Input
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder={t("feedback_email_placeholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <p className={`mt-1 text-xs ${emailInvalid ? "text-rose-400" : "text-fg-faint"}`}>
            {emailInvalid ? t("feedback_email_invalid") : t("feedback_email_hint")}
          </p>
        </div>

        <p className="mt-3 text-xs text-fg-faint">{t("feedback_privacy")}</p>

        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" onClick={send} disabled={busy || !message.trim() || emailInvalid}>
            {busy ? t("feedback_sending") : t("feedback_send")}
          </Button>
          {sent && !busy && (
            <span className="text-sm text-ok-fg">{t("feedback_thanks")}</span>
          )}
        </div>
      </Card>
    </div>
  );
}
