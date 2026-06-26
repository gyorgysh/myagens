/**
 * TunnelManager — a singleton that exposes the local panel to the internet by
 * spawning a tunnel relay (ngrok or cloudflared) as a child process pointed at
 * the panel's loopback port. It captures the public URL from the relay's output
 * and streams status to all panel WebSocket clients.
 *
 * Same posture as ptyManager: a panel-token holder gets host-equivalent access,
 * and a public URL widens the attack surface, so the whole feature is gated by
 * PANEL_TUNNEL_ENABLED (off by default) and the relay only runs when the user
 * explicitly starts it from the Remote Access view.
 *
 * The relay binaries (`ngrok`, `cloudflared`) are NOT bundled; they must already
 * be installed on the host. If the binary is missing, start() reports an error
 * the panel surfaces as a "install the CLI" hint.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { log } from "../logger.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { resolveSecret, vault } from "./vault.js";

const STORE = "tunnel.json";

/** The HTTP Basic Auth username is fixed; only the password is user-rotatable. */
export const BASIC_AUTH_USER = "myhq";

export type TunnelProviderId = "ngrok" | "cloudflare";
export type TunnelState = "stopped" | "starting" | "running" | "error";

/** Persisted configuration for the remote-access tunnel. */
interface TunnelConfig {
  provider: TunnelProviderId;
  /** Auth token (plain or a `vault:<id>` reference). Optional for cloudflare quick tunnels. */
  authToken?: string;
  /** Optional reserved domain/hostname (paid ngrok / named cloudflare tunnel). */
  domain?: string;
  /** Auto-launch the relay at panel startup (so it survives reboots/updates). Default on. */
  autoStart?: boolean;
  /** HTTP Basic Auth gate in front of the tunnel (default on). Username is fixed to `myhq`. */
  basicAuth?: boolean;
  /** Vault reference (`vault:<id>`) to the Basic Auth password. Generated on first enable. */
  passwordRef?: string;
}

const DEFAULTS: TunnelConfig = {
  provider: "ngrok",
  authToken: "",
  domain: "",
  autoStart: true,
  basicAuth: true,
  passwordRef: "",
};

type BroadcastFn = (msg: unknown) => void;

/** A line-matcher that pulls the public https URL out of a relay's stdout/stderr. */
interface ProviderSpec {
  /** Build the argv for the relay, given the local port + resolved token/domain. */
  command(port: number, token: string | undefined, domain: string | undefined): { cmd: string; args: string[]; env: NodeJS.ProcessEnv };
  /** Try to extract a public URL from a single output line. */
  matchUrl(line: string): string | undefined;
}

