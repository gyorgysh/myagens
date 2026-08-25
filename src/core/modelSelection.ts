import { listBackends } from "./backends.js";
import { escapeHtml } from "../telegram/formatting.js";

/** Parse the value accepted by `/model` on both Atlas and Lead bots. */
export function parseModelSelection(arg: string): { model?: string; backendId?: string } {
  const backendIds = new Set(listBackends().map((backend) => backend.id));
  const colonIdx = arg.indexOf(":");
  if (colonIdx > -1) {
    const maybeBackend = arg.slice(0, colonIdx).trim();
    if (backendIds.has(maybeBackend)) {
      return { backendId: maybeBackend, model: arg.slice(colonIdx + 1).trim() };
    }
  }
  if (backendIds.has(arg)) return { backendId: arg, model: "" };
  return { model: arg };
}

/** HTML help that makes the agentic CLI/backend switch discoverable. */
export function backendChoicesHtml(activeBackendId?: string): string {
  const active = activeBackendId || "claude-agent-sdk";
  const lines = listBackends().map((backend) => {
    const selected = backend.id === active ? " ✓" : "";
    return `<code>/model ${escapeHtml(backend.id)}</code> — ${escapeHtml(backend.displayName)}${selected}`;
  });
  return (
    "\n\n<b>Agent backends</b>\n" +
    "These switch the whole agentic CLI/runtime, not just its model:\n" +
    lines.join("\n") +
    "\n\nOptional backend model: <code>/model agy-cli:model-name</code>"
  );
}
