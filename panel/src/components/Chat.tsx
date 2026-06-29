import { useEffect, useRef, useState } from "react";
import { api, AuthError, type ApprovalView, type Autonomy, type ChatMessage, type Worker } from "../api.ts";
import { useChatEvents } from "../lib/useChatEvents.ts";
import { useAgentChatEvents } from "../lib/useAgentChatEvents.ts";
import { useI18n } from "../lib/useI18n.ts";
import { Markdown } from "../lib/markdown.tsx";
import { roleLabel } from "../lib/agentRole.ts";
import { Button } from "./ui.tsx";
import { Settings2, Plus, ClipboardList, Zap, ShieldCheck } from "lucide-react";

/** Sentinel id for the main Atlas chat (the Telegram-mirrored session). */
const ATLAS = "atlas";

/** Read a `?agent=<id>` deep-link param once, then strip it from the URL so it
 *  doesn't stick around on refresh / share. Returns ATLAS when absent. */
function initialAgentFromUrl(): string {
  if (typeof location === "undefined") return ATLAS;
  const url = new URL(location.href);
  const agent = url.searchParams.get("agent");
  if (!agent) return ATLAS;
  url.searchParams.delete("agent");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  return agent;
}

/**
 * Per-agent Planning/Execution preference, persisted in localStorage so the
 * last-used mode survives a reload or navigating away (a Lead you always want in
 * planning mode stays there). Keyed by agent id, so each Lead remembers its own
 * mode independently. Mirrors the localStorage pattern used elsewhere in the
 * panel (theme, newest-first, collapsibles).
 */
function usePlanningMode(agentId: string): [boolean, (v: boolean) => void] {
  const key = `myhq.panel.planning.${agentId}`;
  const [planning, setPlanning] = useState(() => localStorage.getItem(key) === "1");
  // Re-read when switching between agents (the same component instance is reused
  // for different agentIds via the switcher rail).
  useEffect(() => {
    setPlanning(localStorage.getItem(key) === "1");
  }, [key]);
  const update = (v: boolean) => {
    setPlanning(v);
    localStorage.setItem(key, v ? "1" : "0");
  };
  return [planning, update];
}

/**
 * Chat tab. Lets the President pick which agent to talk to via a switcher rail
 * at the top: Atlas (the shared Telegram session) plus every worker / Lead /
 * Assistant, each with its own resumable interactive session.
 */
export function ChatView({ onAuthError }: { onAuthError: () => void }) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selected, setSelected] = useState<string>(initialAgentFromUrl);
  const [fabOpen, setFabOpen] = useState(false);
  // Bumping this remounts the active pane to start a fresh conversation.
  const [chatNonce, setChatNonce] = useState(0);

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

  // If the selected agent disappears (deleted), fall back to Atlas. Wait for the
  // roster to load first so a deep-linked agent (?agent=…) isn't reset to Atlas
  // before the initial fetch resolves.
  useEffect(() => {
    if (workers.length === 0) return;
    if (selected !== ATLAS && !workers.some((w) => w.id === selected)) {
      setSelected(ATLAS);
    }
  }, [workers, selected]);

  // Start a fresh conversation with whoever is selected, then remount the pane.
  const newChat = async () => {
    try {
      if (selected === ATLAS) await api.clearChat();
      else await api.clearAgentChat(selected);
    } catch { /* the pane will resync on remount */ }
    setChatNonce((n) => n + 1);
  };

  return (
    <div className="relative flex h-[calc(100dvh-var(--nav-h-mobile))] flex-col pb-safe md:h-[calc(100dvh-var(--nav-h-desktop))] md:pb-0">
      <AgentSwitcher
        workers={workers}
        selected={selected}
        onSelect={setSelected}
      />
      {selected === ATLAS ? (
        <AtlasChat key={`atlas-${chatNonce}`} onAuthError={onAuthError} />
      ) : (
        <AgentChat
          key={`${selected}-${chatNonce}`}
          agentId={selected}
          worker={workers.find((w) => w.id === selected)}
          onAuthError={onAuthError}
        />
      )}

      {/* Mobile-only quick switcher / new-chat FAB (hidden on md+ where the rail is roomy). */}
      <ChatFab
        open={fabOpen}
        onToggle={() => setFabOpen((o) => !o)}
        onClose={() => setFabOpen(false)}
        workers={workers}
        selected={selected}
        onSelect={(id) => { setSelected(id); setFabOpen(false); }}
        onNewChat={() => { void newChat(); setFabOpen(false); }}
      />
    </div>
  );
}

