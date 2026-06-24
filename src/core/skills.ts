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
  createdAt: number;
  updatedAt: number;
}

interface SkillFile {
  version: 1;
  skills: Skill[];
}

function load(): Skill[] {
  return loadJson<SkillFile>(FILE, { version: 1, skills: [] }).skills;
}

function persist(skills: Skill[]): void {
  saveJson<SkillFile>(FILE, { version: 1, skills });
}

export function listSkills(): Skill[] {
  return load().sort((a, b) => a.name.localeCompare(b.name));
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
    createdAt: now,
    updatedAt: now,
  };
  const skills = load();
  skills.push(skill);
  persist(skills);
  audit("skill.create", { id: skill.id, name: skill.name });
  return skill;
}

export function updateSkill(id: string, input: Partial<SkillInput>): Skill | undefined {
  const skills = load();
  const skill = skills.find((s) => s.id === id);
  if (!skill) return undefined;
  if (input.name !== undefined) skill.name = input.name.trim() || skill.name;
  if (input.description !== undefined) skill.description = input.description.trim();
  if (input.prompt !== undefined) skill.prompt = input.prompt;
  if (input.cwd !== undefined) skill.cwd = input.cwd.trim() || undefined;
  skill.updatedAt = Date.now();
  persist(skills);
  audit("skill.update", { id, name: skill.name });
  return skill;
}

export function deleteSkill(id: string): boolean {
  const skills = load();
  const next = skills.filter((s) => s.id !== id);
  if (next.length === skills.length) return false;
  persist(next);
  audit("skill.delete", { id });
  return true;
}
