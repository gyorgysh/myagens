/**
 * Per-connector onboarding help manifest.
 *
 * The actual copy (summary, credential label, setup steps, tool labels, tip)
 * lives in the i18n bundles (en.ts / hu.ts) so it translates with the UI. This
 * file only records the shape of each connector's help (how many steps and
 * tool labels it has, and whether it carries a tip) plus helpers to build the
 * matching translation keys. Connectors.tsx resolves the text through t().
 *
 * Key convention (per connector id, with dashes normalised to underscores):
 *   connectors_<id>_summary
 *   connectors_<id>_credential
 *   connectors_<id>_step_<n>       (n starts at 1)
 *   connectors_<id>_read_<n>
 *   connectors_<id>_write_<n>
 *   connectors_<id>_tip
 */

export interface ConnectorHelpShape {
  /** Number of ordered setup steps. */
  steps: number;
  /** Number of read-scope tool labels. */
  readTools: number;
  /** Number of write-scope tool labels (0 = no write scope). */
  writeTools: number;
  /** Whether a tip line is present. */
  tip: boolean;
}

/** Shape of the help content available for each connector id. */
export const CONNECTOR_HELP: Record<string, ConnectorHelpShape> = {
  notion: { steps: 5, readTools: 4, writeTools: 4, tip: true },
  gcal: { steps: 5, readTools: 3, writeTools: 3, tip: true },
  gmail: { steps: 4, readTools: 4, writeTools: 5, tip: true },
  gdrive: { steps: 4, readTools: 3, writeTools: 5, tip: true },
  "apple-calendar": { steps: 4, readTools: 3, writeTools: 3, tip: true },
  "apple-mail": { steps: 4, readTools: 3, writeTools: 2, tip: true },
  slack: { steps: 6, readTools: 3, writeTools: 3, tip: true },
  github: { steps: 6, readTools: 5, writeTools: 5, tip: true },
  jira: { steps: 5, readTools: 4, writeTools: 3, tip: true },
  linear: { steps: 4, readTools: 5, writeTools: 3, tip: true },
  "unreal-engine": { steps: 6, readTools: 4, writeTools: 4, tip: true },
  unity: { steps: 6, readTools: 4, writeTools: 4, tip: true },
  postgres: { steps: 4, readTools: 3, writeTools: 2, tip: true },
  sqlite: { steps: 3, readTools: 3, writeTools: 2, tip: true },
  recraft: { steps: 3, readTools: 1, writeTools: 0, tip: true },
  ideogram: { steps: 3, readTools: 1, writeTools: 0, tip: true },
  replicate: { steps: 3, readTools: 1, writeTools: 0, tip: true },
  fal: { steps: 3, readTools: 1, writeTools: 0, tip: true },
  local_sd: { steps: 3, readTools: 1, writeTools: 0, tip: true },
  bluesky: { steps: 4, readTools: 3, writeTools: 2, tip: true },
  mastodon: { steps: 4, readTools: 3, writeTools: 2, tip: true },
  discord: { steps: 5, readTools: 2, writeTools: 1, tip: true },
  reddit: { steps: 5, readTools: 3, writeTools: 2, tip: true },
  x: { steps: 5, readTools: 1, writeTools: 2, tip: true },
  youtube: { steps: 4, readTools: 3, writeTools: 4, tip: true },
  facebook: { steps: 5, readTools: 3, writeTools: 3, tip: true },
};

/** Normalise a connector id into the underscore form used in i18n keys. */
function keyBase(id: string): string {
  return `connectors_${id.replace(/-/g, "_")}`;
}

/** Build the i18n key names for a connector's help fields. */
export function connectorHelpKeys(id: string, shape: ConnectorHelpShape) {
  const base = keyBase(id);
  const range = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${base}_${prefix}_${i + 1}`);
  return {
    summary: `${base}_summary`,
    credential: `${base}_credential`,
    steps: range("step", shape.steps),
    readTools: range("read", shape.readTools),
    writeTools: range("write", shape.writeTools),
    tip: shape.tip ? `${base}_tip` : undefined,
  };
}