/**
 * Floating action button for small screens: opens a compact sheet to start a
 * new chat or jump to a recent agent (Atlas + the most recently active crew).
 */
function ChatFab({
  open,
  onToggle,
  onClose,
  workers,
  selected,
  onSelect,
  onNewChat,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  workers: Worker[];
  selected: string;
  onSelect: (id: string) => void;
  onNewChat: () => void;
}) {
  const { t } = useI18n();
  // A short "recent" list: Atlas plus up to 4 crew (leads first), so the sheet
  // stays glanceable. The full roster lives in the always-present switcher rail.
  const leads = workers.filter((w) => w.role === "lead");
  const rest = workers.filter((w) => w.role !== "lead");
  const recent = [...leads, ...rest].slice(0, 4);

  return (
    <div className="md:hidden">
      {open && (
        <button
          aria-label={t("chat_fab_close")}
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/30"
        />
      )}
      <div
        className={`fixed bottom-[calc(var(--nav-h-mobile)+0.5rem)] right-4 z-50 origin-bottom-right transition-all duration-200 ${
          open ? "scale-100 opacity-100" : "pointer-events-none scale-90 opacity-0"
        }`}
      >
        <div className="mb-2 w-56 overflow-hidden rounded-2xl border border-line bg-surface shadow-xl">
          <button
            onClick={onNewChat}
            className="flex w-full items-center gap-2 border-b border-line px-3 py-3 text-left text-sm font-medium text-accent hover:bg-accent/10"
          >
            <Plus size={16} className="shrink-0" />
            {t("chat_fab_new")}
          </button>
          <div className="max-h-64 overflow-y-auto py-1">
            <SheetAgent
              label={t("chat_agent_atlas")}
              sub={t("chat_agent_atlas_sub")}
              active={selected === ATLAS}
              onClick={() => onSelect(ATLAS)}
              tone="atlas"
            />
            {recent.map((w) => (
              <SheetAgent
                key={w.id}
                label={w.name}
                sub={w.role === "lead" ? t("workers_lead") : shortModel(w.model) || t("workers_role_specialist")}
                active={selected === w.id}
                onClick={() => onSelect(w.id)}
                tone={w.role === "lead" ? "lead" : "agent"}
                listening={w.listening}
              />
            ))}
          </div>
        </div>
      </div>
      <button
        aria-label={t("chat_fab_new")}
        onClick={onToggle}
        className={`fixed bottom-[calc(var(--nav-h-mobile)+0.5rem)] right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-accent-fg shadow-lg transition-transform active:scale-95 ${
          open ? "rotate-45" : ""
        }`}
      >
        <Plus size={24} />
      </button>
    </div>
  );
}

function SheetAgent({
  label,
  sub,
  active,
  onClick,
  tone,
  listening,
}: {
  label: string;
  sub?: string;
  active: boolean;
  onClick: () => void;
  tone: "atlas" | "lead" | "agent";
  listening?: boolean;
}) {
  const dot = tone === "atlas" ? "bg-accent" : tone === "lead" ? "bg-blue-400" : "bg-fg-faint";
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
        active ? "bg-accent/10" : "hover:bg-surface-2"
      }`}
    >
      <span className={`relative h-2 w-2 shrink-0 rounded-full ${dot}`}>
        {listening && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-ok" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-sm ${active ? "font-medium text-accent" : "text-fg"}`}>{label}</span>
        {sub && <span className="block truncate text-xs text-fg-faint">{sub}</span>}
      </span>
    </button>
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
          <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-ok" />
        )}
      </span>
      <span className="min-w-0">
        <span className={`block truncate text-xs font-medium ${active ? "text-accent" : "text-fg"}`}>
          {label}
        </span>
        {sub && <span className="block truncate text-xs text-fg-faint">{sub}</span>}
      </span>
    </button>
  );
}

// ─── Atlas chat (the shared Telegram-mirrored session) ───────────────────────

