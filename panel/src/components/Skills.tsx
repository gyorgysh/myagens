import { useEffect, useState } from "react";
import { api, AuthError, type ClaudeRoot, type Skill } from "../api.ts";
import { useI18n } from "../lib/useI18n.ts";
import { Badge, Button, Card, Empty, Input, Label, TextArea } from "./ui.tsx";
import { SkillsArt } from "./onboarding.tsx";

export function SkillsView({ onAuthError }: { onAuthError: () => void }) {
  return (
    <div className="space-y-6">
      <PromptLibrary onAuthError={onAuthError} />
      <ProjectFiles onAuthError={onAuthError} />
    </div>
  );
}

const blank = { name: "", description: "", prompt: "", cwd: "" };

function PromptLibrary({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<typeof blank>(blank);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .skills()
      .then((r) => setSkills(r.skills))
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startNew = () => {
    setForm(blank);
    setEditing("new");
  };
  const startEdit = (s: Skill) => {
    setForm({ name: s.name, description: s.description, prompt: s.prompt, cwd: s.cwd ?? "" });
    setEditing(s.id);
  };

  const save = async () => {
    try {
      if (editing === "new") await api.createSkill(form);
      else if (editing) await api.updateSkill(editing, form);
      setEditing(null);
      await load();
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      setError(String(e));
    }
  };

  const del = async (id: string) => {
    if (!confirm(t("skills_delete_confirm"))) return;
    await api.deleteSkill(id);
    await load();
  };

  return (
    <Card
      title={t("skills_library")}
      right={
        editing ? null : (
          <Button variant="primary" onClick={startNew}>
            {t("skills_new")}
          </Button>
        )
      }
    >
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}

      {editing && (
        <div className="mb-4 space-y-3 rounded-lg border border-line bg-input p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{t("skills_name")}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t("skills_name_placeholder")}
              />
            </div>
            <div>
              <Label>{t("skills_cwd")}</Label>
              <Input
                value={form.cwd}
                onChange={(e) => setForm({ ...form, cwd: e.target.value })}
                placeholder={t("skills_cwd_placeholder")}
              />
            </div>
          </div>
          <div>
            <Label>{t("skills_desc")}</Label>
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div>
            <Label>{t("skills_prompt")}</Label>
            <TextArea
              rows={6}
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              placeholder={t("skills_prompt_placeholder")}
            />
          </div>
          <div className="flex gap-2">
            <Button variant="primary" onClick={save} disabled={!form.name.trim() || !form.prompt.trim()}>
              {t("save")}
            </Button>
            <Button onClick={() => setEditing(null)}>{t("cancel")}</Button>
          </div>
        </div>
      )}

      {skills.length === 0 && !editing ? (
        <Empty icon={<SkillsArt />}>{t("skills_empty_full")}</Empty>
      ) : (
        <div className="space-y-2">
          {skills.map((s) => (
            <div
              key={s.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-line p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-fg">{s.name}</span>
                  {s.cwd && <Badge>{s.cwd}</Badge>}
                </div>
                {s.description && <p className="text-sm text-fg-dim">{s.description}</p>}
                <p className="mt-1 line-clamp-2 font-mono text-xs text-fg-faint">{s.prompt}</p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button onClick={() => startEdit(s)}>Edit</Button>
                <Button variant="danger" onClick={() => del(s.id)}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ProjectFiles({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [roots, setRoots] = useState<ClaudeRoot[]>([]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    api
      .claudeFiles()
      .then((r) => setRoots(r.roots))
      .catch((e) => e instanceof AuthError && onAuthError());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = async (path: string) => {
    setStatus(null);
    const r = await api.claudeFile(path);
    setOpenPath(path);
    setContent(r.content);
    setDirty(false);
  };

  const save = async () => {
    if (!openPath) return;
    await api.saveClaudeFile(openPath, content);
    setDirty(false);
    setStatus(t("saved"));
    setTimeout(() => setStatus(null), 2000);
  };

  return (
    <Card title={t("skills_files_title")}>
      <p className="mb-3 text-sm text-fg-dim">{t("skills_files_desc")}</p>
      {roots.length === 0 ? (
        <Empty>{t("skills_files_empty")}</Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <div className="space-y-3">
            {roots.map((r) => (
              <div key={r.root}>
                <div className="truncate font-mono text-xs text-fg-faint" title={r.root}>
                  {r.root}
                </div>
                <div className="mt-1 space-y-0.5">
                  {r.files.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => open(f.path)}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs ${
                        openPath === f.path ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-2"
                      }`}
                    >
                      <Badge tone={f.kind === "memory" ? "blue" : "zinc"}>{f.kind}</Badge>
                      <span className="truncate font-mono">{f.rel}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div>
            {openPath ? (
              <>
                <div className="mb-2 truncate font-mono text-xs text-fg-faint">{openPath}</div>
                <TextArea
                  rows={20}
                  value={content}
                  onChange={(e) => {
                    setContent(e.target.value);
                    setDirty(true);
                  }}
                />
                <div className="mt-2 flex items-center gap-3">
                  <Button variant="primary" onClick={save} disabled={!dirty}>
                    {t("save")}
                  </Button>
                  {status && <span className="text-xs text-emerald-400">{status}</span>}
                </div>
              </>
            ) : (
              <Empty>{t("skills_files_select")}</Empty>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