const PROVIDERS: Record<TunnelProviderId, ProviderSpec> = {
  ngrok: {
    command(port, token, domain) {
      // `ngrok http <port>` writes the public URL to its log stream. We force
      // structured logging to stdout so it's parseable without the agent API.
      const args = ["http", String(port), "--log", "stdout", "--log-format", "logfmt"];
      if (domain) args.push("--domain", domain);
      const env = { ...process.env } as NodeJS.ProcessEnv;
      // Pass the authtoken via env so it never appears in the process args.
      if (token) env.NGROK_AUTHTOKEN = token;
      return { cmd: "ngrok", args, env };
    },
    matchUrl(line) {
      // logfmt line carries `url=https://xxxx.ngrok-free.app`.
      const m = line.match(/url=(https:\/\/[^\s"]+)/);
      return m?.[1];
    },
  },
  cloudflare: {
    command(port, _token, domain) {
      // Quick tunnel: `cloudflared tunnel --url http://localhost:<port>` prints a
      // trycloudflare.com URL. A named tunnel (domain) uses `run <name>` and the
      // hostname is configured in the cloudflare dashboard, so we just surface it.
      if (domain) {
        return { cmd: "cloudflared", args: ["tunnel", "run", domain], env: { ...process.env } };
      }
      return {
        cmd: "cloudflared",
        args: ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"],
        env: { ...process.env },
      };
    },
    matchUrl(line) {
      const m = line.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i);
      return m?.[1];
    },
  },
};

export interface TunnelView {
  /** Whether the feature is unlocked (PANEL_TUNNEL_ENABLED). */
  enabled: boolean;
  state: TunnelState;
  provider: TunnelProviderId;
  /** True when a token is configured (the plaintext is never returned). */
  hasToken: boolean;
  domain: string;
  /** Auto-launch the relay at startup (default on). */
  autoStart: boolean;
  /** HTTP Basic Auth gate is on (default on). */
  basicAuth: boolean;
  /** The fixed Basic Auth username. */
  basicAuthUser: string;
  /** True once a password has been generated/stored. */
  hasPassword: boolean;
  /** The public URL once the relay is up. */
  url?: string;
  error?: string;
  startedAt?: number;
}

export class TunnelManager {
  private broadcast: BroadcastFn = () => {};
  private cfg: TunnelConfig = { ...DEFAULTS };
  private proc: ChildProcess | null = null;
  private state: TunnelState = "stopped";
  private url: string | undefined;
  private error: string | undefined;
  private startedAt: number | undefined;
  /** Optional DM hook (injected by the bot) used to send a freshly generated password. */
  private notify: ((text: string) => void) | undefined;

  /** Wire a Telegram DM sink so generated/rotated passwords reach the owner. */
  setNotifier(fn: (text: string) => void): void {
    this.notify = fn;
  }

  /** Compose + send the "your remote access password" DM (best-effort). */
  private dmPassword(pw: string): void {
    if (!this.notify) return;
    this.notify(
      "🔐 *Remote access password*\n\n" +
        "Username: `" + BASIC_AUTH_USER + "`\n" +
        "Password: `" + pw + "`\n\n" +
        "Use these to log in when you open the tunnel link.",
    );
  }

  start(broadcast: BroadcastFn): void {
    this.broadcast = broadcast;
    this.cfg = { ...DEFAULTS, ...loadJson<Partial<TunnelConfig>>(STORE, {}) };
    if (!config.PANEL_TUNNEL_ENABLED) {
      log.info("[tunnel] remote access disabled (PANEL_TUNNEL_ENABLED=false)");
      return;
    }
    // Make sure a Basic Auth password exists before anything can go public, so the
    // tunnel is never exposed without the HTTP gate having a credential to check.
    if (this.cfg.basicAuth !== false) this.ensurePassword();
    // Persistent auto-start: bring the relay back after a reboot/update without a
    // manual click. start_relay() validates the config (e.g. ngrok needs a token)
    // and no-ops gracefully when it can't launch, so this is safe to call blindly.
    if (this.cfg.autoStart !== false) {
      const r = this.start_relay();
      if (!r.ok) log.info("[tunnel] auto-start skipped: " + r.error);
    }
  }

  get enabled(): boolean {
    return config.PANEL_TUNNEL_ENABLED;
  }

  view(): TunnelView {
    return {
      enabled: this.enabled,
      state: this.state,
      provider: this.cfg.provider,
      hasToken: Boolean(this.cfg.authToken && this.cfg.authToken.trim()),
      domain: this.cfg.domain ?? "",
      autoStart: this.cfg.autoStart !== false,
      basicAuth: this.cfg.basicAuth !== false,
      basicAuthUser: BASIC_AUTH_USER,
      hasPassword: Boolean(this.cfg.passwordRef && this.cfg.passwordRef.trim()),
      url: this.url,
      error: this.error,
      startedAt: this.startedAt,
    };
  }

  /** Persist config (provider / token / domain). A blank token keeps the existing one. */
  setConfig(patch: Partial<TunnelConfig>): TunnelView {
    if (patch.provider === "ngrok" || patch.provider === "cloudflare") {
      this.cfg.provider = patch.provider;
    }
    if (typeof patch.domain === "string") this.cfg.domain = patch.domain.trim();
    if (typeof patch.autoStart === "boolean") this.cfg.autoStart = patch.autoStart;
    if (typeof patch.basicAuth === "boolean") this.cfg.basicAuth = patch.basicAuth;
    // A blank token means "leave the saved one alone" (matches the providers UX).
    if (typeof patch.authToken === "string" && patch.authToken.trim()) {
      this.cfg.authToken = patch.authToken.trim();
    }
    saveJson(STORE, this.cfg);
    return this.view();
  }

  /**
   * Make sure a Basic Auth password exists, generating + vaulting one on first use.
   * Returns the plaintext when it was just generated (so the panel/Telegram can
   * show it once), or `null` if one already existed (we never re-reveal silently).
   */
  ensurePassword(): string | null {
    if (this.cfg.passwordRef && this.cfg.passwordRef.trim()) return null;
    const pw = randomBytes(12).toString("base64url"); // ~16 chars, URL-safe
    const secret = vault.create({ name: "Remote access password", value: pw, description: "Tunnel HTTP Basic Auth (user: " + BASIC_AUTH_USER + ")" });
    this.cfg.passwordRef = "vault:" + secret.id;
    saveJson(STORE, this.cfg);
    log.info("[tunnel] generated Basic Auth password");
    this.dmPassword(pw);
    return pw;
  }

  /** Rotate the Basic Auth password to a fresh random value; returns the new plaintext. */
  rotatePassword(): string {
    const pw = randomBytes(12).toString("base64url");
    const secret = vault.create({ name: "Remote access password", value: pw, description: "Tunnel HTTP Basic Auth (user: " + BASIC_AUTH_USER + ")" });
    this.cfg.passwordRef = "vault:" + secret.id;
    saveJson(STORE, this.cfg);
    log.info("[tunnel] rotated Basic Auth password");
    return pw;
  }

  /** Set the Basic Auth password to a user-chosen value; returns true on success. */
  setPassword(plain: string): boolean {
    const pw = plain.trim();
    if (pw.length < 6) return false;
    const secret = vault.create({ name: "Remote access password", value: pw, description: "Tunnel HTTP Basic Auth (user: " + BASIC_AUTH_USER + ")" });
    this.cfg.passwordRef = "vault:" + secret.id;
    saveJson(STORE, this.cfg);
    log.info("[tunnel] Basic Auth password updated");
    return true;
  }

  /** Reveal the current Basic Auth password (panel "show" action). */
  revealPassword(): string | undefined {
    if (!this.cfg.passwordRef) return undefined;
    return resolveSecret(this.cfg.passwordRef) || undefined;
  }

  /** Whether the Basic Auth gate is active (feature on, gate on, password set). */
  get basicAuthActive(): boolean {
    return this.enabled && this.cfg.basicAuth !== false && Boolean(this.cfg.passwordRef);
  }

  /**
   * Verify an HTTP `Authorization: Basic` header against the configured creds.
   * Constant-time compare on both fields. Returns false when the gate is inactive
   * is decided by the caller — this only validates the credentials themselves.
   */
  verifyBasic(authHeader: string | undefined): boolean {
    if (!authHeader || !authHeader.startsWith("Basic ")) return false;
    let decoded: string;
    try {
      decoded = Buffer.from(authHeader.slice(6).trim(), "base64").toString("utf8");
    } catch {
      return false;
    }
    const i = decoded.indexOf(":");
    if (i < 0) return false;
    const user = decoded.slice(0, i);
    const pass = decoded.slice(i + 1);
    const expectedPass = this.cfg.passwordRef ? resolveSecret(this.cfg.passwordRef) : "";
    if (!expectedPass) return false;
    return safeEqual(user, BASIC_AUTH_USER) && safeEqual(pass, expectedPass);
  }

  /** Launch the relay. Returns the (initial) view; the URL arrives asynchronously. */
  start_relay(): { ok: true } | { ok: false; error: string } {
    if (!this.enabled) return { ok: false, error: "remote access disabled" };
    if (this.proc) return { ok: false, error: "already running" };

    const port = config.PANEL_PORT;
    const spec = PROVIDERS[this.cfg.provider];
    const token = this.cfg.authToken ? resolveSecret(this.cfg.authToken) : undefined;
    if (this.cfg.provider === "ngrok" && !token) {
      return { ok: false, error: "ngrok needs an auth token (get one from ngrok.com)" };
    }
    const domain = this.cfg.domain || undefined;
    const { cmd, args, env } = spec.command(port, token, domain);

    log.info("[tunnel] starting relay", { provider: this.cfg.provider, cmd, port });
    this.error = undefined;
    this.url = undefined;
    this.setState("starting");

    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const msg = `failed to launch ${cmd}: ${(e as Error).message}`;
      this.fail(msg);
      return { ok: false, error: msg };
    }
    this.proc = proc;
    this.startedAt = Date.now();

    const onLine = (line: string) => {
      const url = spec.matchUrl(line);
      if (url && !this.url) {
        this.url = url;
        this.setState("running");
        log.info("[tunnel] public URL up", { url });
      }
    };
    const feed = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) if (line.trim()) onLine(line);
    };
    proc.stdout?.on("data", feed);
    proc.stderr?.on("data", feed);

    proc.on("error", (e) => {
      // ENOENT = binary not installed.
      const msg =
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? `${cmd} is not installed on the host — install it first`
          : `${cmd} error: ${e.message}`;
      this.fail(msg);
    });
    proc.on("exit", (code) => {
      // A clean stop() nulls the proc first, so this only fires on an unexpected exit.
      if (this.proc === proc) {
        if (this.state !== "error") {
          this.fail(code === 0 ? "relay exited" : `relay exited with code ${code}`);
        }
        this.proc = null;
      }
    });

    return { ok: true };
  }

  /** Stop the relay and reset to stopped. */
  stop(): void {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
    }
    this.url = undefined;
    this.startedAt = undefined;
    this.error = undefined;
    this.setState("stopped");
  }

  /** Kill on shutdown without broadcasting (process is exiting). */
  kill(): void {
    if (this.proc) {
      try { this.proc.kill("SIGTERM"); } catch { /* ignore */ }
      this.proc = null;
    }
  }

  private fail(error: string): void {
    this.error = error;
    log.warn("[tunnel] " + error);
    this.setState("error");
  }

  private setState(state: TunnelState): void {
    this.state = state;
    try {
      this.broadcast({ type: "tunnel", view: this.view() });
    } catch { /* no clients */ }
  }
}

/** Constant-time string compare (length-safe) to avoid timing leaks on the gate. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const tunnelManager = new TunnelManager();
