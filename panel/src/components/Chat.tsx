import { useEffect, useRef, useState } from "react";
import { api, AuthError, type ChatMessage, type Worker } from "../api.ts";
import { useChatEvents } from "../lib/useChatEvents.ts";
import { useAgentChatEvents } from "../lib/useAgentChatEvents.ts";
import { useI18n } from "../lib/useI18n.ts";
import { Markdown } from "../lib/markdown.tsx";
import { Button } from "./ui.tsx";

/** Sentinel id for the main Atlas chat (the Telegram-mirrored session). */
const ATLAS = "atlas";

/**
 * Chat tab. Lets the President pick which agent to talk to via a switcher rail
 * at the top: Atlas (the shared Telegram session) plus every worker / Lead /
 * Assistant, each with its own resumable interactive session.
 */
export function ChatView({ onAuthError }: { onAuthError: () => void }) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selected, setSelected] = useState<string>(ATLAS);

  useEffect(() => {
    const load = () =>
      api
        .workers()
        .then((r) => setWorkers(r.workers))
        .catch((e) => (e instanceof AuthError ? onAuthError() : undefined));
    void load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If the selected agent disappears (deleted), fall back to Atlas.
  useEffect(() => {
    if (selected !== ATLAS && !workers.some((w) => w.id === selected)) {
      setSelected(ATLAS);
    }
  }, [workers, selected]);

  return (
    <div className="flex h-[calc(100dvh-var(--nav-h-mobile))] flex-col pb-safe md:h-[calc(100dvh-var(--nav-h-desktop))] md:pb-0">
      <AgentSwitcher
        workers={workers}
        selected={selected}
        onSelect={setSelected}
      />
      {selected === ATLAS ? (
        <AtlasChat onAuthError={onAuthError} />
      ) : (
        <AgentChat key={selected} agentId={selected} onAuthError={onAuthError} />
      )}
    </div>
  );
}

/** Short, readable model badge (e.g. "opus-4-8"). */
function shortModel(id?: string): string {
  return (id ?? "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/** Horizontal, scrollable rail of selectable agents: Atlas first, then crew. */
function AgentSwitcher({
  workers,
  selected,
  onSelect,
}: {
  workers: Worker[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const leads = workers.filter((w) => w.role === "lead");
  const assistants = workers.filter((w) => w.role === "assistant");
  const specialists = workers.filter(
    (w) => !w.role || (w.role !== "lead" && w.role !== "assistant"),
  );
  // Ordered: leads (each followed by its assistants), then orphan assistants,
  // then specialists — same grouping the Crew/Workers views use.
  const parented = new Set<string>();
  const ordered: Worker[] = [];
  for (const lead of leads) {
    ordered.push(lead);
    for (const a of assistants.filter((x) => x.parentId === lead.id)) {
      ordered.push(a);
      parented.add(a.id);
    }
  }
  ordered.push(...assistants.filter((a) => !parented.has(a.id)));
  ordered.push(...specialists);

  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line pb-3">
      <Pill
        active={selected === ATLAS}
        onClick={() => onSelect(ATLAS)}
        label={t("chat_agent_atlas")}
        sub={t("chat_agent_atlas_sub")}
        tone="atlas"
      />
      {ordered.map((w) => (
        <Pill
          key={w.id}
          active={selected === w.id}
          onClick={() => onSelect(w.id)}
          label={w.name}
          sub={
            w.role === "lead"
              ? t("workers_lead")
              : w.role === "assistant"
                ? t("workers_assistant")
                : shortModel(w.model) || t("workers_role_specialist")
          }
          tone={w.role === "lead" ? "lead" : "agent"}
          listening={w.listening}
        />
      ))}
    </div>
  );
}

function Pill({
  active,
  onClick,
  label,
  sub,
  tone,
  listening,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  sub?: string;
  tone: "atlas" | "lead" | "agent";
  listening?: boolean;
}) {
  const dot =
    tone === "atlas" ? "bg-accent" : tone === "lead" ? "bg-blue-400" : "bg-fg-faint";
  return (
    <button
      onClick={onClick}
      className={`flex shrink-0 items-center gap-2 rounded-xl border px-3 py-1.5 text-left transition-colors ${
        active
          ? "border-accent/50 bg-accent/10"
          : "border-line bg-surface hover:border-accent/30"
      }`}
    >
      <span className={`relative h-2 w-2 shrink-0 rounded-full ${dot}`}>
        {listening && (
          <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-green-400" />
        )}
      </span>
      <span className="min-w-0">
        <span className={`block truncate text-xs font-medium ${active ? "text-accent" : "text-fg"}`}>
          {label}
        </span>
        {sub && <span className="block truncate text-[10px] text-fg-faint">{sub}</span>}
      </span>
    </button>
  );
}

// ─── Atlas chat (the shared Telegram-mirrored session) ───────────────────────

function AtlasChat({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const { messages, stream, busy, view, setView } = useChatEvents(onAuthError);
  const [editingCwd, setEditingCwd] = useState(false);

  const toggleAuto = async () => {
    if (!view?.bypassAllowed) return;
    setView(await api.chatSettings({ auto: !view.auto }));
  };
  const saveCwd = async (cwd: string) => {
    setEditingCwd(false);
    setView(await api.chatSettings({ cwd }));
  };

  const empty = (
    <>
      {t("chat_empty")}
      <br />
      {view?.auto ? t("chat_empty_auto") : t("chat_empty_safe")}
    </>
  );

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2 pb-3 pt-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          {t("chat_agent_atlas")}
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
            {t("chat_shared_badge")}
          </span>
        </h2>
        {editingCwd ? (
          <input
            autoFocus
            defaultValue={view?.cwd ?? ""}
            onBlur={(e) => void saveCwd(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void saveCwd((e.target as HTMLInputElement).value)}
            className="mono mt-0.5 w-72 max-w-full rounded border border-line bg-input px-1.5 py-0.5 text-xs text-fg outline-none focus:border-accent"
          />
        ) : (
          <button
            onClick={() => setEditingCwd(true)}
            title={t("chat_change_cwd")}
            className="mono mt-0.5 block max-w-full truncate text-xs text-fg-dim hover:text-fg-muted"
          >
            {view?.cwd ?? "…"}
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={toggleAuto}
          disabled={!view?.bypassAllowed}
          title={view?.bypassAllowed ? t("chat_toggle_auto") : t("chat_toggle_locked")}
          className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
            view?.auto ? "bg-amber-500/15 text-amber-400" : "bg-surface-2 text-fg-dim"
          } ${view?.bypassAllowed ? "" : "cursor-not-allowed opacity-60"}`}
        >
          {!view?.bypassAllowed && <span className="mr-1">🔒</span>}
          {view?.auto ? t("chat_auto") : t("chat_safe")}
        </button>
        <Button variant="ghost" onClick={async () => view && setView(await api.clearChat())} disabled={busy}>
          {t("chat_clear")}
        </Button>
      </div>
    </div>
  );

  return (
    <ChatPane
      header={header}
      messages={messages}
      stream={stream}
      busy={busy}
      empty={empty}
      onSend={(txt) => api.sendChat(txt).then(() => {})}
      onStop={() => void api.stopChat()}
    />
  );
}

// ─── Per-agent chat (talk to one worker / Lead) ──────────────────────────────

function AgentChat({ agentId, onAuthError }: { agentId: string; onAuthError: () => void }) {
  const { t } = useI18n();
  const { messages, stream, busy, view, setView } = useAgentChatEvents(agentId, onAuthError);
  const [editingCwd, setEditingCwd] = useState(false);

  const saveCwd = async (cwd: string) => {
    setEditingCwd(false);
    setView(await api.agentChatSettings(agentId, { cwd }));
  };

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2 pb-3 pt-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          {view?.name ?? "…"}
          <span className="rounded-full bg-blue-400/10 px-2 py-0.5 text-[10px] font-medium text-blue-400">
            {t("chat_agent_private")}
          </span>
        </h2>
        {editingCwd ? (
          <input
            autoFocus
            defaultValue={view?.cwd ?? ""}
            onBlur={(e) => void saveCwd(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void saveCwd((e.target as HTMLInputElement).value)}
            className="mono mt-0.5 w-72 max-w-full rounded border border-line bg-input px-1.5 py-0.5 text-xs text-fg outline-none focus:border-accent"
          />
        ) : (
          <button
            onClick={() => setEditingCwd(true)}
            title={t("chat_change_cwd")}
            className="mono mt-0.5 block max-w-full truncate text-xs text-fg-dim hover:text-fg-muted"
          >
            {view?.cwd ?? "…"}
          </button>
        )}
      </div>
      <Button
        variant="ghost"
        onClick={async () => setView(await api.clearAgentChat(agentId))}
        disabled={busy}
      >
        {t("chat_clear")}
      </Button>
    </div>
  );

  return (
    <ChatPane
      header={header}
      messages={messages}
      stream={stream}
      busy={busy}
      empty={t("chat_agent_empty").replace("{name}", view?.name ?? "")}
      onSend={(txt) => api.sendAgentChat(agentId, txt).then(() => {})}
      onStop={() => void api.stopAgentChat(agentId)}
    />
  );
}

// ─── Shared message list + composer ──────────────────────────────────────────

interface PaneStream {
  id: string;
  text: string;
  tool?: string;
}

function ChatPane({
  header,
  messages,
  stream,
  busy,
  empty,
  onSend,
  onStop,
}: {
  header: React.ReactNode;
  messages: ChatMessage[];
  stream: PaneStream | null;
  busy: boolean;
  empty: React.ReactNode;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, stream?.text]);

  const send = async () => {
    const txt = text.trim();
    if (!txt || busy) return;
    setText("");
    try {
      await onSend(txt);
    } catch {
      setText(txt);
    }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <>
      {header}
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto border-t border-line py-4">
        {messages.length === 0 && !stream && (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-fg-faint">
            <div className="mono mb-2 text-2xl text-accent">%_</div>
            {empty}
          </div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
        {stream && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-surface px-4 py-2.5 text-sm">
              {stream.tool && <div className="mono mb-1 text-xs text-fg-dim">⚙ {stream.tool}</div>}
              <div className="break-words text-fg">
                <Markdown text={stream.text} />
                <span className="ml-0.5 animate-pulse text-accent">▮</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-line pt-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          rows={1}
          placeholder={t("chat_placeholder")}
          className="max-h-40 min-h-[42px] flex-1 resize-none rounded-xl border border-line bg-input px-3 py-2.5 text-sm text-fg outline-none focus:border-accent"
        />
        {busy ? (
          <Button variant="danger" onClick={onStop} className="h-[42px]">
            {t("stop")}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void send()} disabled={!text.trim()} className="h-[42px]">
            {t("chat_send")}
          </Button>
        )}
      </div>
    </>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  const { t } = useI18n();
  const user = m.role === "user";
  const body = m.text || (m.error ? t("chat_failed") : "");
  return (
    <div className={`flex ${user ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] break-words rounded-2xl px-4 py-2.5 text-sm ${
          user
            ? "whitespace-pre-wrap rounded-tr-sm bg-accent text-accent-fg"
            : m.error
              ? "whitespace-pre-wrap rounded-tl-sm border border-red-500/30 bg-red-500/5 text-red-400"
              : "rounded-tl-sm bg-surface text-fg"
        }`}
      >
        {user || m.error ? body : <Markdown text={body} />}
      </div>
    </div>
  );
}
