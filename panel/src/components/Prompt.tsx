import { useEffect, useState } from "react";
import { api, AuthError, type PromptView } from "../api.ts";
import { Button, Card, Empty, TextArea } from "./ui.tsx";

export function PromptView_({ onAuthError }: { onAuthError: () => void }) {
  const [data, setData] = useState<PromptView | null>(null);
  const [work, setWork] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPersona, setShowPersona] = useState(false);

  useEffect(() => {
    api
      .prompt()
      .then((p) => {
        setData(p);
        setWork(p.work);
      })
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <Empty>Failed to load: {error}</Empty>;
  if (!data) return <Empty>Loading…</Empty>;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.savePrompt(work);
      setData(next);
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card
        title="Operator playbook"
        right={
          <span className="font-mono text-xs text-fg-faint" title={data.workFile}>
            {data.exists ? "work.md" : "work.md (new)"}
          </span>
        }
      >
        <p className="mb-3 text-sm text-fg-dim">
          Appended to every turn's system prompt and re-read live — no restart needed. Define how
          recurring operational requests should be handled.
        </p>
        <TextArea
          rows={18}
          value={work}
          onChange={(e) => {
            setWork(e.target.value);
            setDirty(true);
          }}
          placeholder="# Operator playbook&#10;&#10;- How to handle deploys&#10;- Service conventions…"
        />
        <div className="mt-3 flex items-center gap-3">
          <Button variant="primary" onClick={save} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save playbook"}
          </Button>
          {saved && <span className="text-xs text-emerald-400">Saved ✓</span>}
          {dirty && !saved && <span className="text-xs text-fg-faint">Unsaved changes</span>}
        </div>
      </Card>

      <Card
        title="Personality (read-only)"
        right={
          <Button onClick={() => setShowPersona((s) => !s)}>
            {showPersona ? "Hide" : "Show"}
          </Button>
        }
      >
        <p className="text-sm text-fg-dim">
          Compiled into the build and prepended before the playbook. Edit in <code>src/prompt.ts</code>.
        </p>
        {showPersona && (
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-input p-3 text-xs text-fg-muted">
            {data.personality}
          </pre>
        )}
      </Card>
    </div>
  );
}
