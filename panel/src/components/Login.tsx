import { useState } from "react";
import { checkToken, setToken } from "../api.ts";

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await checkToken(value.trim());
      if (!ok) {
        setError("Invalid token.");
        return;
      }
      setToken(value.trim());
      onAuthed();
    } catch {
      setError("Could not reach the panel.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6"
      >
        <h1 className="text-lg font-semibold text-fg">Control Panel</h1>
        <p className="mt-1 text-sm text-fg-dim">Enter the panel token to continue.</p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="PANEL_TOKEN"
          className="mt-4 w-full rounded-lg border border-line bg-input px-3 py-2 text-sm text-fg outline-none focus:border-blue-500"
        />
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-4 w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
