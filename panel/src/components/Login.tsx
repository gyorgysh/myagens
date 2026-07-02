import { useState } from "react";
import { checkToken, setToken } from "../api.ts";
import { useI18n } from "../lib/useI18n.ts";

/** One cube of the fleet, drawn with the same geometry as the app icon.
 *  Facet colors come from the .cube-* classes so they follow the theme. */
function Cube({ transform }: { transform: string }) {
  return (
    <g transform={transform}>
      <path className="cube-top" d="M32 16 50 26.5 32 37 14 26.5 Z" />
      <path className="cube-left" d="M14 26.5 32 37 V53 L14 42.5 Z" />
      <path className="cube-right" d="M50 26.5 32 37 V53 L50 42.5 Z" />
    </g>
  );
}

/** A signal-colored flash overlaid on a cube's top face, timed via SMIL to
 *  light up when a command "arrives". */
function FaceFlash({ transform, times }: { transform: string; times: [number, number, number] }) {
  const [a, b, c] = times;
  return (
    <path
      className="anim-only"
      transform={transform}
      d="M32 16 50 26.5 32 37 14 26.5 Z"
      fill="var(--signal)"
      opacity="0"
    >
      <animate
        attributeName="opacity"
        dur="5.6s"
        repeatCount="indefinite"
        values="0;0;0.5;0;0"
        keyTimes={`0;${a};${b};${c};1`}
      />
    </path>
  );
}

/** A dot that travels one leg of the command chain. `go`/`arrive` are
 *  fractions of the shared 5.6s cycle, so every leg stays in sync. */
function SignalDot({ path, go, arrive }: { path: string; go: number; arrive: number }) {
  const fadeIn = go + 0.02;
  const fadeOut = arrive - 0.02;
  return (
    <circle className="anim-only" r="3.2" fill="var(--signal)" opacity="0">
      <animateMotion
        dur="5.6s"
        repeatCount="indefinite"
        calcMode="linear"
        keyPoints={`0;0;1;1`}
        keyTimes={`0;${go};${arrive};1`}
        path={path}
      />
      <animate
        attributeName="opacity"
        dur="5.6s"
        repeatCount="indefinite"
        values="0;0;1;1;0;0"
        keyTimes={`0;${go};${fadeIn};${fadeOut};${arrive};1`}
      />
    </circle>
  );
}

/** The animated chain-of-command scene: you message Atlas, Atlas relays to the
 *  fleet. Pure SVG + SMIL — no scripts, safe under the panel's strict CSP. */
function FleetScene() {
  return (
    <svg
      viewBox="0 0 340 236"
      className="w-full max-w-[21rem]"
      aria-hidden="true"
      role="presentation"
    >
      {/* Command routes */}
      <path className="fleet-line" strokeWidth="1.2" d="M66 52 C 96 56, 118 70, 143 87" />
      <path className="fleet-line" strokeWidth="1.2" d="M166 130 C 130 148, 100 162, 78 179" />
      <path className="fleet-line" strokeWidth="1.2" d="M170 138 C 170 155, 170 172, 170 191" />
      <path className="fleet-line" strokeWidth="1.2" d="M174 130 C 210 148, 240 162, 262 179" />

      {/* You — the president's phone */}
      <rect x="36" y="28" width="30" height="46" rx="7" fill="var(--surface)" stroke="var(--line)" strokeWidth="1.5" />
      <rect x="42" y="37" width="14" height="4.5" rx="2.25" fill="var(--signal)" />
      <rect x="42" y="45" width="9" height="3.5" rx="1.75" fill="var(--fg-faint)" opacity="0.5" />

      {/* Ground shadow + Atlas */}
      <ellipse className="cube-shadow" cx="170" cy="146" rx="52" ry="10" />
      <Cube transform="translate(112.4,41.9) scale(1.8)" />

      {/* Arrival ping above Atlas */}
      <circle className="anim-only" cx="170" cy="78" r="6" fill="none" stroke="var(--signal)" strokeWidth="1.6" opacity="0">
        <animate attributeName="r" dur="5.6s" repeatCount="indefinite" values="5;5;22;22" keyTimes="0;0.17;0.29;1" />
        <animate attributeName="opacity" dur="5.6s" repeatCount="indefinite" values="0;0;0.7;0;0" keyTimes="0;0.17;0.19;0.29;1" />
      </circle>
      <FaceFlash transform="translate(112.4,41.9) scale(1.8)" times={[0.16, 0.2, 0.28]} />

      {/* The fleet */}
      <Cube transform="translate(49.4,168.4) scale(0.8)" />
      <Cube transform="translate(144.4,180.4) scale(0.8)" />
      <Cube transform="translate(239.4,168.4) scale(0.8)" />
      <FaceFlash transform="translate(49.4,168.4) scale(0.8)" times={[0.36, 0.4, 0.48]} />
      <FaceFlash transform="translate(144.4,180.4) scale(0.8)" times={[0.39, 0.43, 0.51]} />
      <FaceFlash transform="translate(239.4,168.4) scale(0.8)" times={[0.42, 0.46, 0.54]} />

      {/* The command moving through the chain */}
      <SignalDot path="M66 52 C 96 56, 118 70, 143 87" go={0.02} arrive={0.17} />
      <SignalDot path="M166 130 C 130 148, 100 162, 78 179" go={0.24} arrive={0.38} />
      <SignalDot path="M170 138 C 170 155, 170 172, 170 191" go={0.27} arrive={0.41} />
      <SignalDot path="M174 130 C 210 148, 240 162, 262 179" go={0.3} arrive={0.44} />
    </svg>
  );
}

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const { t } = useI18n();
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
        setError(t("login_invalid"));
        return;
      }
      setToken(value.trim());
      onAuthed();
    } catch {
      setError(t("login_unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-full flex-col items-center justify-center overflow-hidden p-6">
      <div aria-hidden className="login-ambient absolute inset-0" />

      <div className="relative z-10 flex w-full max-w-sm flex-col items-center">
        <FleetScene />
        <p className="mono-xs mt-1 text-fg-faint">{t("login_tagline")}</p>

        <h1 className="mono mt-7 text-2xl font-semibold text-fg">
          <span className="text-accent">%</span> MyAgens
          <span className="ml-0.5 animate-pulse text-signal">▮</span>
        </h1>
        <p className="mono-xs mt-2 uppercase tracking-[0.25em] text-fg-dim">
          {t("login_kicker")}
        </p>

        <form
          onSubmit={submit}
          className="mt-6 w-full rounded-2xl border border-line bg-surface/80 p-6 shadow-xl backdrop-blur"
        >
          <p className="text-sm text-fg-muted">{t("login_desc")}</p>
          <input
            type="password"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="PANEL_TOKEN"
            aria-label={t("login_title")}
            className="mono mt-3 w-full rounded-lg border border-line bg-input px-3 py-2.5 text-sm text-fg outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          {error && <p className="mt-2 text-sm text-critical-fg">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="mt-3 w-full rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          >
            {busy ? t("checking") : t("login_unlock")}
          </button>
          <p className="mt-3 text-xs leading-relaxed text-fg-faint">{t("login_hint")}</p>
        </form>

        <p className="mono-xs mt-7 uppercase tracking-widest text-fg-faint">
          {t("login_footer")}
        </p>
      </div>
    </div>
  );
}
