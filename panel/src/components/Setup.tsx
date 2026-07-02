import { useEffect, useState } from "react";
import { api, AuthError, type MainAgent } from "../api.ts";
import { Badge, Button, Card } from "./ui.tsx";
import { useI18n } from "../lib/useI18n.ts";
import type { Tab } from "./Sidebar.tsx";

type Me = Awaited<ReturnType<typeof api.me>>;

/** Upstream repo, matching the footer link in App.tsx — used for the changelog. */
const REPO_URL = "https://github.com/gyorgysh/myagens";

/**
 * A single top-level "Setup" view that walks a new operator through initial
 * configuration in a logical order — bot identity → access control → model →
 * panel access → remote access — and gives a returning user one place to find
 * every config knob without hunting through the nav.
 *
 * Several of these (bot token, allowed user IDs, panel token) live in `.env`
 * and are NOT editable from the panel by design (a panel-token holder must not
 * be able to widen the allow-list or rotate the bot from the browser). They are
 * shown here read-only with guidance. The editable bits (model, persona,
 * autonomy, providers, remote access) link out to their existing views so we
 * keep a single source of truth instead of duplicating the editors.
 */
export function SetupView({
  onAuthError,
  onGoto,
}: {
  onAuthError: () => void;
  onGoto: (t: Tab | "settings") => void;
}) {
  const { t } = useI18n();
  const [me, setMe] = useState<Me | null>(null);
  const [agent, setAgent] = useState<MainAgent | null>(null);

  useEffect(() => {
    api.me().then(setMe).catch((e) => e instanceof AuthError && onAuthError());
    api
      .agent()
      .then(setAgent)
      .catch((e) => e instanceof AuthError && onAuthError());
  }, [onAuthError]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-fg">{t("setup_title")}</h1>
        <p className="mt-1 text-sm text-fg-dim">{t("setup_desc")}</p>
      </div>

      {/* 1. Bot identity */}
      <SetupStep n={1} title={t("setup_identity")} desc={t("setup_identity_desc")}>
        <Fact label={t("setup_agent_name")} value={me?.atlasName || "Atlas"} />
        <Fact label={t("setup_brand_name")} value={me?.brandName || "MyAgens"} />
        <Fact
          label={t("setup_bot_username")}
          value={
            agent?.botUsername ? (
              <a
                href={`https://t.me/${agent.botUsername}`}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                @{agent.botUsername}
              </a>
            ) : (
              <span className="text-fg-faint">{t("setup_unknown")}</span>
            )
          }
        />
        <Fact
          label={t("setup_version")}
          value={
            me ? (
              <span className="flex items-center gap-2">
                <Badge tone={me.updateAvailable ? "amber" : "green"}>v{me.version}</Badge>
                <a
                  href={`${REPO_URL}/blob/main/CHANGELOG.md`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline"
                >
                  {t("setup_changelog")} ↗
                </a>
              </span>
            ) : (
              "…"
            )
          }
        />
        <EnvNote text={t("setup_identity_env")} />
      </SetupStep>

      {/* 2. Access control */}
      <SetupStep n={2} title={t("setup_access")} desc={t("setup_access_desc")}>
        <Fact
          label={t("setup_allowed_users")}
          value={
            me ? (
              <Badge tone={me.allowedUserCount > 0 ? "green" : "amber"}>
                {me.allowedUserCount}
              </Badge>
            ) : (
              "…"
            )
          }
        />
        <EnvNote text={t("setup_access_env")} />
      </SetupStep>

      {/* 3. Model */}
      <SetupStep n={3} title={t("setup_model")} desc={t("setup_model_desc")}>
        <Fact
          label={t("setup_active_model")}
          value={
            agent ? (
              <Badge tone="blue">{agent.effectiveModel}</Badge>
            ) : (
              "…"
            )
          }
        />
        <Fact
          label={t("setup_provider")}
          value={agent?.providerName || t("settings_anthropic_default")}
        />
        <div className="pt-1">
          <Button onClick={() => onGoto("settings")}>{t("setup_open_settings")}</Button>
        </div>
      </SetupStep>

      {/* 4. Panel access */}
      <SetupStep n={4} title={t("setup_panel")} desc={t("setup_panel_desc")}>
        <Fact
          label={t("setup_panel_bind")}
          value={me ? `${me.panelHost}:${me.panelPort}` : "…"}
        />
        <Fact
          label={t("setup_terminal")}
          value={
            me ? (
              <Badge tone={me.terminalEnabled ? "green" : "zinc"}>
                {me.terminalEnabled ? t("setup_enabled") : t("setup_disabled")}
              </Badge>
            ) : (
              "…"
            )
          }
        />
        <EnvNote text={t("setup_panel_env")} />
      </SetupStep>

      {/* 5. Remote access */}
      <SetupStep n={5} title={t("setup_remote")} desc={t("setup_remote_desc")}>
        <Fact
          label={t("setup_remote_status")}
          value={
            me ? (
              <Badge tone={me.tunnelEnabled ? "green" : "zinc"}>
                {me.tunnelEnabled ? t("setup_enabled") : t("setup_disabled")}
              </Badge>
            ) : (
              "…"
            )
          }
        />
        {me?.tunnelEnabled ? (
          <div className="pt-1">
            <Button onClick={() => onGoto("remote")}>{t("setup_open_remote")}</Button>
          </div>
        ) : (
          <EnvNote text={t("setup_remote_env")} />
        )}
      </SetupStep>

      {/* 6. You're ready — the payoff moment */}
      <ReadyStep botUsername={agent?.botUsername} />
    </div>
  );
}

/**
 * The closing "aha" step: setup is done, now actually talk to the bot. Surfaces
 * the exact Telegram deep-link (https://t.me/<bot>) and a copyable sample first
 * prompt, so a user who just finished config doesn't stall wondering what's next.
 */
function ReadyStep({ botUsername }: { botUsername?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const sample = t("setup_ready_sample");

  const copy = () => {
    void navigator.clipboard?.writeText(sample).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="rounded-xl border border-accent/40 bg-accent/10 p-5">
      <div className="flex items-start gap-3">
        <span className="text-2xl leading-none" aria-hidden>
          🎉
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-fg">{t("setup_ready")}</h3>
          <p className="mt-1 text-sm text-fg-dim">{t("setup_ready_desc")}</p>

          {botUsername ? (
            <>
              <a
                href={`https://t.me/${botUsername}`}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition-opacity hover:opacity-90"
              >
                {t("setup_ready_open")}
                <span className="text-fg-faint">@{botUsername}</span>
              </a>

              <div className="mt-4 rounded-lg border border-line bg-surface-2 p-3">
                <p className="text-xs text-fg-dim">{t("setup_ready_sample_label")}</p>
                <div className="mt-1.5 flex items-center justify-between gap-3">
                  <code className="min-w-0 break-words text-sm text-fg">{sample}</code>
                  <button
                    onClick={copy}
                    className="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-fg-dim transition-colors hover:bg-surface hover:text-fg"
                  >
                    {copied ? t("setup_ready_copied") : t("setup_ready_copy")}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <EnvNote text={t("setup_ready_no_bot")} />
          )}
        </div>
      </div>
    </div>
  );
}

/** A numbered configuration step card. */
function SetupStep({
  n,
  title,
  desc,
  children,
}: {
  n: number;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2 normal-case">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">
            {n}
          </span>
          {title}
        </span>
      }
    >
      <p className="mb-3 text-sm text-fg-dim">{desc}</p>
      <div className="space-y-2">{children}</div>
    </Card>
  );
}

/** A labelled read-only fact row. */
function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-fg-dim">{label}</span>
      <span className="text-fg">{value}</span>
    </div>
  );
}

/** A muted note explaining a setting is .env-sourced and not panel-editable. */
function EnvNote({ text }: { text: string }) {
  return (
    <p className="mt-2 border-t border-line pt-2 text-xs text-fg-faint">{text}</p>
  );
}
