import { useEffect, useId, useState } from "react";
import { api, AuthError, type MainAgent } from "../api.ts";
import { Badge, Button, Card, Input, Label } from "./ui.tsx";

const MODEL_SUGGESTIONS = ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-8"];

/** Configure the main bot agent (the one driving Telegram chats): its model and
 *  optional local/proxy provider, plus context-reset and service-restart. */
export function MainAgentCard({ onAuthError }: { onAuthError: () => void }) {
  const [agent, setAgent] = useState<MainAgent | null>(null);
  const [model, setModel] = useState("");
  const [providerId, setProviderId] = useState("");
  const [fetched, setFetched] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const listId = useId();

  const load = () =>
    api
      .agent()
      .then((a) => {
        setAgent(a);
        setModel(a.model);
        setProviderId(a.providerId);
      })
      .catch((e) => e instanceof AuthError && onAuthError());

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!agent) return null;

  const dirty = model !== agent.model || providerId !== agent.providerId;

  const flash = (m: string) => {
    setStatus(m);
    setTimeout(() => setStatus(null), 2500);
  };

  const save = async () => {
    setBusy("save");
    try {
      const next = await api.saveAgent({ model, providerId });
      setAgent(next);
      flash("Saved — applies on the next message ✓");
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      flash(String(e));
    } finally {
      setBusy(null);
    }
  };

  const fetchModels = async () => {
    if (!providerId) return;
    setBusy("fetch");
    try {
      setFetched((await api.providerModels(providerId)).models);
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    if (!confirm("Abort any running turn and clear all conversation context?")) return;
    setBusy("reset");
    try {
      const r = await api.resetAgent();
      flash(`Reset ${r.sessions} session(s), aborted ${r.aborted} ✓`);
    } finally {
      setBusy(null);
    }
  };

  const restart = async () => {
    if (!confirm("Restart the bot service? The panel will briefly disconnect.")) return;
    setBusy("restart");
    try {
      await api.restartAgent();
      flash("Restarting… reconnecting shortly");
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="Main agent"
      right={<Badge tone="blue">{agent.effectiveModel}</Badge>}
    >
      <p className="mb-3 text-sm text-fg-dim">
        The agent driving Telegram chats. Changes apply on the next message (a fresh
        <code> claude </code> process starts per turn).
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>Provider</Label>
          <select
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            className="w-full rounded-lg border border-line bg-input px-3 py-2 text-sm text-fg outline-none focus:border-blue-500"
          >
            <option value="">Anthropic (default / .env)</option>
            {agent.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Model</Label>
          <div className="flex gap-2">
            <Input
              list={listId}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={providerId ? "local model name" : "default (CLAUDE_MODEL)"}
            />
            {providerId && (
              <Button onClick={fetchModels} disabled={busy === "fetch"} className="shrink-0">
                {busy === "fetch" ? "…" : "Fetch"}
              </Button>
            )}
          </div>
          <datalist id={listId}>
            {[...new Set([...(providerId ? fetched : MODEL_SUGGESTIONS), ...fetched])].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={save} disabled={!dirty || busy === "save"}>
          {busy === "save" ? "Saving…" : "Save"}
        </Button>
        <Button onClick={reset} disabled={busy === "reset"}>
          New context
        </Button>
        <Button
          variant="danger"
          onClick={restart}
          disabled={!agent.serviceInstalled || busy === "restart"}
          title={agent.serviceInstalled ? "" : "No service manager detected"}
        >
          Restart service
        </Button>
        {status && <span className="text-xs text-fg-dim">{status}</span>}
      </div>
    </Card>
  );
}
