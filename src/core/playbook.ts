import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PERSONALITY, WORK_FILE } from "../prompt.js";
import { audit } from "./audit.js";

export interface PromptView {
  /** The fixed personality block compiled into the build (read-only). */
  personality: string;
  /** Absolute path to the operator playbook. */
  workFile: string;
  /** Current playbook contents (empty string if the file doesn't exist yet). */
  work: string;
  exists: boolean;
}

export function getPrompt(): PromptView {
  let work = "";
  let exists = false;
  if (existsSync(WORK_FILE)) {
    try {
      work = readFileSync(WORK_FILE, "utf8");
      exists = true;
    } catch {
      /* unreadable — surface as empty */
    }
  }
  return { personality: PERSONALITY, workFile: WORK_FILE, work, exists };
}

/** Overwrite the operator playbook. Takes effect on the next turn (re-read live). */
export function savePlaybook(content: string): PromptView {
  mkdirSync(dirname(WORK_FILE), { recursive: true });
  writeFileSync(WORK_FILE, content);
  audit("prompt.save", { workFile: WORK_FILE, bytes: content.length });
  return getPrompt();
}