function AtlasChat({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const { messages, stream, busy, view, setView, approvals } = useChatEvents(onAuthError);
  const [editingCwd, setEditingCwd] = useState(false);
  // Planning mode is a per-agent UI preference (defaults to Execution),
  // persisted in localStorage so it survives navigation/reload. It only changes
  // how the next message is framed to Atlas, not server state.
  const [planning, setPlanning] = usePlanningMode(ATLAS);

  // Autonomy level: fetched from the server on mount, updated via PUT /api/agent.
  const [autonomy, setAutonomyState] = useState<Autonomy>("standard");
  useEffect(() => {
    api.agent().then((a) => {
      // Only track the three UI-exposed levels; map auto_until_error → standard.
      const level = a.autonomy === "supervised" || a.autonomy === "full" ? a.autonomy : "standard";
      setAutonomyState(level);
    }).catch(() => {});
  }, []);
  const setAutonomy = async (a: Autonomy) => {
    setAutonomyState(a);
    try {
      await api.saveAgent({ autonomy: a });
    } catch {
      // Best-effort; UI already reflects the change.
    }
  };

  const saveCwd = async (cwd: string) => {
    setEditingCwd(false);
    setView(await api.chatSettings({ cwd }));
  };

  const empty = (
    <>
      {t("chat_empty")}
      <br />
      {t("chat_empty_perms")}
    </>
  );

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2 pb-3 pt-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          {t("chat_agent_atlas")}
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
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
        <PermissionsIndicator
          tools={view?.allowedTools ?? []}
          bashCmds={view?.allowedBashCmds ?? []}
        />
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
      approvals={approvals}
      planning={planning}
      onPlanningChange={setPlanning}
      autonomy={autonomy}
      onAutonomyChange={(a) => void setAutonomy(a)}
      onSend={(txt) => api.sendChat(txt, planning).then(() => {})}
      onStop={() => void api.stopChat()}
    />
  );
}

// ─── Per-agent chat (talk to one worker / Lead) ──────────────────────────────

function AgentChat({
  agentId,
  worker,
  onAuthError,
}: {
  agentId: string;
  worker?: Worker;
  onAuthError: () => void;
}) {
  const { t } = useI18n();
  const { messages, stream, busy, view, setView } = useAgentChatEvents(agentId, onAuthError);
  const [editingCwd, setEditingCwd] = useState(false);
  const [planning, setPlanning] = usePlanningMode(agentId);
  const role = worker ? roleLabel(worker, t) : undefined;

  const saveCwd = async (cwd: string) => {
    setEditingCwd(false);
    setView(await api.agentChatSettings(agentId, { cwd }));
  };

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2 pb-3 pt-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          {view?.name ?? "…"}
          <span className="rounded-full bg-blue-400/10 px-2 py-0.5 text-xs font-medium text-blue-400">
            {t("chat_agent_private")}
          </span>
        </h2>
        {role && <div className="mt-0.5 text-xs text-fg-dim">{role}</div>}
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
      agentName={view?.name}
      agentRole={role}
      empty={<>{t("chat_agent_empty").replace("{name}", view?.name ?? "")}<br />{t("chat_agent_empty_2")}</>}
      planning={planning}
      onPlanningChange={setPlanning}
      onSend={(txt) => api.sendAgentChat(agentId, txt, planning).then(() => {})}
      onStop={() => void api.stopAgentChat(agentId)}
    />
  );
}

// ─── Shared message list + composer ──────────────────────────────────────────

interface PaneStream {
  id: string;
  text: string;
  tool?: string;
  diffLines?: string;
  diffSnippet?: string;
}

