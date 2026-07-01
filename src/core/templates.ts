import { randomBytes } from "node:crypto";
import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";

const FILE = "templates.json";

/**
 * A saved, reusable prompt with `{{variable}}` placeholders. Surfaced as a
 * quick-pick in the panel chat and via the Telegram `/templates` command; the
 * placeholders are filled in at use time to produce a concrete turn prompt.
 */
export interface PromptTemplate {
  id: string;
  /** Short human name shown in the quick-pick menu. */
  name: string;
  /** Optional one-line description. */
  description: string;
  /** The prompt body, may contain `{{variable}}` slots. */
  body: string;
  /** How many times this template has been used (bumped on render). */
  useCount: number;
  createdAt: number;
  updatedAt: number;
}

interface TemplateFile {
  version: 1;
  templates: PromptTemplate[];
}

function load(): PromptTemplate[] {
  return loadJson<TemplateFile>(FILE, { version: 1, templates: [] }).templates.map(normalize);
}

function normalize(t: PromptTemplate): PromptTemplate {
  return { ...t, useCount: t.useCount ?? 0, description: t.description ?? "" };
}

function persist(templates: PromptTemplate[]): void {
  saveJson<TemplateFile>(FILE, { version: 1, templates });
}

export function listTemplates(): PromptTemplate[] {
  return load().sort((a, b) => a.name.localeCompare(b.name));
}

export function getTemplate(id: string): PromptTemplate | undefined {
  return load().find((t) => t.id === id);
}

export interface TemplateInput {
  name: string;
  description?: string;
  body: string;
}

export function createTemplate(input: TemplateInput): PromptTemplate {
  const now = Date.now();
  const template: PromptTemplate = {
    id: randomBytes(4).toString("hex"),
    name: input.name.trim() || "Untitled",
    description: input.description?.trim() ?? "",
    body: input.body,
    useCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const templates = load();
  templates.push(template);
  persist(templates);
  audit("template.create", { id: template.id, name: template.name });
  return template;
}

export function updateTemplate(
  id: string,
  input: Partial<TemplateInput>,
): PromptTemplate | undefined {
  const templates = load();
  const template = templates.find((t) => t.id === id);
  if (!template) return undefined;
  if (input.name !== undefined) template.name = input.name.trim() || template.name;
  if (input.description !== undefined) template.description = input.description.trim();
  if (input.body !== undefined) template.body = input.body;
  template.updatedAt = Date.now();
  persist(templates);
  audit("template.update", { id, name: template.name });
  return template;
}

export function deleteTemplate(id: string): boolean {
  const templates = load();
  const next = templates.filter((t) => t.id !== id);
  if (next.length === templates.length) return false;
  persist(next);
  audit("template.delete", { id });
  return true;
}

/** Increment useCount for a template (called when it's rendered into a prompt). */
export function recordTemplateUse(id: string): void {
  const templates = load();
  const template = templates.find((t) => t.id === id);
  if (!template) return;
  template.useCount = (template.useCount ?? 0) + 1;
  persist(templates);
}

/** The distinct `{{variable}}` names referenced in a template body, in order. */
export function templateVariables(body: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Substitute `{{variable}}` slots in `body` with values from `vars`. Unknown or
 * missing variables are left as an empty string so a partially-filled template
 * still yields a usable prompt.
 */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name: string) => vars[name] ?? "");
}
