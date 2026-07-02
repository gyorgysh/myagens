import { randomBytes } from "node:crypto";
import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";

const FILE = "skills.json";

/** A reusable, named instruction snippet. Can be run on demand or attached to
 *  a worker as its persona/system prompt. */
export interface Skill {
  id: string;
  name: string;
  description: string;
  /** The instruction text / prompt body. */
  prompt: string;
  /** Optional default working directory when run directly. */
  cwd?: string;
  /** How many times this skill has been applied in a worker run. */
  useCount: number;
  /** Archived by maintenance: hidden from suggestions and system prompt injection
   *  but restorable from the panel. Skills with useCount > 0 are never auto-archived. */
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
}

interface SkillFile {
  version: 1;
  skills: Skill[];
}

function load(): Skill[] {
  return loadJson<SkillFile>(FILE, { version: 1, skills: [] }).skills.map(normalize);
}

function normalize(s: Skill): Skill {
  return { ...s, useCount: s.useCount ?? 0, archived: s.archived ?? false };
}

function persist(skills: Skill[]): void {
  saveJson<SkillFile>(FILE, { version: 1, skills });
}

export function listSkills(includeArchived = false): Skill[] {
  const all = load().sort((a, b) => a.name.localeCompare(b.name));
  return includeArchived ? all : all.filter((s) => !s.archived);
}

export function getSkill(id: string): Skill | undefined {
  return load().find((s) => s.id === id);
}

export interface SkillInput {
  name: string;
  description?: string;
  prompt: string;
  cwd?: string;
}

export function createSkill(input: SkillInput): Skill {
  const now = Date.now();
  const skill: Skill = {
    id: randomBytes(4).toString("hex"),
    name: input.name.trim() || "Untitled",
    description: input.description?.trim() ?? "",
    prompt: input.prompt,
    cwd: input.cwd?.trim() || undefined,
    useCount: 0,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  const skills = load();
  skills.push(skill);
  persist(skills);
  audit("skill.create", { id: skill.id, name: skill.name });
  return skill;
}

export function updateSkill(id: string, input: Partial<SkillInput & { archived?: boolean }>): Skill | undefined {
  const skills = load();
  const skill = skills.find((s) => s.id === id);
  if (!skill) return undefined;
  if (input.name !== undefined) skill.name = input.name.trim() || skill.name;
  if (input.description !== undefined) skill.description = input.description.trim();
  if (input.prompt !== undefined) skill.prompt = input.prompt;
  if (input.cwd !== undefined) skill.cwd = input.cwd.trim() || undefined;
  if (input.archived !== undefined) skill.archived = input.archived;
  skill.updatedAt = Date.now();
  persist(skills);
  audit("skill.update", { id, name: skill.name });
  return skill;
}

/** Increment useCount for a skill (called when a worker run starts with it). */
export function recordSkillUse(id: string): void {
  const skills = load();
  const skill = skills.find((s) => s.id === id);
  if (!skill) return;
  skill.useCount = (skill.useCount ?? 0) + 1;
  persist(skills);
}

export function deleteSkill(id: string): boolean {
  const skills = load();
  const next = skills.filter((s) => s.id !== id);
  if (next.length === skills.length) return false;
  persist(next);
  audit("skill.delete", { id });
  return true;
}

/** Marker identifying a file as a MyAgens skill bundle. */
const BUNDLE_KIND = "myagens.skill";
// Pre-rename marker, still accepted so a bundle exported before the
// myhq->MyAgens rename can still be imported.
const LEGACY_BUNDLE_KINDS = ["myhq.skill"];

/** A portable, shareable skill package. Carries only the authoring fields
 *  (name/description/prompt/cwd); runtime bookkeeping (id, counts, timestamps)
 *  is regenerated on import. */
export interface SkillBundle {
  kind: typeof BUNDLE_KIND;
  version: 1;
  exportedAt: number;
  skill: SkillInput;
}

/** Package a skill as a shareable bundle. Returns undefined if id is unknown. */
export function exportSkill(id: string): SkillBundle | undefined {
  const skill = getSkill(id);
  if (!skill) return undefined;
  audit("skill.export", { id, name: skill.name });
  return {
    kind: BUNDLE_KIND,
    version: 1,
    exportedAt: Date.now(),
    skill: {
      name: skill.name,
      description: skill.description,
      prompt: skill.prompt,
      cwd: skill.cwd,
    },
  };
}

/** Validate an untrusted bundle and install it as a new skill. Returns an error
 *  string instead of throwing on malformed input. Names that collide with an
 *  existing skill get a " (imported)" suffix so nothing is silently overwritten. */
export function importSkill(bundle: unknown): { skill: Skill } | { error: string } {
  if (!bundle || typeof bundle !== "object") return { error: "Not a valid skill bundle." };
  const b = bundle as Partial<SkillBundle>;
  if (b.kind !== BUNDLE_KIND && !(typeof b.kind === "string" && LEGACY_BUNDLE_KINDS.includes(b.kind)))
    return { error: "File is not a MyAgens skill bundle." };
  const src = b.skill;
  if (!src || typeof src !== "object") return { error: "Bundle has no skill payload." };
  const name = typeof src.name === "string" ? src.name.trim() : "";
  const prompt = typeof src.prompt === "string" ? src.prompt : "";
  if (!name || !prompt.trim()) return { error: "Bundle is missing a name or prompt." };

  const taken = new Set(load().map((s) => s.name.toLowerCase()));
  let finalName = name;
  if (taken.has(finalName.toLowerCase())) {
    finalName = `${name} (imported)`;
    let n = 2;
    while (taken.has(finalName.toLowerCase())) finalName = `${name} (imported ${n++})`;
  }

  const skill = createSkill({
    name: finalName,
    description: typeof src.description === "string" ? src.description : "",
    prompt,
    cwd: typeof src.cwd === "string" ? src.cwd : undefined,
  });
  audit("skill.import", { id: skill.id, name: skill.name });
  return { skill };
}
