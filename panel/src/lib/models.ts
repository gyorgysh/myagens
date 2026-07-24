/**
 * Built-in Anthropic model suggestions shown in every model picker in the panel
 * (main agent settings, worker editor, add-agent wizard). These are convenience
 * defaults only — any model id can still be typed by hand, and provider-backed
 * pickers merge in models fetched live from the provider.
 *
 * Keep this list in sync with the Telegram bot's MODEL_SHORTCUTS in
 * src/commands.ts so both surfaces offer the same quick picks.
 */
export const MODEL_SUGGESTIONS = [
  "claude-opus-5",
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-8",
];
