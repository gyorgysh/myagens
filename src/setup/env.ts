/**
 * .env writer for the setup wizard. Merges values into an existing file (a
 * commented or previous line for the same key is replaced in place, everything
 * else is preserved) and always writes with owner-only permissions — the file
 * holds the bot token and panel secret.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";

export function writeEnvValues(envPath: string, values: Record<string, string>): void {
  let body = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const [key, raw] of Object.entries(values)) {
    // A newline in a value would let one field smuggle another line into .env.
    const value = raw.replace(/[\r\n]/g, " ").trim();
    const line = `${key}=${value}`;
    const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
    if (re.test(body)) {
      body = body.replace(re, line);
    } else {
      if (body.length && !body.endsWith("\n")) body += "\n";
      body += `${line}\n`;
    }
  }
  writeFileSync(envPath, body, { mode: 0o600 });
  // writeFileSync's mode only applies on create; tighten pre-existing files too.
  try {
    chmodSync(envPath, 0o600);
  } catch {
    /* non-POSIX fs */
  }
}
