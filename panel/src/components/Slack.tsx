import { useEffect, useRef, useState } from "react";
import { api, AuthError, type SlackSettingsView, type SlackDetectState } from "../api.ts";
import { useI18n } from "../lib/useI18n.ts";
import { errorMessage } from "../lib/errorMessage.ts";
import { toast } from "../lib/useToast.ts";
import { Badge, Button, Card, Input, Label, Skeleton } from "./ui.tsx";

/**
 * Slack setup, in the order the Slack admin makes you do it: create the app
 * from a manifest, paste the two tokens, then say who is allowed to use it.
 *
 * The member id is detected from a DM rather than typed. Finding your own
 * Slack member id means digging through a profile overflow menu, and getting
 * it wrong means the bot silently ignores you, which is indistinguishable
 * from it being broken.
 */

const MANIFEST_HELP_URL = "https://api.slack.com/apps";

export function SlackView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [view, setView] = useState<SlackSettingsView | null>(null);
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [userIds, setUserIds] = useState<string[]>([]);
  const [manualId, setManualId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [detect, setDetect] = useState<SlackDetectState | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = () =>
    api
      .slackSettings()
      .then((v) => {
        setView(v);
        setUserIds(v.allowedUserIds);
      })
      .catch((err) => {
        if (err instanceof AuthError) onAuthError();
      });

  useEffect(() => {
    void load();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      // Detection holds a second Slack connection open; don't leave it running
      // just because the user navigated away mid-step.
      void api.stopSlackDetect().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wrap = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      if (err instanceof AuthError) onAuthError();
      else toast.error(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  };

  const verify = () =>
    wrap("verify", async () => {
      const r = await api.verifySlackTokens(botToken || undefined, appToken || undefined);
      toast.success(
        r.identity?.team ? `Slack workspace: ${r.identity.team}` : "Tokens look good.",
      );
    });

  const save = (patch: Parameters<typeof api.updateSlackSettings>[0]) =>
    wrap("save", async () => {
      const v = await api.updateSlackSettings(patch);
      setView(v);
      setUserIds(v.allowedUserIds);
      if (patch.botToken) setBotToken("");
      if (patch.appToken) setAppToken("");
      toast.success(v.running ? "Saved. Slack is connected." : "Saved.");
    });

  const startDetect = () =>
    wrap("detect", async () => {
      await api.startSlackDetect(botToken || undefined, appToken || undefined);
      setDetect({ running: true, warning: null, candidates: [] });
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        void api
          .slackDetectState()
          .then((s) => {
            setDetect(s);
            if (!s.running && pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
          })
          .catch(() => {});
      }, 2000);
    });

  const stopDetect = () =>
    wrap("detect", async () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      await api.stopSlackDetect();
      setDetect(null);
    });

  const addUser = (id: string) => {
    const next = [...new Set([...userIds, id.trim()])].filter(Boolean);
    setUserIds(next);
    void save({ allowedUserIds: next });
    void api.confirmSlackUser(id.trim()).catch(() => {});
    void stopDetect();
  };

  const removeUser = (id: string) => {
    const next = userIds.filter((u) => u !== id);
    setUserIds(next);
    void save({ allowedUserIds: next });
  };

  if (!view) return <Skeleton className="h-40" />;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-fg">Slack</h3>
            <p className="mt-1 text-xs text-fg-dim">
              A direct-message chat surface alongside Telegram. Allowed members DM the bot; everyone
              else is ignored.
            </p>
          </div>
          <Badge tone={view.running ? "green" : view.configured ? "amber" : "zinc"}>
            {view.running ? "Connected" : view.configured ? "Starting" : "Not configured"}
          </Badge>
        </div>
      </Card>

      <Card>
        <h4 className="text-sm font-medium text-fg">1 · Create the Slack app</h4>
        <p className="mt-1 text-xs text-fg-dim">
          At{" "}
          <a className="underline" href={MANIFEST_HELP_URL} target="_blank" rel="noreferrer">
            api.slack.com/apps
          </a>{" "}
          choose <em>Create New App → From an app manifest</em>, pick your workspace, select JSON,
          and paste this. It turns on Socket Mode and Interactivity for you.
        </p>
        <pre className="mt-2 max-h-56 overflow-auto rounded bg-surface-2 p-3 text-[11px] leading-snug text-fg-dim">
          {JSON.stringify(view.manifest, null, 2)}
        </pre>
        <Button
          className="mt-2"
          onClick={() => {
            void navigator.clipboard?.writeText(JSON.stringify(view.manifest, null, 2));
            toast.success(t("setup_ready_copied"));
          }}
        >
          Copy manifest
        </Button>
      </Card>

      <Card>
        <h4 className="text-sm font-medium text-fg">2 · Paste the two tokens</h4>
        <p className="mt-1 text-xs text-fg-dim">
          They live on different pages and are easy to mix up. Both are checked against Slack before
          anything is saved.
        </p>
        <div className="mt-3 space-y-3">
          <div>
            <Label>
              Bot token: <em>OAuth &amp; Permissions</em>, after “Install to Workspace”
            </Label>
            <Input
              type="password"
              placeholder={view.hasBotToken ? "•••••••• (set)" : "xoxb-…"}
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
            {view.botTokenFromEnv && (
              <p className="mt-1 text-[11px] text-fg-dim">
                Currently from <code>SLACK_BOT_TOKEN</code> in .env. Saving one here takes over.
              </p>
            )}
          </div>
          <div>
            <Label>
              App-level token: <em>Basic Information → App-Level Tokens</em>, scope{" "}
              <code>connections:write</code>
            </Label>
            <Input
              type="password"
              placeholder={view.hasAppToken ? "•••••••• (set)" : "xapp-…"}
              value={appToken}
              onChange={(e) => setAppToken(e.target.value)}
            />
            {view.appTokenFromEnv && (
              <p className="mt-1 text-[11px] text-fg-dim">
                Currently from <code>SLACK_APP_TOKEN</code> in .env. Saving one here takes over.
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button onClick={verify} disabled={busy !== null || (!botToken && !appToken)}>
              {busy === "verify" ? "Checking…" : "Check tokens"}
            </Button>
            <Button
              variant="primary"
              onClick={() => save({ botToken: botToken || undefined, appToken: appToken || undefined })}
              disabled={busy !== null || (!botToken && !appToken)}
            >
              {busy === "save" ? "Saving…" : "Save tokens"}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <h4 className="text-sm font-medium text-fg">3 · Who can use it</h4>
        <p className="mt-1 text-xs text-fg-dim">
          Anyone listed here can run anything on this machine through the bot. Start detection, then
          send the bot a direct message from Slack and it will recognise you.
        </p>

        {userIds.length > 0 && (
          <ul className="mt-3 space-y-1">
            {userIds.map((id) => (
              <li key={id} className="flex items-center justify-between rounded bg-surface-2 px-3 py-2">
                <code className="text-xs text-fg">{id}</code>
                <Button onClick={() => removeUser(id)} disabled={busy !== null}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {view.allowedFromEnv && (
          <p className="mt-2 text-[11px] text-fg-dim">
            Currently from <code>SLACK_ALLOWED_USER_IDS</code> in .env. Changing the list here takes
            over.
          </p>
        )}

        <div className="mt-3 flex gap-2">
          {detect?.running ? (
            <Button onClick={stopDetect} disabled={busy !== null}>
              Stop detecting
            </Button>
          ) : (
            <Button
              onClick={startDetect}
              disabled={busy !== null || (!view.hasBotToken && !botToken)}
            >
              {busy === "detect" ? "Connecting…" : "Detect me from a DM"}
            </Button>
          )}
        </div>

        {detect?.running && (
          <p className="mt-2 text-xs text-fg-dim">
            Listening… open Slack and send the bot any direct message.
          </p>
        )}
        {detect?.warning && <p className="mt-2 text-xs text-danger">{detect.warning}</p>}
        {detect && detect.candidates.length > 0 && (
          <ul className="mt-2 space-y-1">
            {detect.candidates.map((c) => (
              <li key={c.id} className="flex items-center justify-between rounded bg-surface-2 px-3 py-2">
                <span className="text-xs text-fg">
                  {c.name} <code className="text-fg-dim">{c.id}</code>
                  {c.lastText && <span className="ml-2 text-fg-dim">“{c.lastText}”</span>}
                </span>
                <Button variant="primary" onClick={() => addUser(c.id)} disabled={busy !== null}>
                  That's me
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex gap-2">
          <Input
            placeholder="…or paste a member id (U0123456789)"
            value={manualId}
            onChange={(e) => setManualId(e.target.value)}
          />
          <Button
            onClick={() => {
              addUser(manualId);
              setManualId("");
            }}
            disabled={busy !== null || !manualId.trim()}
          >
            Add
          </Button>
        </div>
      </Card>

      {view.hasBotToken && view.hasAppToken && (
        <Card>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-medium text-fg">Surface</h4>
              <p className="mt-1 text-xs text-fg-dim">
                {view.enabled
                  ? "Slack is on. Commands use a ! prefix, so send !help in the DM."
                  : "Slack is off. The tokens are kept."}
              </p>
            </div>
            <Button
              variant={view.enabled ? "ghost" : "primary"}
              onClick={() => save({ enabled: !view.enabled })}
              disabled={busy !== null}
            >
              {view.enabled ? "Turn off" : "Turn on"}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
