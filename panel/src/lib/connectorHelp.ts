/**
 * Per-connector onboarding help: what the connector does in plain English,
 * step-by-step setup instructions, and a summary of what tools become available.
 * Kept as static data so it loads without a network round-trip.
 */

export interface ConnectorHelp {
  /** One-sentence plain-English summary of what this connector unlocks. */
  summary: string;
  /** What credential format is expected, in friendly terms. */
  credentialLabel: string;
  /** Ordered setup steps shown as a numbered list. */
  steps: string[];
  /** Read-scope tools that become available (short labels). */
  readTools: string[];
  /** Extra tools added on top of read when write scope is enabled. */
  writeTools: string[];
  /** Optional tip shown below the steps. */
  tip?: string;
}

export const CONNECTOR_HELP: Record<string, ConnectorHelp> = {
  notion: {
    summary: "Lets your agents search, read, and create pages and database entries in your Notion workspace.",
    credentialLabel: "Notion integration token (starts with ntn_ or secret_)",
    steps: [
      "Go to notion.so/my-integrations and click \"New integration\".",
      "Give it a name (e.g. MyHQ), select your workspace, and click Submit.",
      "Copy the \"Internal Integration Token\" shown on the next screen.",
      "Open each Notion page or database you want to share, click ··· > Connections, and add your integration.",
      "Paste the token into the vault as a new secret, then attach it here.",
    ],
    readTools: ["Search pages", "Read page content", "Query databases", "List database entries"],
    writeTools: ["Create pages", "Update page content", "Create database entries", "Update database entries"],
    tip: "Only pages you explicitly share with the integration are visible — it cannot see your entire workspace by default.",
  },

  gcal: {
    summary: "Lets your agents list upcoming events and create new ones on your Google Calendar.",
    credentialLabel: "Google OAuth access token (requires calendar scope)",
    steps: [
      "Go to console.cloud.google.com, create a project, and enable the Google Calendar API.",
      "Under APIs & Services > Credentials, create an OAuth 2.0 client ID (Desktop app).",
      "Use the OAuth Playground (developers.google.com/oauthplayground) or a local script to exchange the client credentials for an access token with the scope https://www.googleapis.com/auth/calendar.",
      "Copy the access token (and refresh token if you want long-lived access).",
      "Paste it into the vault, then attach it here.",
    ],
    readTools: ["List calendars", "List upcoming events", "Get event details"],
    writeTools: ["Create events", "Update events", "Delete events"],
    tip: "Google OAuth tokens expire after 1 hour. Store the refresh token alongside the access token so the connector can renew automatically.",
  },

  gmail: {
    summary: "Lets your agents read, search, draft, send, label, and delete Gmail messages.",
    credentialLabel: "Google OAuth access token (gmail + gmail.send scope)",
    steps: [
      "Go to console.cloud.google.com, create a project, and enable the Gmail API.",
      "Under APIs & Services > Credentials, create an OAuth 2.0 client ID (Desktop app).",
      "Obtain an access token with the scopes https://www.googleapis.com/auth/gmail.modify and https://www.googleapis.com/auth/gmail.send.",
      "Paste the token into the vault, then attach it here.",
    ],
    readTools: ["List messages", "Read message content", "Search messages", "List labels"],
    writeTools: ["Send email", "Draft email", "Apply labels", "Move to trash", "Delete permanently"],
    tip: "For read-only access you can use the narrower scope https://www.googleapis.com/auth/gmail.readonly and keep write scope off.",
  },

  gdrive: {
    summary: "Lets your agents browse, read, create, update, move, share, and delete files on Google Drive.",
    credentialLabel: "Google OAuth access token (drive scope)",
    steps: [
      "Go to console.cloud.google.com, create a project, and enable the Google Drive API.",
      "Under APIs & Services > Credentials, create an OAuth 2.0 client ID (Desktop app).",
      "Obtain an access token with the scope https://www.googleapis.com/auth/drive.",
      "Paste the token into the vault, then attach it here.",
    ],
    readTools: ["List files and folders", "Read file content", "Search Drive"],
    writeTools: ["Create files", "Update file content", "Move files", "Share files", "Delete files"],
    tip: "Use https://www.googleapis.com/auth/drive.readonly for a safer read-only setup.",
  },

  "apple-calendar": {
    summary: "Lets your agents read and manage events on your iCloud calendars via CalDAV.",
    credentialLabel: "iCloud email and app-specific password (format: email:password)",
    steps: [
      "Sign in at appleid.apple.com and go to Sign-In and Security > App-Specific Passwords.",
      "Click the + button, give the password a label (e.g. MyHQ), and copy the generated password.",
      "Format the credential as your-email@icloud.com:xxxx-xxxx-xxxx-xxxx.",
      "Paste it into the vault, then attach it here.",
    ],
    readTools: ["List calendars", "List events", "Get event details"],
    writeTools: ["Create events", "Update events", "Delete events"],
    tip: "App-specific passwords bypass Two-Factor Authentication safely — your main Apple ID password is never exposed.",
  },

  "apple-mail": {
    summary: "Lets your agents read, search, and send iCloud email via IMAP and SMTP.",
    credentialLabel: "iCloud email and app-specific password (format: email:password)",
    steps: [
      "Sign in at appleid.apple.com and go to Sign-In and Security > App-Specific Passwords.",
      "Click the + button, give the password a label (e.g. MyHQ), and copy the generated password.",
      "Format the credential as your-email@icloud.com:xxxx-xxxx-xxxx-xxxx.",
      "Paste it into the vault, then attach it here.",
    ],
    readTools: ["List folders", "Read messages", "Search messages"],
    writeTools: ["Send email", "Delete messages"],
    tip: "Make sure IMAP access is enabled in your iCloud Mail settings (icloud.com > Mail > Settings > Preferences).",
  },

  slack: {
    summary: "Lets your agents read Slack channels and messages, and post replies, threads, and file uploads.",
    credentialLabel: "Slack bot token (starts with xoxb-)",
    steps: [
      "Go to api.slack.com/apps and click \"Create New App\" > \"From scratch\".",
      "Name the app (e.g. MyHQ) and select your workspace.",
      "Under OAuth & Permissions, add the Bot Token Scopes: channels:read, channels:history, chat:write, files:write, search:read.",
      "Click \"Install to Workspace\" and authorise.",
      "Copy the Bot User OAuth Token (starts with xoxb-) from the OAuth & Permissions page.",
      "Paste it into the vault, then attach it here, and invite the bot to the channels you want it to access (/invite @MyHQ).",
    ],
    readTools: ["List channels", "Read messages", "Search messages"],
    writeTools: ["Post messages", "Reply in threads", "Upload files"],
    tip: "The bot only sees channels it has been invited to — it cannot read private channels it has not joined.",
  },

  github: {
    summary: "Lets your agents browse repos, issues, and pull requests, read files, create issues, open PRs, and push commits.",
    credentialLabel: "GitHub personal access token (classic ghp_… or fine-grained)",
    steps: [
      "Go to github.com > Settings > Developer settings > Personal access tokens.",
      "Choose \"Fine-grained tokens\" for tighter scope, or \"Tokens (classic)\" for broad access.",
      "For fine-grained: select the repositories to grant access and enable Contents (read/write), Issues (read/write), and Pull requests (read/write).",
      "For classic: tick repo (full access) or use more specific scopes.",
      "Generate the token and copy it immediately (it is only shown once).",
      "Paste it into the vault, then attach it here.",
    ],
    readTools: ["List repos", "List issues", "List pull requests", "Read file contents", "List branches"],
    writeTools: ["Create issues", "Comment on issues", "Open pull requests", "Push files", "Create branches"],
    tip: "Fine-grained tokens are more secure — they limit access to specific repos and expire on a schedule you set.",
  },

  "unreal-engine": {
    summary: "Lets your agents control a running Unreal Engine 5.8+ editor via the built-in MCP plugin.",
    credentialLabel: "Optional: editor MCP URL (default is http://127.0.0.1:8000/mcp)",
    steps: [
      "Open your Unreal Engine 5.8+ project.",
      "In the Editor, go to Edit > Plugins, search for \"MCP\", and enable the Model Context Protocol plugin.",
      "Restart the editor when prompted.",
      "The MCP server starts automatically on port 8000. No credential is needed unless you changed the port.",
      "If you changed the port, enter the full URL (e.g. http://127.0.0.1:9000/mcp) as the credential in the vault.",
      "Enable the connector here — no credential is required for the default setup.",
    ],
    readTools: ["List actors", "Get actor properties", "Read blueprint graph", "List assets"],
    writeTools: ["Spawn actors", "Set actor properties", "Execute console commands", "Manage blueprints"],
    tip: "This connector talks to your local editor only — it will not work unless the Unreal Editor is open with the MCP plugin enabled.",
  },

  unity: {
    summary: "Lets your agents control a running Unity Editor via the mcp-unity package.",
    credentialLabel: "Absolute path to the mcp-unity server script (index.js in the package cache)",
    steps: [
      "In Unity, open Window > Package Manager, click the + button, and choose \"Add package from git URL\".",
      "Enter com.gamelovers.mcp-unity and install the package.",
      "After installation, find the package in the cache folder: Library/PackageCache/com.gamelovers.mcp-unity@<hash>/Server~/build/index.js.",
      "Copy the absolute path to that index.js file.",
      "Paste the path into the vault as a new secret, then attach it here.",
      "Make sure Node.js 18 or later is installed on your machine.",
    ],
    readTools: ["List GameObjects", "Read component values", "List assets", "Read scene hierarchy"],
    writeTools: ["Create GameObjects", "Set component values", "Run Editor commands", "Manage prefabs"],
    tip: "The path to index.js changes when the package version updates — update the vault secret after upgrading mcp-unity.",
  },

  postgres: {
    summary: "Lets your agents inspect and query a PostgreSQL database — list tables, describe schemas, and run SQL.",
    credentialLabel: "PostgreSQL connection string (postgresql://user:password@host:5432/dbname)",
    steps: [
      "Locate or create a PostgreSQL user with SELECT access to the tables you want to expose.",
      "Format the connection string as postgresql://username:password@hostname:5432/database.",
      "For a local database with default settings: postgresql://postgres:yourpassword@localhost:5432/mydb.",
      "Paste the connection string into the vault, then attach it here.",
    ],
    readTools: ["List tables", "Describe schema", "Run SELECT queries"],
    writeTools: ["INSERT, UPDATE, DELETE statements", "CREATE and DROP statements"],
    tip: "Use a dedicated read-only database user with the read scope for safety. The write scope allows any SQL, so restrict it to trusted agents.",
  },

  sqlite: {
    summary: "Lets your agents inspect and query a local SQLite database file.",
    credentialLabel: "Absolute path to the SQLite database file (e.g. /path/to/app.db)",
    steps: [
      "Find the SQLite database file on your machine (usually ends in .db or .sqlite).",
      "Copy its absolute path (e.g. /Users/you/projects/myapp/data.db).",
      "Paste the path into the vault as a new secret, then attach it here.",
    ],
    readTools: ["List tables", "Describe schema", "Run SELECT queries"],
    writeTools: ["INSERT, UPDATE, DELETE statements", "CREATE and DROP statements"],
    tip: "The file path must be accessible from the machine running this bot. Relative paths will not work.",
  },
};
