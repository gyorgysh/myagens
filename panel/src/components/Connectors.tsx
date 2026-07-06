import { useEffect, useState } from "react";
import { HelpCircle, X } from "lucide-react";
import {
  api,
  AuthError,
  type Connector,
  type ConnectorCategory,
  type ConnectorScope,
  type SecretView,
} from "../api.ts";
import { Badge, Button, Card, Empty, Label, Modal, Select } from "./ui.tsx";
import { ConnectorsArt } from "./onboarding.tsx";
import { useI18n } from "../lib/useI18n.ts";
import type { TranslationKey } from "../i18n/en.ts";
import { errorMessage } from "../lib/errorMessage.ts";
import { getConnectorIcon, getConnectorFallbackIcon } from "../lib/connectorIcons.ts";
import { CONNECTOR_HELP, connectorHelpKeys } from "../lib/connectorHelp.ts";
import type { Tab } from "./Sidebar.tsx";

/** Epoch-ms → `YYYY-MM-DDTHH:mm` for a `datetime-local` input (local tz). */
function toLocalInput(ms: number | undefined): string {
  if (ms === undefined) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Info modal ─────────────────────────────────────────────────────────────

function ConnectorInfoModal({
  connector,
  onClose,
}: {
  connector: Connector;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const shape = CONNECTOR_HELP[connector.id];
  const keys = shape ? connectorHelpKeys(connector.id, shape) : null;
  const tk = (key: string) => t(key as TranslationKey);
  const icon = getConnectorIcon(connector.id);
  const fallbackIcon = !icon ? getConnectorFallbackIcon(connector.id) : undefined;

  return (
    <Modal onClose={onClose} size="md" labelledBy="conn-info-title" closeButton={false}>
      <div className="flex flex-col gap-0">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-line p-4">
          <div className="flex items-center gap-2.5">
            {icon && (
              <svg
                role="img"
                viewBox="0 0 24 24"
                aria-label={icon.title}
                className={`h-6 w-6 shrink-0${icon.monochrome ? " text-fg" : ""}`}
                style={icon.monochrome ? undefined : { color: `#${icon.hex}` }}
                fill="currentColor"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d={icon.path} />
              </svg>
            )}
            {fallbackIcon && (
              <fallbackIcon.Icon
                className="h-6 w-6 shrink-0"
                style={{ color: `#${fallbackIcon.hex}` }}
                strokeWidth={1.75}
                aria-hidden="true"
              />
            )}
            <h2 id="conn-info-title" className="text-base font-semibold text-fg">
              {connector.name}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label={t("close")}
            className="-m-1 shrink-0 rounded p-2 text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg-muted"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[70vh] overflow-y-auto">
          {keys ? (
            <div className="space-y-4 p-4">
              {/* What it does */}
              <section>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-fg-dim">
                  {t("connectors_info_summary_label")}
                </p>
                <p className="text-sm text-fg">{tk(keys.summary)}</p>
              </section>

              {/* Credential needed */}
              <section className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2.5">
                <p className="mb-0.5 text-xs font-semibold uppercase tracking-wider text-accent">
                  {t("connectors_info_credential_label")}
                </p>
                <p className="text-sm text-fg">{tk(keys.credential)}</p>
              </section>

              {/* Setup steps */}
              <section>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-dim">
                  {t("connectors_info_steps_label")}
                </p>
                <ol className="space-y-2">
                  {keys.steps.map((stepKey, i) => (
                    <li key={stepKey} className="flex gap-3 text-sm text-fg-dim">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent">
                        {i + 1}
                      </span>
                      <span>{tk(stepKey)}</span>
                    </li>
                  ))}
                </ol>
              </section>

              {/* Tools unlocked */}
              <section>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-dim">
                  {t("connectors_info_tools_label")}
                </p>
                <div className="space-y-2">
                  <div>
                    <p className="mb-1 text-xs font-medium text-fg-dim">
                      {t("connectors_info_read_tools")}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {keys.readTools.map((toolKey) => (
                        <span
                          key={toolKey}
                          className="inline-flex rounded-md bg-ok-subtle px-2 py-0.5 text-xs font-medium text-ok-fg"
                        >
                          {tk(toolKey)}
                        </span>
                      ))}
                    </div>
                  </div>
                  {keys.writeTools.length > 0 && (
                    <div>
                      <p className="mb-1 text-xs font-medium text-fg-dim">
                        {t("connectors_info_write_tools")}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {keys.writeTools.map((toolKey) => (
                          <span
                            key={toolKey}
                            className="inline-flex rounded-md bg-warn-subtle px-2 py-0.5 text-xs font-medium text-warn-fg"
                          >
                            {tk(toolKey)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* Tip */}
              {keys.tip && (
                <section className="rounded-lg border border-line bg-surface-2/50 px-3 py-2.5">
                  <p className="mb-0.5 text-xs font-semibold uppercase tracking-wider text-fg-dim">
                    {t("connectors_info_tip_label")}
                  </p>
                  <p className="text-sm text-fg-dim">{tk(keys.tip)}</p>
                </section>
              )}
            </div>
          ) : (
            <p className="p-4 text-sm text-fg-dim">{connector.description}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-line p-3">
          <Button variant="primary" onClick={onClose}>
            {t("connectors_info_close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Main view ──────────────────────────────────────────────────────────────

type CategoryFilter = "all" | ConnectorCategory;

const CATEGORY_TABS: { id: CategoryFilter; labelKey: TranslationKey }[] = [
  { id: "all", labelKey: "connectors_category_all" },
  { id: "productivity", labelKey: "connectors_category_productivity" },
  { id: "dev", labelKey: "connectors_category_dev" },
  { id: "database", labelKey: "connectors_category_database" },
  { id: "image", labelKey: "connectors_category_image" },
  { id: "social", labelKey: "connectors_category_social" },
];

// ─── Multi-account credentials (social connectors) ─────────────────────────

function SocialAccounts({
  connector,
  secrets,
  noSecrets,
  onUpdated,
  onError,
}: {
  connector: Connector;
  secrets: SecretView[];
  noSecrets: boolean;
  onUpdated: (c: Connector) => void;
  onError: (msg: string) => void;
}) {
  const { t } = useI18n();
  const [label, setLabel] = useState("");
  const [secretId, setSecretId] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (p: Promise<Connector>) => {
    setBusy(true);
    try {
      onUpdated(await p);
    } catch (e) {
      onError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2">
      <Label>{t("connectors_accounts")}</Label>
      <div className="mt-1 space-y-1.5">
        {connector.accounts.map((a) => (
          <div key={a.id} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate text-sm font-medium text-fg" title={a.label}>
              {a.label}
            </span>
            <Select
              value={a.secretId}
              onChange={(e) =>
                void run(api.updateConnectorAccount(connector.id, a.id, { secretId: e.target.value }))
              }
            >
              {secrets.map((s) => (
                <option key={s.id} value={`vault:${s.id}`}>
                  {s.name}
                </option>
              ))}
            </Select>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(api.deleteConnectorAccount(connector.id, a.id))}
              aria-label={t("connectors_account_remove")}
              className="shrink-0 rounded p-1.5 text-fg-faint transition-colors hover:bg-surface-2 hover:text-critical-fg"
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("connectors_account_label_ph")}
            className="w-28 shrink-0 rounded border border-line bg-surface px-2 py-2 text-sm text-fg placeholder:text-fg-faint"
          />
          <Select value={secretId} onChange={(e) => setSecretId(e.target.value)}>
            <option value="">{t("none")}</option>
            {secrets.map((s) => (
              <option key={s.id} value={`vault:${s.id}`}>
                {s.name}
              </option>
            ))}
          </Select>
          <Button
            variant="ghost"
            className="shrink-0"
            disabled={busy || !label.trim() || !secretId}
            onClick={() => {
              void run(api.addConnectorAccount(connector.id, { label: label.trim(), secretId }));
              setLabel("");
              setSecretId("");
            }}
          >
            {t("connectors_account_add")}
          </Button>
        </div>
      </div>
      {noSecrets && <p className="mt-1 text-xs text-fg-faint">{t("connectors_no_secret")}</p>}
      <p className="mt-1 text-xs text-fg-faint">{t("connectors_accounts_hint")}</p>
    </div>
  );
}

export function ConnectorsView({ onAuthError, onGoto }: { onAuthError: () => void; onGoto?: (t: Tab) => void }) {
  const { t } = useI18n();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [secrets, setSecrets] = useState<SecretView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [infoConnector, setInfoConnector] = useState<Connector | null>(null);
  const [category, setCategory] = useState<CategoryFilter>("all");

  const load = () =>
    Promise.all([api.connectors(), api.vault()])
      .then(([c, v]) => {
        setConnectors(c.connectors);
        setSecrets(v.secrets);
      })
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(errorMessage(e, t))));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setSecret = async (id: string, secretId: string) => {
    setConnectors((cs) => cs.map((c) => (c.id === id ? { ...c, secretId } : c)));
    await api.saveConnector(id, { secretId }).catch(() => void load());
  };

  const setEnabled = async (id: string, enabled: boolean) => {
    setConnectors((cs) => cs.map((c) => (c.id === id ? { ...c, enabled } : c)));
    await api.saveConnector(id, { enabled }).catch(() => void load());
  };

  const setScope = async (id: string, scope: ConnectorScope) => {
    setConnectors((cs) => cs.map((c) => (c.id === id ? { ...c, scope } : c)));
    await api.saveConnector(id, { scope }).catch(() => void load());
  };

  // Set (or clear, via null) the token expiry; server re-derives tokenStatus.
  const setExpiry = async (id: string, expiresAt: number | null) => {
    await api.saveConnector(id, { expiresAt }).catch(() => {});
    void load();
  };

  const replaceConnector = (updated: Connector) =>
    setConnectors((cs) => cs.map((c) => (c.id === updated.id ? updated : c)));

  const noneConfigured =
    connectors.length > 0 && !connectors.some((c) => c.secretId || c.accounts.length > 0);
  const noSecrets = secrets.length === 0;
  const filteredConnectors =
    category === "all" ? connectors : connectors.filter((c) => c.category === category);

  return (
    <Card title={t("connectors_title")}>
      <p className="mb-3 text-sm text-fg-dim">{t("connectors_desc")}</p>
      {error && <p className="mb-2 text-sm text-critical-fg">{error}</p>}
      {connectors.length === 0 ? (
        <Empty icon={<ConnectorsArt />} title={t("connectors_empty_title")}>
          {t("connectors_empty_desc")}
        </Empty>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-1 rounded-lg border border-line bg-surface p-1">
            {CATEGORY_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setCategory(tab.id)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  category === tab.id ? "bg-accent text-accent-fg" : "text-fg-muted hover:bg-surface-2"
                }`}
              >
                {t(tab.labelKey)}
              </button>
            ))}
          </div>
          {noneConfigured && (
            <div className="mb-3 flex flex-col gap-2 rounded-lg border border-accent/30 bg-accent/5 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-fg">{t("connectors_none_configured")}</p>
                <p className="mt-0.5 text-xs text-fg-dim">{t("connectors_none_configured_desc")}</p>
              </div>
              {onGoto && (
                <Button variant="primary" className="shrink-0" onClick={() => onGoto("vault")}>
                  {t("connectors_add_credential")}
                </Button>
              )}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
          {filteredConnectors.map((c) => {
            const live = c.status === "live";
            const icon = getConnectorIcon(c.id);
            const fallbackIcon = !icon ? getConnectorFallbackIcon(c.id) : undefined;
            const shape = CONNECTOR_HELP[c.id];
            const helpKeys = shape ? connectorHelpKeys(c.id, shape) : null;
            const description = helpKeys ? t(helpKeys.summary as TranslationKey) : c.description;
            const credential = helpKeys ? t(helpKeys.credential as TranslationKey) : c.credential;
            return (
              <div key={c.id} className="rounded-lg border border-line p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {icon && (
                      <svg
                        role="img"
                        viewBox="0 0 24 24"
                        aria-label={icon.title}
                        className={`h-5 w-5 shrink-0 transition-colors ${
                          icon.monochrome ? "text-fg-dim hover:text-fg" : "text-fg-dim"
                        }`}
                        onMouseEnter={
                          icon.monochrome
                            ? undefined
                            : (e) => {
                                (e.currentTarget as SVGSVGElement).style.color = `#${icon.hex}`;
                              }
                        }
                        onMouseLeave={
                          icon.monochrome
                            ? undefined
                            : (e) => {
                                (e.currentTarget as SVGSVGElement).style.color = "";
                              }
                        }
                        fill="currentColor"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path d={icon.path} />
                      </svg>
                    )}
                    {fallbackIcon && (
                      <fallbackIcon.Icon
                        className="h-5 w-5 shrink-0"
                        style={{ color: `#${fallbackIcon.hex}` }}
                        strokeWidth={1.75}
                        aria-hidden="true"
                      />
                    )}
                    <span className="font-medium text-fg">{c.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {live ? (
                      <Badge tone="green">{t("connectors_live")}</Badge>
                    ) : (
                      <Badge tone="amber">{t("connectors_coming_soon")}</Badge>
                    )}
                    {c.tokenStatus === "expired" && (
                      <Badge tone="critical">{t("connectors_token_expired")}</Badge>
                    )}
                    {c.tokenStatus === "expiring" && (
                      <Badge tone="amber">{t("connectors_token_expiring")}</Badge>
                    )}
                    <button
                      type="button"
                      onClick={() => setInfoConnector(c)}
                      aria-label={t("connectors_info_open")}
                      className="-m-1.5 rounded p-2 text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg-muted"
                    >
                      <HelpCircle className="h-4 w-4" strokeWidth={1.75} />
                    </button>
                  </div>
                </div>
                <p className="mt-1 text-sm text-fg-dim">{description}</p>
                <p className="mt-2 text-xs text-fg-faint">
                  {t("connectors_needs").replace("{credential}", "")}
                  <span className="font-medium text-fg-dim">{credential}</span>
                </p>
                {c.multiAccount ? (
                  <SocialAccounts
                    connector={c}
                    secrets={secrets}
                    noSecrets={noSecrets}
                    onUpdated={replaceConnector}
                    onError={setError}
                  />
                ) : (
                  <div className="mt-2">
                    <Label>{t("connectors_credential")}</Label>
                    <Select value={c.secretId ?? ""} onChange={(e) => setSecret(c.id, e.target.value)}>
                      <option value="">{t("none")}</option>
                      {secrets.map((s) => (
                        <option key={s.id} value={`vault:${s.id}`}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                    {noSecrets && <p className="mt-1 text-xs text-fg-faint">{t("connectors_no_secret")}</p>}
                  </div>
                )}
                {live && c.hasWrite && (
                  <div className="mt-2">
                    <Label>{t("connectors_access")}</Label>
                    <div className="mt-1 inline-flex rounded border border-line p-0.5">
                      {(["read", "write"] as ConnectorScope[]).map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setScope(c.id, s)}
                          className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                            c.scope === s
                              ? "bg-accent/15 text-accent"
                              : "text-fg-dim hover:text-fg"
                          }`}
                        >
                          {s === "read" ? t("connectors_access_read") : t("connectors_access_write")}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-fg-faint">
                      {c.scope === "write" ? t("connectors_access_write_hint") : t("connectors_access_read_hint")}
                    </p>
                  </div>
                )}
                {live && (
                  <label className="mt-2 flex items-center gap-2 text-sm text-fg-dim">
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      disabled={c.multiAccount ? c.accounts.length === 0 : !c.secretId}
                      onChange={(e) => setEnabled(c.id, e.target.checked)}
                    />
                    {t("connectors_enable")}
                  </label>
                )}
                {live && c.enabled && (c.multiAccount ? c.accounts.length > 0 : !!c.secretId) && (
                  <p className="mt-1 text-xs text-accent">{t("connectors_active")}</p>
                )}
                {live && c.secretId && (
                  <div className="mt-2">
                    <Label>{t("connectors_expiry")}</Label>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        type="datetime-local"
                        value={toLocalInput(c.expiresAt)}
                        onChange={(e) => {
                          const ms = e.target.value ? new Date(e.target.value).getTime() : null;
                          void setExpiry(c.id, Number.isFinite(ms as number) ? ms : null);
                        }}
                        className="rounded border border-line bg-surface px-2 py-1 text-xs text-fg"
                      />
                      {c.expiresAt !== undefined && (
                        <button
                          type="button"
                          onClick={() => void setExpiry(c.id, null)}
                          className="text-xs text-fg-faint underline hover:text-fg-dim"
                        >
                          {t("connectors_expiry_clear")}
                        </button>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-fg-faint">
                      {c.tokenStatus === "expired"
                        ? t("connectors_expiry_expired_hint")
                        : c.tokenStatus === "expiring"
                          ? t("connectors_expiry_expiring_hint")
                          : t("connectors_expiry_hint")}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
          </div>
        </>
      )}

      {infoConnector && (
        <ConnectorInfoModal
          connector={infoConnector}
          onClose={() => setInfoConnector(null)}
        />
      )}
    </Card>
  );
}
