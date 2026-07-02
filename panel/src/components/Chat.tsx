import { useEffect, useRef, useState } from "react";
import { api, AuthError, type ApprovalView, type AskQuestionView, type Autonomy, type ChatImage, type ChatMessage, type Worker } from "../api.ts";
import { useChatEvents } from "../lib/useChatEvents.ts";
import { useAgentChatEvents } from "../lib/useAgentChatEvents.ts";
import { useActiveRuns } from "../lib/useActiveRuns.ts";
import { useI18n } from "../lib/useI18n.ts";
import { Markdown } from "../lib/markdown.tsx";
import { roleLabel } from "../lib/agentRole.ts";
import { avatarPng64Src, resolveAvatarSlug } from "../lib/avatar.ts";
import { Button } from "./ui.tsx";
import { TemplatePicker } from "./Templates.tsx";
import { toast } from "../lib/useToast.ts";
import { Settings2, Plus, ClipboardList, Zap, ShieldCheck, HelpCircle, Pencil, ThumbsUp, ThumbsDown, Paperclip, X } from "lucide-react";

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

/** MIME types the composer accepts for inline vision input. Kept in sync with
 *  the backend allowlist in core/chatImages.ts (which re-validates everything). */
const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
/** Client-side cap per image (~8 MB); the backend enforces the real limit. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Max images the composer will attach to one message. */
const MAX_IMAGES = 8;

/** A locally-staged image attachment before it's sent. */
interface StagedImage {
  id: string;
  base64: string;
  mediaType: string;
  /** data: URL for the preview thumbnail. */
  preview: string;
  name: string;
}

/**
 * Read a browser File into a StagedImage: base64 payload + MIME + preview URL.
 * Returns null for anything that isn't an accepted image or is too large; the
 * backend re-validates regardless, this just keeps obvious junk out of the UI.
 */
