import { useEffect, useState } from "react";
import { api, AuthError, type PromptTemplate } from "../api.ts";
import { useI18n } from "../lib/useI18n.ts";
import { toast } from "../lib/useToast.ts";
import { Badge, Button, Card, Empty, Input, Label, TextArea } from "./ui.tsx";
import { FileText } from "lucide-react";

const blank = { name: "", description: "", body: "" };

/** Distinct `{{variable}}` names in a body, mirrors the server helper so the
 *  editor can preview detected slots without a round-trip. */
function detectVars(body: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      names.push(m[1]);
    }
  }
  return names;
}

function render(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, n: string) => vars[n] ?? "");
}

export function TemplatesView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<typeof blank>(blank);

  const load = () =>
    api
      .templates()
      .then((r) => setTemplates(r.templates))
      .catch((e) => (e instanceof AuthError ? onAuthError() : toast.error(String(e))));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startNew = () => {
    setForm(blank);
    setEditing("new");
  };
  const startEdit = (tpl: PromptTemplate) => {
    setForm({ name: tpl.name, description: tpl.description, body: tpl.body });
    setEditing(tpl.id);
  };

  const save = async () => {
    const wasEditing = editing;
    try {
      const saved =
        wasEditing === "new"
          ? await api.createTemplate(form)
          : await api.updateTemplate(wasEditing!, form);
      setTemplates((prev) => {
        const idx = prev.findIndex((s) => s.id === saved.id);
        if (idx === -1) return [...prev, saved].sort((a, b) => a.name.localeCompare(b.name));
        const next = [...prev];
        next[idx] = saved;
        return next;
      });
      setEditing(null);
      toast.success(t("saved"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(String(e));
    }
  };

  const del = (id: string) => {
    if (!confirm(t("templates_delete_confirm"))) return;
    const prev = templates;
    setTemplates((cur) => cur.filter((s) => s.id !== id));
    api
      .deleteTemplate(id)
      .then(() => toast.success(t("deleted")))
      .catch((e) => {
        setTemplates(prev);
        if (e instanceof AuthError) return onAuthError();
        toast.error(String(e));
      });
  };

  const formVars = detectVars(form.body);

  return (
    <Card
      title={t("templates_title")}
      right={
        editing ? null : (
          <Button variant="primary" onClick={startNew}>
            {t("templates_new")}
          </Button>
        )
      }
    >
      <p className="mb-4 text-sm text-fg-dim">{t("templates_desc")}</p>

      {editing && (
        <div className="mb-4 space-y-3 rounded-lg border border-line bg-input p-3">
          <div>
            <Label>{t("templates_name")}</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t("templates_name_placeholder")}
            />
          </div>
          <div>
            <Label>{t("templates_field_desc")}</Label>
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div>
            <Label>{t("templates_body")}</Label>
            <TextArea
              rows={5}
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              placeholder={t("templates_body_placeholder")}
            />
            {formVars.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-fg-faint">{t("templates_vars")}</span>
                {formVars.map((v) => (
                  <Badge key={v} tone="blue">{`{{${v}}}`}</Badge>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="primary" onClick={save} disabled={!form.name.trim() || !form.body.trim()}>
              {t("save")}
            </Button>
            <Button onClick={() => setEditing(null)}>{t("cancel")}</Button>
          </div>
        </div>
      )}

      {templates.length === 0 && !editing ? (
        <Empty
          icon={<FileText size={40} className="text-accent" />}
          title={t("templates_empty")}
          action={
            <Button variant="primary" onClick={startNew}>
              {t("templates_new")}
            </Button>
          }
        >
          {t("templates_empty_desc")}
        </Empty>
      ) : (
        <div className="space-y-2">
          {templates.map((tpl) => (
            <div
              key={tpl.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-line p-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-fg">{tpl.name}</span>
                  {tpl.variables.map((v) => (
                    <Badge key={v} tone="blue">{`{{${v}}}`}</Badge>
                  ))}
                  {tpl.useCount > 0 && (
                    <span className="text-xs text-fg-faint">
                      {t("templates_used_n").replace("{n}", String(tpl.useCount))}
                    </span>
                  )}
                </div>
                {tpl.description && <p className="text-sm text-fg-dim">{tpl.description}</p>}
                <p className="mt-1 line-clamp-2 whitespace-pre-wrap font-mono text-xs text-fg-faint">
                  {tpl.body}
                </p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button onClick={() => startEdit(tpl)}>{t("edit")}</Button>
                <Button variant="danger" onClick={() => del(tpl.id)}>
                  {t("delete")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Compact quick-pick used inside the chat composer: pick a saved template, fill
 * any `{{variable}}` slots, and hand the rendered prompt back to the caller to
 * drop into the composer. Loads templates lazily on first open.
 */
export function TemplatePicker({ onPick }: { onPick: (text: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<PromptTemplate[] | null>(null);
  const [chosen, setChosen] = useState<PromptTemplate | null>(null);
  const [vars, setVars] = useState<Record<string, string>>({});

  const openMenu = () => {
    setOpen(true);
    if (templates === null) {
      api
        .templates()
        .then((r) => setTemplates(r.templates))
        .catch(() => setTemplates([]));
    }
  };

  const close = () => {
    setOpen(false);
    setChosen(null);
    setVars({});
  };

  const choose = (tpl: PromptTemplate) => {
    if (tpl.variables.length === 0) {
      onPick(tpl.body);
      close();
      return;
    }
    setChosen(tpl);
    setVars(Object.fromEntries(tpl.variables.map((v) => [v, ""])));
  };

  const insert = () => {
    if (!chosen) return;
    onPick(render(chosen.body, vars));
    close();
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={open ? close : openMenu}
        title={t("templates_quickpick")}
        aria-label={t("templates_quickpick")}
        className="inline-flex h-8 items-center gap-1 rounded-lg border border-line px-2 text-xs text-fg-dim hover:border-accent/40 hover:text-accent transition-colors"
      >
        <FileText size={13} />
        {t("templates_quickpick")}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-lg border border-line bg-surface p-2 shadow-lg">
          {chosen ? (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-fg">{chosen.name}</div>
              {chosen.variables.map((v) => (
                <div key={v}>
                  <Label>{v}</Label>
                  <Input
                    value={vars[v] ?? ""}
                    onChange={(e) => setVars((cur) => ({ ...cur, [v]: e.target.value }))}
                    placeholder={v}
                  />
                </div>
              ))}
              <div className="flex gap-1.5">
                <Button variant="primary" onClick={insert}>
                  {t("templates_insert")}
                </Button>
                <Button onClick={() => setChosen(null)}>{t("back")}</Button>
              </div>
            </div>
          ) : templates === null ? (
            <div className="px-2 py-3 text-center text-xs text-fg-faint">{t("loading")}</div>
          ) : templates.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-fg-faint">{t("templates_empty")}</div>
          ) : (
            <div className="max-h-64 space-y-0.5 overflow-y-auto">
              {templates.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => choose(tpl)}
                  className="flex w-full flex-col items-start rounded px-2 py-1.5 text-left hover:bg-surface-2"
                >
                  <span className="text-xs font-medium text-fg">{tpl.name}</span>
                  {tpl.description && (
                    <span className="line-clamp-1 text-xs text-fg-faint">{tpl.description}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