function ChatPane({
  header,
  messages,
  stream,
  busy,
  empty,
  agentName,
  agentRole,
  approvals,
  planning,
  onPlanningChange,
  autonomy,
  onAutonomyChange,
  onSend,
  onStop,
}: {
  header: React.ReactNode;
  messages: ChatMessage[];
  stream: PaneStream | null;
  busy: boolean;
  empty: React.ReactNode;
  agentName?: string;
  agentRole?: string;
  /** Pending tool-call approvals to surface above the composer (Atlas only). */
  approvals?: ApprovalView[];
  /** When defined, renders a Planning/Execution mode pill in the composer. */
  planning?: boolean;
  onPlanningChange?: (planning: boolean) => void;
  /** When defined, renders an Autonomy selector in the composer toolbar. */
  autonomy?: Autonomy;
  onAutonomyChange?: (a: Autonomy) => void;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [diffOpen, setDiffOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Collapse diff when the tool changes.
  const prevToolRef = useRef<string | undefined>();
  useEffect(() => {
    if (stream?.tool !== prevToolRef.current) {
      prevToolRef.current = stream?.tool;
      setDiffOpen(false);
    }
  }, [stream?.tool]);

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
          <Bubble key={m.id} m={m} agentName={agentName} agentRole={agentRole} />
        ))}
        {stream && (
          <div className="flex flex-col gap-1">
            {agentName && (
              <div className="ml-1 flex flex-wrap items-center gap-1.5 self-start">
                <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold tracking-wide text-accent border border-accent/20">
                  {agentName}
                </span>
                {agentRole && <span className="text-xs text-fg-dim">{agentRole}</span>}
              </div>
            )}
            <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-surface px-4 py-2.5 text-sm">
              {stream.tool && (
                <div className="mono mb-1 flex items-center gap-2 text-xs text-fg-dim">
                  <span className="flex items-center gap-1">
                    <Settings2 size={12} className="shrink-0" />
                    {stream.tool}
                  </span>
                  {stream.diffLines && (
                    <span className="mono-xs rounded bg-surface-2 px-1.5 py-0.5 text-fg-faint">
                      {stream.diffLines}
                    </span>
                  )}
                  {stream.diffSnippet && (
                    <button
                      type="button"
                      onClick={() => setDiffOpen((o) => !o)}
                      className="text-xs text-accent hover:underline"
                    >
                      {diffOpen ? "hide diff" : "show diff"}
                    </button>
                  )}
                </div>
              )}
              {stream.diffSnippet && diffOpen && (
                <pre className="mb-2 overflow-x-auto rounded border border-line bg-base px-2 py-1 text-xs leading-snug">
                  {stream.diffSnippet.split("\n").map((line, i) => (
                    <div
                      key={i}
                      className={
                        line.startsWith("+ ") ? "text-ok-fg" :
                        line.startsWith("- ") ? "text-critical-fg" :
                        "text-fg-dim"
                      }
                    >
                      {line}
                    </div>
                  ))}
                </pre>
              )}
              <div className="break-words text-fg">
                <Markdown text={stream.text} />
                <span className="ml-0.5 animate-pulse text-accent">▮</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {approvals && approvals.length > 0 && (
        <ApprovalsBar approvals={approvals} />
      )}

      <div className="flex flex-col gap-2 border-t border-line pt-3">
        {(planning !== undefined && onPlanningChange) || (autonomy !== undefined && onAutonomyChange) ? (
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              {planning !== undefined && onPlanningChange && (
                <ModePill planning={planning} onChange={onPlanningChange} />
              )}
            </div>
            <div>
              {autonomy !== undefined && onAutonomyChange && (
                <AutonomyPill autonomy={autonomy} onChange={onAutonomyChange} />
              )}
            </div>
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            placeholder={planning ? t("chat_placeholder_planning") : t("chat_placeholder")}
            className={`max-h-40 min-h-[42px] flex-1 resize-none rounded-xl border bg-input px-3 py-2.5 text-sm text-fg outline-none focus:border-accent ${
              planning ? "border-accent/40" : "border-line"
            }`}
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
      </div>
    </>
  );
}

/**
 * Planning / Execution segmented toggle shown in the Atlas composer. Planning =
 * conversational, non-destructive (Atlas scopes work and proposes cards);
 * Execution = the normal behaviour where Atlas acts. Defaults to Execution.
 */
function ModePill({
  planning,
  onChange,
}: {
  planning: boolean;
  onChange: (planning: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2">
      <div className="inline-flex rounded-full border border-line bg-surface-2 p-0.5 text-xs font-medium">
        <button
          type="button"
          onClick={() => onChange(false)}
          className={`flex items-center gap-1 rounded-full px-2.5 py-1 transition-colors ${
            !planning ? "bg-accent text-accent-fg" : "text-fg-dim hover:text-fg-muted"
          }`}
        >
          <Zap size={11} className="shrink-0" />
          {t("chat_mode_execution")}
        </button>
        <button
          type="button"
          onClick={() => onChange(true)}
          className={`flex items-center gap-1 rounded-full px-2.5 py-1 transition-colors ${
            planning ? "bg-accent text-accent-fg" : "text-fg-dim hover:text-fg-muted"
          }`}
        >
          <ClipboardList size={11} className="shrink-0" />
          {t("chat_mode_planning")}
        </button>
      </div>
      <span className="text-xs text-fg-faint">
        {planning ? t("chat_mode_planning_hint") : t("chat_mode_execution_hint")}
      </span>
    </div>
  );
}

/**
 * Compact 3-segment autonomy selector shown in the Atlas composer toolbar.
 * Supervised / Standard / Full. Calls PUT /api/agent on change.
 */
function AutonomyPill({
  autonomy,
  onChange,
}: {
  autonomy: Autonomy;
  onChange: (a: Autonomy) => void;
}) {
  const { t } = useI18n();
  const options: { value: Autonomy; label: string }[] = [
    { value: "supervised", label: t("chat_autonomy_supervised") },
    { value: "standard",   label: t("chat_autonomy_standard") },
    { value: "full",       label: t("chat_autonomy_full") },
  ];
  return (
    <div className="inline-flex rounded-full border border-line bg-surface-2 p-0.5 text-xs font-medium">
      {options.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          className={`rounded-full px-2.5 py-1 transition-colors ${
            autonomy === value
              ? "bg-accent text-accent-fg"
              : "text-fg-dim hover:text-fg-muted"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Compact, read-only Permissions indicator for the Atlas header. Summarises the
 * shared session's persisted "always allow" presets ("3 tools always allowed")
 * and reveals the full list in a hover/focus popover. Informational only — the
 * presets are managed from Telegram (/allow, /disallow) or by approving with
 * "Always".
 */
function PermissionsIndicator({ tools, bashCmds }: { tools: string[]; bashCmds: string[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const count = tools.length + bashCmds.length;
  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
        title={t("chat_perms_title")}
        className="flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-fg-dim transition-colors hover:text-fg-muted"
      >
        <ShieldCheck size={12} className="shrink-0" />
        {count === 0 ? t("chat_perms_none") : t("chat_perms_count").replace("{n}", String(count))}
      </button>
      {open && count > 0 && (
        <div className="absolute bottom-full right-0 z-20 mb-1.5 w-60 rounded-lg border border-line bg-surface p-2.5 text-xs shadow-xl">
          <div className="mb-1.5 font-medium text-fg-dim">{t("chat_perms_heading")}</div>
          <div className="flex flex-wrap gap-1.5">
            {tools.map((name) => (
              <span key={name} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-fg">
                {name}
              </span>
            ))}
            {bashCmds.map((cmd) => (
              <span key={cmd} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-fg">
                $ {cmd}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Surfaces pending tool-call approvals in the panel so they can be resolved from
 * the browser (the panel token is trusted, same as terminal/chat access).
 * Allow/Deny settle the same promise the Telegram buttons do — whichever surface
 * acts first wins, and the WS broadcast drops the row from both.
 */
function ApprovalsBar({ approvals }: { approvals: ApprovalView[] }) {
  const { t } = useI18n();
  const [pending, setPending] = useState<string | null>(null);

  const resolve = async (id: string, allow: boolean) => {
    setPending(id);
    try {
      await api.resolveApproval(id, allow);
    } catch {
      /* The WS broadcast keeps the list authoritative; a stale row clears itself. */
    } finally {
      setPending((p) => (p === id ? null : p));
    }
  };

  return (
    <div className="mt-2 space-y-1.5 rounded-xl border border-warn/40 bg-warn-subtle/40 p-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-warn-fg">
        <ShieldCheck size={12} className="shrink-0" />
        {t("chat_approvals_heading").replace("{n}", String(approvals.length))}
      </div>
      {approvals.map((a) => (
        <div
          key={a.id}
          className="flex items-center gap-2 rounded-lg bg-surface px-2.5 py-1.5"
        >
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-fg">{a.toolName}</div>
            <div className="mono truncate text-xs text-fg-dim" title={a.preview}>
              {a.preview}
            </div>
          </div>
          <button
            type="button"
            disabled={pending === a.id}
            onClick={() => void resolve(a.id, true)}
            className="rounded-full bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {t("chat_approve")}
          </button>
          <button
            type="button"
            disabled={pending === a.id}
            onClick={() => void resolve(a.id, false)}
            className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-fg-dim transition-colors hover:text-fg-muted disabled:opacity-50"
          >
            {t("chat_deny")}
          </button>
        </div>
      ))}
    </div>
  );
}

function Bubble({ m, agentName, agentRole }: { m: ChatMessage; agentName?: string; agentRole?: string }) {
  const { t } = useI18n();
  const user = m.role === "user";
  const body = m.text || (m.error ? t("chat_failed") : "");
  return (
    <div className={`flex flex-col gap-1 ${user ? "items-end" : "items-start"}`}>
      {!user && agentName && (
        <div className="ml-1 flex flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold tracking-wide text-accent border border-accent/20">
            {agentName}
          </span>
          {agentRole && <span className="text-xs text-fg-dim">{agentRole}</span>}
        </div>
      )}
      <div
        className={`max-w-[85%] break-words rounded-2xl px-4 py-2.5 text-sm ${
          user
            ? "whitespace-pre-wrap rounded-tr-sm bg-accent text-accent-fg"
            : m.error
              ? "whitespace-pre-wrap rounded-tl-sm border border-critical/30 bg-critical-subtle text-critical-fg"
              : "rounded-tl-sm bg-surface text-fg"
        }`}
      >
        {user || m.error ? body : <Markdown text={body} />}
      </div>
    </div>
  );
}
