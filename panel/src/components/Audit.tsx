import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  AuthError,
  type AuditEvent,
  type AuditFacets,
  type Anomaly,
} from "../api.ts";
import { Empty, Select } from "./ui.tsx";
import { useI18n } from "../lib/useI18n.ts";
import { errorMessage } from "../lib/errorMessage.ts";
import { ShieldAlert, ScrollText } from "lucide-react";

type TFn = (key: import("../i18n/en.ts").TranslationKey) => string;
type Tab = "log" | "anomalies";

/** Trigger a client-side download of `text` as a file (no server round-trip). */
function downloadText(text: string, filename: string, type = "text/plain"): void {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/:/g, "-");
}

/** The resource (segment before the first dot) of an action verb. */
function resourceOf(action: string): string {
  const dot = action.indexOf(".");
  return dot === -1 ? action : action.slice(0, dot);
}

export function AuditView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("log");

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [facets, setFacets] = useState<AuditFacets>({ actors: [], resources: [], actions: [] });
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [actor, setActor] = useState("");
  const [resource, setResource] = useState("");
  const [action, setAction] = useState("");

  const searchTimer = useRef<ReturnType<typeof setTimeout>>();

  // Load the facet lists once (actors / resources / actions for the dropdowns).
  useEffect(() => {
    api
      .auditFacets()
      .then(setFacets)
      .catch((e) => (e instanceof AuthError ? onAuthError() : undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load anomalies once when that tab is first opened.
  useEffect(() => {
    if (tab !== "anomalies" || anomalies.length > 0) return;
    api
      .auditAnomalies()
      .then((r) => setAnomalies(r.anomalies))
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(errorMessage(e, t))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const runSearch = useCallback(() => {
    api
      .searchAudit({
        q: search.trim() || undefined,
        actor: actor || undefined,
        resource: resource || undefined,
        action: action || undefined,
        limit: 1000,
      })
      .then((r) => setEvents(r.events))
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(errorMessage(e, t))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, actor, resource, action, onAuthError]);

  // Debounced re-query whenever any filter changes.
  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(runSearch, 250);
    return () => clearTimeout(searchTimer.current);
  }, [runSearch]);

  const clearFilters = () => {
    setSearch("");
    setActor("");
    setResource("");
    setAction("");
  };

  const hasFilters = Boolean(search || actor || resource || action);

  if (error) return <Empty>{error}</Empty>;

  return (
    <div className="flex h-[calc(100dvh-var(--nav-h-mobile))] flex-col gap-3 pb-safe md:h-[calc(100dvh-var(--nav-h-desktop))] md:pb-0">
      {/* Tabs */}
      <div className="flex items-center gap-1 self-start rounded-lg border border-line bg-surface p-1">
        <TabButton active={tab === "log"} onClick={() => setTab("log")}>
          {t("audit_tab_log")}
        </TabButton>
        <TabButton active={tab === "anomalies"} onClick={() => setTab("anomalies")}>
          <span className="flex items-center gap-1.5">
            {t("audit_tab_anomalies")}
            {anomalies.length > 0 && (
              <span className="rounded-full bg-critical/15 px-1.5 text-xs font-semibold text-critical-fg">
                {anomalies.length}
              </span>
            )}
          </span>
        </TabButton>
      </div>

      {tab === "log" ? (
        <LogTab
          events={events}
          facets={facets}
          search={search}
          setSearch={setSearch}
          actor={actor}
          setActor={setActor}
          resource={resource}
          setResource={setResource}
          action={action}
          setAction={setAction}
          hasFilters={hasFilters}
          clearFilters={clearFilters}
          t={t}
        />
      ) : (
        <AnomaliesTab anomalies={anomalies} t={t} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? "bg-accent text-accent-fg" : "text-fg-muted hover:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}

function LogTab({
  events,
  facets,
  search,
  setSearch,
  actor,
  setActor,
  resource,
  setResource,
  action,
  setAction,
  hasFilters,
  clearFilters,
  t,
}: {
  events: AuditEvent[];
  facets: AuditFacets;
  search: string;
  setSearch: (v: string) => void;
  actor: string;
  setActor: (v: string) => void;
  resource: string;
  setResource: (v: string) => void;
  action: string;
  setAction: (v: string) => void;
  hasFilters: boolean;
  clearFilters: () => void;
  t: TFn;
}) {
  return (
    <>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("audit_search_placeholder")}
          className="min-w-0 flex-1 rounded border border-line bg-input px-2 py-1 text-xs text-fg placeholder:text-fg-faint"
        />
        <Select
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          aria-label={t("audit_filter_actor")}
          wrapperClassName="w-auto"
          className="h-auto min-w-[7rem] py-1 text-xs"
        >
          <option value="">{`${t("audit_filter_actor")}: ${t("audit_filter_all")}`}</option>
          {facets.actors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Select
          value={resource}
          onChange={(e) => setResource(e.target.value)}
          aria-label={t("audit_filter_resource")}
          wrapperClassName="w-auto"
          className="h-auto min-w-[7rem] py-1 text-xs"
        >
          <option value="">{`${t("audit_filter_resource")}: ${t("audit_filter_all")}`}</option>
          {facets.resources.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
        <Select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          aria-label={t("audit_filter_action")}
          wrapperClassName="w-auto"
          className="h-auto min-w-[8rem] py-1 text-xs"
        >
          <option value="">{`${t("audit_filter_action")}: ${t("audit_filter_all")}`}</option>
          {facets.actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        {hasFilters && (
          <button
            onClick={clearFilters}
            className="rounded border border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface-2"
          >
            {t("audit_clear_filters")}
          </button>
        )}
        <span className="tabular ml-auto text-xs text-fg-faint">
          {t("audit_count").replace("{n}", String(events.length))}
        </span>
        <button
          type="button"
          disabled={events.length === 0}
          onClick={() => {
            const ndjson = events.map((e) => JSON.stringify(e)).join("\n");
            downloadText(ndjson, `audit-${stamp()}.ndjson`, "application/x-ndjson");
          }}
          className="rounded border border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 disabled:opacity-40"
        >
          {t("audit_download")}
        </button>
      </div>

      {/* Event list */}
      <div className="flex-1 overflow-auto rounded-xl border border-line bg-surface">
        {events.length === 0 ? (
          <Empty icon={<ScrollText className="h-9 w-9 opacity-60" />} title={t("audit_empty")}>
            {t("audit_empty_desc")}
          </Empty>
        ) : (
          <div className="flex flex-col divide-y divide-line/40">
            {events.map((e, i) => (
              <div
                key={`${e.ts}-${i}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-1.5 hover:bg-surface-2/40"
              >
                <span className="mono-xs tabular shrink-0 text-fg-faint">
                  {new Date(e.ts).toLocaleString()}
                </span>
                <span className="shrink-0 rounded-full border border-line bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-fg-muted">
                  {e.source}
                </span>
                <span className="mono-xs shrink-0 text-accent">
                  <span className="text-fg-faint">{resourceOf(e.action)}.</span>
                  {e.action.slice(resourceOf(e.action).length + 1)}
                </span>
                {e.detail && Object.keys(e.detail).length > 0 && (
                  <span className="mono-xs min-w-0 flex-1 truncate text-fg-dim" title={JSON.stringify(e.detail)}>
                    {JSON.stringify(e.detail)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

const KIND_KEY: Record<Anomaly["kind"], import("../i18n/en.ts").TranslationKey> = {
  "delete-burst": "audit_anomaly_kind_delete_burst",
  "vault-offhours": "audit_anomaly_kind_vault_offhours",
  "new-grant": "audit_anomaly_kind_new_grant",
};

function AnomaliesTab({ anomalies, t }: { anomalies: Anomaly[]; t: TFn }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-fg-faint">{t("audit_anomaly_hint")}</span>
      </div>
      <div className="flex-1 overflow-auto rounded-xl border border-line bg-surface p-3">
        {anomalies.length === 0 ? (
          <Empty
            icon={<ShieldAlert className="h-9 w-9 opacity-60" />}
            title={t("audit_anomaly_none")}
          >
            {t("audit_anomaly_none_desc")}
          </Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {anomalies.map((a) => {
              const critical = a.severity === "critical";
              return (
                <div
                  key={a.key}
                  className={`flex items-start gap-3 rounded-lg border p-3 ${
                    critical
                      ? "border-critical/30 bg-critical-subtle"
                      : "border-warn/30 bg-warn-subtle"
                  }`}
                >
                  <ShieldAlert
                    className={`mt-0.5 h-5 w-5 shrink-0 ${critical ? "text-critical-fg" : "text-warn-fg"}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          critical
                            ? "bg-critical/15 text-critical-fg"
                            : "bg-warn/15 text-warn-fg"
                        }`}
                      >
                        {t(KIND_KEY[a.kind])}
                      </span>
                      <span className="mono-xs tabular text-fg-faint">
                        {new Date(a.ts).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-fg">{a.text}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
