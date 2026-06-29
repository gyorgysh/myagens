import { useEffect, useState } from "react";
import { api, AuthError, type Connector, type ConnectorScope, type SecretView } from "../api.ts";
import { Badge, Button, Card, Empty, Label, Select } from "./ui.tsx";
import { ConnectorsArt } from "./onboarding.tsx";
import { useI18n } from "../lib/useI18n.ts";
import { getConnectorIcon } from "../lib/connectorIcons.ts";
import type { Tab } from "./Sidebar.tsx";

export function ConnectorsView({ onAuthError, onGoto }: { onAuthError: () => void; onGoto?: (t: Tab) => void }) {
  const { t } = useI18n();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [secrets, setSecrets] = useState<SecretView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    Promise.all([api.connectors(), api.vault()])
      .then(([c, v]) => {
        setConnectors(c.connectors);
        setSecrets(v.secrets);
      })
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));

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

  const noneConfigured = connectors.length > 0 && !connectors.some((c) => c.secretId);
  const noSecrets = secrets.length === 0;

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
          {connectors.map((c) => {
            const live = c.status === "live";
            const icon = getConnectorIcon(c.id);
            return (
              <div key={c.id} className="rounded-lg border border-line p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {icon && (
                      <svg
                        role="img"
                        viewBox="0 0 24 24"
                        aria-label={icon.title}
                        className="h-5 w-5 shrink-0 text-fg-dim transition-colors"
                        style={{ color: undefined }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as SVGSVGElement).style.color = `#${icon.hex}`;
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as SVGSVGElement).style.color = "";
                        }}
                        fill="currentColor"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path d={icon.path} />
                      </svg>
                    )}
                    <span className="font-medium text-fg">{c.name}</span>
                  </div>
                  {live ? (
                    <Badge tone="green">{t("connectors_live")}</Badge>
                  ) : (
                    <Badge tone="amber">{t("connectors_coming_soon")}</Badge>
                  )}
                </div>
                <p className="mt-1 text-sm text-fg-dim">{c.description}</p>
                <p className="mt-2 text-xs text-fg-faint">
                  {t("connectors_needs").replace("{credential}", "")}
                  <span className="font-medium text-fg-dim">{c.credential}</span>
                </p>
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
                      disabled={!c.secretId}
                      onChange={(e) => setEnabled(c.id, e.target.checked)}
                    />
                    {t("connectors_enable")}
                  </label>
                )}
                {live && c.enabled && c.secretId && (
                  <p className="mt-1 text-xs text-accent">{t("connectors_active")}</p>
                )}
              </div>
            );
          })}
          </div>
        </>
      )}
    </Card>
  );
}