async function fileToStagedImage(file: File): Promise<StagedImage | null> {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return null;
  if (file.size > MAX_IMAGE_BYTES) return null;
  return await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      const base64 = comma >= 0 ? url.slice(comma + 1) : "";
      if (!base64) return resolve(null);
      resolve({
        id: Math.random().toString(16).slice(2),
        base64,
        mediaType: file.type,
        preview: url,
        name: file.name || "image",
      });
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Per-agent Planning/Execution preference, persisted in localStorage so the
 * last-used mode survives a reload or navigating away (a Lead you always want in
 * planning mode stays there). Keyed by agent id, so each Lead remembers its own
 * mode independently. Mirrors the localStorage pattern used elsewhere in the
 * panel (theme, newest-first, collapsibles).
 */
function usePlanningMode(agentId: string): [boolean, (v: boolean) => void] {
  const key = `myagens.panel.planning.${agentId}`;
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
export function ChatView({
  onAuthError,
  onEditAgent,
}: {
  onAuthError: () => void;
  /** Navigate to the Workers tab with this worker's editor opened. */
  onEditAgent?: (workerId: string) => void;
}) {
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
        onEditAgent={onEditAgent}
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

/** Horizontal, scrollable rail of selectable agents: Atlas first, then crew.
 *  Tapping the active pill toggles a compact profile card that slides in below
 *  the rail (height-animated, no popover — so it never clips on mobile). */
function AgentSwitcher({
  workers,
  selected,
  onSelect,
  onEditAgent,
}: {
  workers: Worker[];
  selected: string;
  onSelect: (id: string) => void;
  onEditAgent?: (workerId: string) => void;
}) {
  const { t } = useI18n();
  // Whether the profile card for the active pill is showing. Tapping a new pill
  // selects it and opens the card; tapping the already-active pill toggles it.
  const [profileOpen, setProfileOpen] = useState(false);
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

  // Tapping a pill: switch to it (and open its profile); tap the active pill to
  // toggle the card closed/open without changing selection.
  const onPill = (id: string) => {
    if (id === selected) {
      setProfileOpen((o) => !o);
    } else {
      onSelect(id);
      setProfileOpen(true);
    }
  };

  const activeWorker = selected === ATLAS ? undefined : ordered.find((w) => w.id === selected);
  const showProfile = profileOpen && (selected === ATLAS || !!activeWorker);

  return (
    <div className="shrink-0 border-b border-line">
      <div className="flex items-center gap-2 overflow-x-auto pb-3">
        <Pill
          active={selected === ATLAS}
          onClick={() => onPill(ATLAS)}
          label={t("chat_agent_atlas")}
          sub={t("chat_agent_atlas_sub")}
          tone="atlas"
          avatarId={ATLAS}
          avatar="robot"
          listening
        />
        {ordered.map((w) => (
          <Pill
            key={w.id}
            active={selected === w.id}
            onClick={() => onPill(w.id)}
            label={w.name}
            sub={
              w.role === "lead"
                ? t("workers_lead")
                : w.role === "assistant"
                  ? t("workers_assistant")
                  : shortModel(w.model) || t("workers_role_specialist")
            }
            tone={w.role === "lead" ? "lead" : "agent"}
            avatarId={w.id}
            avatar={w.avatar}
            listening={w.listening}
          />
        ))}
      </div>
      {/* Profile card: height-animated so it slides in/out smoothly. The grid
          0fr→1fr trick animates an auto-height child without measuring. */}
      <div
        className={`grid overflow-hidden transition-all duration-300 ease-out ${
          showProfile ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="min-h-0">
          {showProfile && (
            <ProfileCard
              worker={activeWorker}
              isAtlas={selected === ATLAS}
              onEditAgent={onEditAgent}
              onClose={() => setProfileOpen(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Compact profile card for the active agent, shown below the switcher rail.
 * Avatar + name + role badge + portfolio + a short persona preview, plus an
 * "Edit agent" link to the Workers tab. Atlas has no worker record, so it shows
 * a fixed tagline and no edit link.
 */
function ProfileCard({
  worker,
  isAtlas,
  onEditAgent,
  onClose,
}: {
  worker?: Worker;
  isAtlas: boolean;
  onEditAgent?: (workerId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const name = isAtlas ? t("chat_agent_atlas") : worker?.name ?? "";
  const slug = resolveAvatarSlug(isAtlas ? ATLAS : worker?.id ?? "", isAtlas ? "robot" : worker?.avatar);
  const roleBadge = isAtlas
    ? t("crew_role_coordinator")
    : worker
      ? roleLabel(worker, t)
      : "";
  const persona = isAtlas ? t("chat_profile_atlas_tagline") : (worker?.persona ?? "").trim();
  const personaPreview = persona.length > 100 ? `${persona.slice(0, 100).trimEnd()}…` : persona;

  return (
    <div className="mb-3 flex items-start gap-3 rounded-xl border border-accent/30 bg-accent/5 p-3">
      <img
        src={avatarPng64Src(slug)}
        alt=""
        aria-hidden
        className="h-16 w-16 shrink-0 rounded-full bg-surface-2 object-cover ring-1 ring-line"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-fg">{name}</span>
          {roleBadge && (
            <span
              className="max-w-[18ch] truncate rounded bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-fg-dim"
              title={roleBadge}
            >
              {roleBadge}
            </span>
          )}
        </div>
        {!isAtlas && worker?.portfolio && (
          <div className="mt-0.5 truncate text-xs text-fg-dim" title={worker.portfolio}>
            {worker.portfolio}
          </div>
        )}
        {personaPreview && (
          <p className="mt-1.5 text-xs italic text-fg-faint">{personaPreview}</p>
        )}
        {!isAtlas && worker && onEditAgent && (
          <button
            type="button"
            onClick={() => onEditAgent(worker.id)}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent transition-opacity hover:opacity-80"
          >
            <Pencil size={11} className="shrink-0" />
            {t("chat_profile_edit")}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={t("chat_profile_close")}
        title={t("chat_profile_close")}
        className="shrink-0 text-fg-faint transition-colors hover:text-fg-muted"
      >
        ✕
      </button>
    </div>
  );
}

function Pill({
  active,
  onClick,
  label,
  sub,
  tone,
  avatarId,
  avatar,
  listening,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  sub?: string;
  tone: "atlas" | "lead" | "agent";
  /** Worker id (or ATLAS) used to derive a deterministic avatar. */
  avatarId: string;
  /** Explicit avatar slug; falls back to a deterministic default from avatarId. */
  avatar?: string;
  listening?: boolean;
}) {
  const slug = resolveAvatarSlug(avatarId, avatar);
  const ring =
    tone === "atlas" ? "ring-accent/40" : tone === "lead" ? "ring-blue-400/40" : "ring-line";
  return (
    <button
      onClick={onClick}
      className={`flex w-32 shrink-0 items-center gap-2 rounded-xl border px-3 py-1.5 text-left transition-colors ${
        active
          ? "border-accent/50 bg-accent/10"
          : "border-line bg-surface hover:border-accent/30"
      }`}
    >
      <span className="relative shrink-0">
        <img
          src={avatarPng64Src(slug)}
          alt=""
          aria-hidden
          className={`h-7 w-7 rounded-full bg-surface-2 object-cover ring-1 ${ring}`}
        />
        {listening && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-ok ring-2 ring-surface" />
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
  const { messages, stream, busy, view, setView, approvals, asks } = useChatEvents(onAuthError);
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
    const prev = autonomy;
    setAutonomyState(a);
    try {
      await api.saveAgent({ autonomy: a });
    } catch (e) {
      // Roll back on failure. This selector controls whether tool calls prompt,
      // so leaving it showing a level the server never accepted is misleading
      // (the user would believe tools are gated when they aren't, or vice versa).
      setAutonomyState(prev);
      if (e instanceof AuthError) onAuthError();
      else toast.error(t("chat_autonomy_save_failed"));
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
      avatar="robot"
      approvals={approvals}
      asks={asks}
      planning={planning}
      onPlanningChange={setPlanning}
      autonomy={autonomy}
      onAutonomyChange={(a) => void setAutonomy(a)}
      onSend={(txt, imgs) => api.sendChat(txt, planning, imgs).then(() => {})}
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
          <span className="truncate">{view?.name ?? "…"}</span>
          <span className="shrink-0 rounded-full bg-blue-400/10 px-2 py-0.5 text-xs font-medium text-blue-400">
            {t("chat_agent_private")}
          </span>
        </h2>
        {role && <div className="mt-0.5 max-w-[32ch] truncate text-xs text-fg-dim" title={role}>{role}</div>}
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
      avatar={view?.avatar}
      empty={<>{t("chat_agent_empty").replace("{name}", view?.name ?? "")}<br />{t("chat_agent_empty_2")}</>}
      planning={planning}
      onPlanningChange={setPlanning}
      onSend={(txt, imgs) => api.sendAgentChat(agentId, txt, planning, imgs).then(() => {})}
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
  avatar,
  approvals,
  asks,
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
  /** Avatar slug shown next to assistant message bubbles. */
  avatar?: string;
  /** Pending tool-call approvals to surface above the composer (Atlas only). */
  approvals?: ApprovalView[];
  /** Pending AskUserQuestion prompts to surface above the composer (Atlas only). */
  asks?: AskQuestionView[];
  /** When defined, renders a Planning/Execution mode pill in the composer. */
  planning?: boolean;
  onPlanningChange?: (planning: boolean) => void;
  /** When defined, renders an Autonomy selector in the composer toolbar. */
  autonomy?: Autonomy;
  onAutonomyChange?: (a: Autonomy) => void;
  onSend: (text: string, images?: ChatImage[]) => Promise<void>;
  onStop: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [images, setImages] = useState<StagedImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The global "What's running" StatusStrip is pinned to the bottom of the
  // viewport whenever autonomous runs are in flight, and would otherwise sit on
  // top of the composer, making the input hard to reach. When runs are active we
  // reserve extra bottom space so the input clears the strip.
  const runsActive = useActiveRuns(true).length > 0;

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
    // An image-only message is allowed; otherwise require some text.
    if ((!txt && images.length === 0) || busy) return;
    const staged = images;
    setText("");
    setImages([]);
    try {
      await onSend(txt, staged.map((im) => ({ base64: im.base64, mediaType: im.mediaType })));
    } catch {
      // Restore the composer so the user doesn't lose their message + attachments.
      setText(txt);
      setImages(staged);
    }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  /** Stage a batch of files, dropping non-images and honouring MAX_IMAGES. */
  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      toast.error(t("chat_images_max"));
      return;
    }
    const staged = (await Promise.all(list.slice(0, room).map(fileToStagedImage))).filter(
      (x): x is StagedImage => x !== null,
    );
    if (staged.length < list.length) {
      // Some files were rejected (wrong type, too big, or over the cap).
      toast.error(t("chat_images_rejected"));
    }
    if (staged.length) setImages((cur) => [...cur, ...staged].slice(0, MAX_IMAGES));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
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
          <Bubble key={m.id} m={m} agentName={agentName} agentRole={agentRole} avatar={avatar} />
        ))}
        {stream && (
          <div className="flex items-start gap-2">
            {avatar && (
              <img
                src={avatarPng64Src(avatar)}
                alt=""
                aria-hidden
                className="mt-0.5 h-8 w-8 shrink-0 rounded-full bg-surface-2 object-cover"
              />
            )}
            <div className="flex min-w-0 flex-col gap-1">
            {agentName && (
              <div className="ml-1 flex min-w-0 items-center gap-1.5 self-start">
                <span className="max-w-[14ch] shrink-0 truncate rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold tracking-wide text-accent border border-accent/20" title={agentName}>
                  {agentName}
                </span>
                {agentRole && <span className="min-w-0 truncate text-xs text-fg-dim" title={agentRole}>{agentRole}</span>}
              </div>
            )}
            <div className="max-w-full rounded-2xl rounded-tl-sm bg-surface px-4 py-2.5 text-sm">
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
                      {diffOpen ? t("chat_diff_hide") : t("chat_diff_show")}
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
          </div>
        )}
      </div>

      {asks && asks.length > 0 && <AsksBar asks={asks} />}

      {approvals && approvals.length > 0 && (
        <ApprovalsBar approvals={approvals} />
      )}

      <div
        className={`relative flex flex-col gap-2 border-t border-line pt-3 transition-[padding] duration-200 ease-out ${runsActive ? "pb-14 md:pb-12" : ""}`}
        onDragOver={(e) => {
          if (e.dataTransfer?.types?.includes("Files")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          // Only clear when the pointer leaves the composer wrapper entirely.
          if (e.currentTarget === e.target) setDragOver(false);
        }}
        onDrop={onDrop}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-accent/60 bg-accent/5 text-sm font-medium text-accent">
            {t("chat_images_drop")}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            {planning !== undefined && onPlanningChange && (
              <ModePill planning={planning} onChange={onPlanningChange} />
            )}
            <TemplatePicker onPick={(tpl) => setText((cur) => (cur.trim() ? `${cur}\n${tpl}` : tpl))} />
          </div>
          <div>
            {autonomy !== undefined && onAutonomyChange && (
              <AutonomyPill autonomy={autonomy} onChange={onAutonomyChange} />
            )}
          </div>
        </div>
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((im) => (
              <div key={im.id} className="group relative h-16 w-16 overflow-hidden rounded-lg border border-line bg-surface">
                <img src={im.preview} alt={im.name} className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => setImages((cur) => cur.filter((x) => x.id !== im.id))}
                  className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-base/80 text-fg-dim hover:text-critical-fg"
                  title={t("chat_images_remove")}
                  aria-label={t("chat_images_remove")}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(",")}
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <Button
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || images.length >= MAX_IMAGES}
            className="h-[42px] px-2.5"
            title={t("chat_images_attach")}
            aria-label={t("chat_images_attach")}
          >
            <Paperclip size={18} />
          </Button>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
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
            <Button
              variant="primary"
              onClick={() => void send()}
              disabled={!text.trim() && images.length === 0}
              className="h-[42px]"
            >
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

/**
 * Surfaces pending AskUserQuestion prompts as interactive buttons in the panel,
 * mirroring the Telegram inline keyboard. Single-select resolves on tap;
 * multiSelect toggles options then confirms with Send. An "Other" toggle reveals
 * a free-text field. Answering settles the same promise the Telegram buttons do.
 */
function AsksBar({ asks }: { asks: AskQuestionView[] }) {
  return (
    <div className="mt-2 space-y-2">
      {asks.map((q) => (
        <AskCard key={q.id} q={q} />
      ))}
    </div>
  );
}

function AskCard({ q }: { q: AskQuestionView }) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [other, setOther] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async (answer: { optionIndices?: number[]; text?: string }) => {
    setPending(true);
    try {
      await api.resolveAsk(q.id, answer);
    } catch {
      /* The WS broadcast keeps the list authoritative; a stale card clears itself. */
    } finally {
      setPending(false);
    }
  };

  const toggle = (i: number) => {
    if (!q.multiSelect) {
      void submit({ optionIndices: [i] });
      return;
    }
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  return (
    <div className="space-y-2 rounded-xl border border-accent/40 bg-accent/5 p-2.5">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-accent">
        <HelpCircle size={12} className="shrink-0" />
        {q.header}
      </div>
      <div className="text-sm text-fg">{q.question}</div>
      <div className="flex flex-col gap-1.5">
        {q.options.map((o, i) => {
          const on = selected.has(i);
          return (
            <button
              key={i}
              type="button"
              disabled={pending}
              onClick={() => toggle(i)}
              className={`flex flex-col items-start rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors disabled:opacity-50 ${
                on
                  ? "bg-accent text-accent-fg"
                  : "bg-surface text-fg hover:bg-surface-2"
              }`}
            >
              <span className="font-semibold">
                {q.multiSelect && (on ? "✓ " : "")}
                {o.label}
              </span>
              {o.description && (
                <span className={on ? "text-accent-fg/80" : "text-fg-dim"}>{o.description}</span>
              )}
            </button>
          );
        })}
        {other ? (
          <div className="flex items-end gap-2">
            <textarea
              autoFocus
              rows={1}
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (otherText.trim()) void submit({ text: otherText });
                }
              }}
              placeholder={t("chat_ask_other_placeholder")}
              className="min-h-[2rem] flex-1 resize-none rounded-lg border border-line bg-input px-2.5 py-1.5 text-xs text-fg outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={pending || !otherText.trim()}
              onClick={() => void submit({ text: otherText })}
              className="rounded-full bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {t("chat_send")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => setOther(true)}
            className="self-start rounded-lg px-2.5 py-1.5 text-xs font-medium text-fg-dim transition-colors hover:text-fg-muted disabled:opacity-50"
          >
            {t("chat_ask_other")}
          </button>
        )}
      </div>
      {q.multiSelect && (
        <button
          type="button"
          disabled={pending || selected.size === 0}
          onClick={() => void submit({ optionIndices: [...selected] })}
          className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-fg transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {t("chat_ask_confirm")}
        </button>
      )}
    </div>
  );
}

function Bubble({
  m,
  agentName,
  agentRole,
  avatar,
}: {
  m: ChatMessage;
  agentName?: string;
  agentRole?: string;
  /** Avatar slug for assistant messages; renders a 32px circle to the left. */
  avatar?: string;
}) {
  const { t } = useI18n();
  const user = m.role === "user";
  const body = m.text || (m.error ? t("chat_failed") : "");

  // User messages: right-aligned, no avatar (unchanged).
  if (user) {
    return (
      <div className="flex flex-col items-end gap-1">
        {m.planning && (
          <span className="mr-1 inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/5 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-accent">
            <ClipboardList size={11} />
            {t("chat_planning_badge")}
          </span>
        )}
        <div className="max-w-[85%] break-words whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-accent px-4 py-2.5 text-sm text-accent-fg">
          {body}
        </div>
      </div>
    );
  }

  // Assistant messages: avatar circle + bubble in a flex row, left-aligned.
  return (
    <div className="flex items-start gap-2">
      {avatar && (
        <img
          src={avatarPng64Src(avatar)}
          alt=""
          aria-hidden
          className="mt-0.5 h-8 w-8 shrink-0 rounded-full bg-surface-2 object-cover"
        />
      )}
      <div className="flex min-w-0 flex-col items-start gap-1">
        {agentName && (
          <div className="ml-1 flex min-w-0 items-center gap-1.5">
            <span className="max-w-[14ch] shrink-0 truncate rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold tracking-wide text-accent border border-accent/20" title={agentName}>
              {agentName}
            </span>
            {agentRole && <span className="min-w-0 truncate text-xs text-fg-dim" title={agentRole}>{agentRole}</span>}
          </div>
        )}
        <div
          className={`max-w-full break-words rounded-2xl px-4 py-2.5 text-sm ${
            m.error
              ? "whitespace-pre-wrap rounded-tl-sm border border-critical/30 bg-critical-subtle text-critical-fg"
              : "rounded-tl-sm bg-surface text-fg"
          }`}
        >
          {m.error ? body : <Markdown text={body} />}
        </div>
        {!m.error && m.text && <ReactionRow text={m.text} />}
      </div>
    </div>
  );
}

/**
 * Thumbs up/down feedback under an assistant message. Up files the response as a
 * durable memory; down lands a suggestion in the president's inbox. Once a
 * reaction is sent the row collapses to the chosen state so it can't be spammed.
 */
function ReactionRow({ text }: { text: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState<"up" | "down" | null>(null);
  const [pending, setPending] = useState(false);

  const react = async (reaction: "up" | "down") => {
    if (pending || done) return;
    setPending(true);
    try {
      await api.reactToMessage(reaction, text);
      setDone(reaction);
      toast.success(reaction === "up" ? t("chat_react_saved") : t("chat_react_filed"));
    } catch {
      toast.error(t("chat_react_error"));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="ml-1 flex items-center gap-1">
      <button
        onClick={() => void react("up")}
        disabled={pending || done !== null}
        title={t("chat_react_helpful")}
        aria-label={t("chat_react_helpful")}
        className={`rounded p-1 transition-colors disabled:cursor-default ${
          done === "up" ? "text-accent" : "text-fg-faint hover:text-fg disabled:hover:text-fg-faint"
        }`}
      >
        <ThumbsUp size={13} />
      </button>
      <button
        onClick={() => void react("down")}
        disabled={pending || done !== null}
        title={t("chat_react_unhelpful")}
        aria-label={t("chat_react_unhelpful")}
        className={`rounded p-1 transition-colors disabled:cursor-default ${
          done === "down" ? "text-critical-fg" : "text-fg-faint hover:text-fg disabled:hover:text-fg-faint"
        }`}
      >
        <ThumbsDown size={13} />
      </button>
    </div>
  );
}
