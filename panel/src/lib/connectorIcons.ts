import {
  siNotion,
  siGithub,
  siGmail,
  siGoogledrive,
  siGooglecalendar,
  siApple,
  siJira,
  siLinear,
  siUnity,
  siUnrealengine,
  siPostgresql,
  siSqlite,
  siReplicate,
  siBluesky,
  siMastodon,
  siDiscord,
  siReddit,
  siX,
  siYoutube,
  siFacebook,
} from "simple-icons";
import { PenTool, Type, Zap, HardDrive, type LucideIcon } from "lucide-react";

export type ConnectorIcon = {
  path: string;
  hex: string;
  title: string;
  /**
   * True for brand marks that are just black/white ink with no real brand
   * colour (Notion, GitHub, Apple, Unity, Unreal, SQLite). These render with
   * currentColor so they follow the text colour and stay visible across the
   * light, dark, and Matrix themes instead of vanishing into the background.
   */
  monochrome?: boolean;
};

/** Connector ids whose brand mark is monochrome ink (no distinct brand hue). */
const MONOCHROME_IDS = new Set([
  "notion",
  "github",
  "apple-calendar",
  "apple-mail",
  "unity",
  "unreal-engine",
  "sqlite",
  "x",
]);

// Slack was removed from simple-icons v15+; use a hand-drawn minimal path.
const siSlackPath =
  "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z";

const SLACK_ICON: ConnectorIcon = {
  path: siSlackPath,
  hex: "4A154B",
  title: "Slack",
};

const ICON_MAP: Record<string, ConnectorIcon> = {
  notion: siNotion,
  github: siGithub,
  gmail: siGmail,
  gdrive: siGoogledrive,
  gcal: siGooglecalendar,
  "apple-calendar": siApple,
  "apple-mail": siApple,
  jira: siJira,
  linear: siLinear,
  slack: SLACK_ICON,
  unity: siUnity,
  "unreal-engine": siUnrealengine,
  postgres: siPostgresql,
  sqlite: siSqlite,
  replicate: siReplicate,
  bluesky: siBluesky,
  mastodon: siMastodon,
  discord: siDiscord,
  reddit: siReddit,
  x: siX,
  youtube: siYoutube,
  facebook: siFacebook,
};

export function getConnectorIcon(id: string): ConnectorIcon | undefined {
  const icon = ICON_MAP[id];
  if (!icon) return undefined;
  return MONOCHROME_IDS.has(id) ? { ...icon, monochrome: true } : icon;
}

/**
 * Fallback glyph for connectors with no real brand mark in `simple-icons`
 * (small/newer AI image APIs). Not a logo — a themed Lucide icon + accent
 * colour that hints at what the service does, so the card still reads at a
 * glance instead of showing blank space.
 */
export type ConnectorFallbackIcon = { Icon: LucideIcon; hex: string };

const FALLBACK_ICON_MAP: Record<string, ConnectorFallbackIcon> = {
  recraft: { Icon: PenTool, hex: "6E56CF" }, // vector/icon illustration
  ideogram: { Icon: Type, hex: "1A1A1A" }, // rendered-text-in-image
  fal: { Icon: Zap, hex: "7C3AED" }, // fast inference
  local_sd: { Icon: HardDrive, hex: "10B981" }, // self-hosted/local server
};

export function getConnectorFallbackIcon(id: string): ConnectorFallbackIcon | undefined {
  return FALLBACK_ICON_MAP[id];
}
