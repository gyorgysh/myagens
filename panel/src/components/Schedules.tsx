import { useEffect, useState } from "react";
import { api, AuthError, type ScheduleView } from "../api.ts";
import { Badge, Button, Card, Empty, InfoCard, Input, Label } from "./ui.tsx";
import { ScheduleArt } from "./onboarding.tsx";
import { relTime } from "../lib/format.ts";
import { useI18n } from "../lib/useI18n.ts";

const blank = { prompt: "", when: "", cwd: "", webhookUrl: "" };

export function SchedulesView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [form, setForm] = useState<typeof blank>(blank);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<typeof blank>(blank);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .schedules()
      .then((r) => setSchedules(r.schedules))
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    setError(null);
    try {
      const r = await api.createSchedule(form);
      setSchedules(r.schedules);
      setForm(blank);
      setAdding(false);
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      setError(String(e));
    }
  };

  const startEdit = (s: ScheduleView) => {
    setEditingId(s.id);
    setEditForm({ prompt: s.prompt, when: s.specRaw, cwd: s.cwd, webhookUrl: s.webhookUrl ?? "" });
  };

  const saveEdit = async (id: string) => {
    setError(null);
    try {
      const r = await api.updateSchedule(id, editForm);
      setSchedules(r.schedules);
      setEditingId(null);
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      setError(String(e));
    }
  };

  const runNow = async (id: string) => {
    setError(null);
    try {
      const r = await api.runScheduleNow(id);
      setSchedules(r.schedules);
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      const msg = String(e);
      setError(msg.includes("409") ? t("sched_run_busy") : msg);
    }
  };

  const toggleEnabled = async (id: string, enabled: boolean) => {
    setError(null);
    try {
      const r = await api.setScheduleEnabled(id, enabled);
      setSchedules(r.schedules);
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      setError(String(e));
    }
  };

  const del = async (id: string) => {
    if (!confirm(t("sched_delete_confirm"))) return;
    await api.deleteSchedule(id);
    await load();
  };

  return (
    <Card
      title={t("sched_title")}
      right={
        !adding && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            {t("sched_new")}
          </Button>
        )
      }
    >
      <p className="mb-3 text-sm text-fg-dim">
        {t("sched_desc_pre")}<code>/schedule</code>{t("sched_desc_post")}
      </p>
      <div className="mb-3">
        <InfoCard id="schedules" title={t("info_schedules_title")} body={t("info_schedules_body")}>
          <p>{t("info_schedules_pause")}</p>
        </InfoCard>
      </div>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}

      {adding && (
        <div className="mb-4 space-y-3 rounded-lg border border-line bg-input p-3">
          <div>
            <Label>{t("sched_prompt")}</Label>
            <Input
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              placeholder={t("sched_prompt_placeholder")}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{t("sched_when")}</Label>
              <Input
                value={form.when}
                onChange={(e) => setForm({ ...form, when: e.target.value })}
                placeholder={t("sched_when_placeholder")}
              />
            </div>
            <div>
              <Label>{t("sched_cwd")}</Label>
              <Input
                value={form.cwd}
                onChange={(e) => setForm({ ...form, cwd: e.target.value })}
                placeholder={t("sched_cwd_placeholder")}
              />
            </div>
          </div>
          <div>
            <Label>{t("sched_webhook")}</Label>
            <Input
              value={form.webhookUrl}
              onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })}
              placeholder={t("sched_webhook_placeholder")}
            />
            <p className="mt-1 text-xs text-fg-faint">{t("sched_webhook_hint")}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" onClick={create} disabled={!form.prompt.trim() || !form.when.trim()}>
              {t("sched_create")}
            </Button>
            <Button onClick={() => setAdding(false)}>{t("cancel")}</Button>
          </div>
        </div>
      )}

      {schedules.length === 0 && !adding ? (
        <Empty
          icon={<ScheduleArt />}
          title={t("sched_empty")}
          action={
            <Button variant="primary" onClick={() => setAdding(true)}>
              {t("sched_new")}
            </Button>
          }
        >
          {t("onb_step_schedule_desc")}
        </Empty>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) =>
            editingId === s.id ? (
              <div key={s.id} className="space-y-3 rounded-lg border border-accent/50 bg-input p-3">
                <div>
                  <Label>{t("sched_prompt")}</Label>
                  <Input
                    value={editForm.prompt}
                    onChange={(e) => setEditForm({ ...editForm, prompt: e.target.value })}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label>{t("sched_when")}</Label>
                    <Input
                      value={editForm.when}
                      onChange={(e) => setEditForm({ ...editForm, when: e.target.value })}
                      placeholder={t("sched_when_placeholder")}
                    />
                  </div>
                  <div>
                    <Label>{t("sched_cwd_edit")}</Label>
                    <Input
                      value={editForm.cwd}
                      onChange={(e) => setEditForm({ ...editForm, cwd: e.target.value })}
                    />
                  </div>
                </div>
                <div>
                  <Label>{t("sched_webhook")}</Label>
                  <Input
                    value={editForm.webhookUrl}
                    onChange={(e) => setEditForm({ ...editForm, webhookUrl: e.target.value })}
                    placeholder={t("sched_webhook_placeholder")}
                  />
                </div>
                <div className="flex gap-2">
                  <Button variant="primary" onClick={() => saveEdit(s.id)} disabled={!editForm.prompt.trim() || !editForm.when.trim()}>
                    {t("save")}
                  </Button>
                  <Button onClick={() => setEditingId(null)}>{t("cancel")}</Button>
                </div>
              </div>
            ) : (
              <div
                key={s.id}
                className={`rounded-lg border border-line p-3${s.enabled ? "" : " opacity-60"}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="blue">{s.spec}</Badge>
                  {!s.enabled && <Badge tone="amber">{t("sched_paused")}</Badge>}
                  <span className="ml-auto tabular text-xs text-fg-muted">
                    {s.enabled
                      ? t("sched_next").replace("{time}", relTime(s.nextRunAt))
                      : t("sched_paused")}
                    {s.lastRunAt ? ` · ${t("sched_last").replace("{time}", relTime(s.lastRunAt))}` : ""}
                  </span>
                  <Button onClick={() => void toggleEnabled(s.id, !s.enabled)}>
                    {s.enabled ? t("sched_pause") : t("sched_resume")}
                  </Button>
                  <Button onClick={() => void runNow(s.id)}>{t("sched_run_now")}</Button>
                  <Button onClick={() => startEdit(s)}>{t("edit")}</Button>
                  <Button variant="danger" onClick={() => del(s.id)}>
                    {t("delete")}
                  </Button>
                </div>
                <div className="mt-2 text-sm text-fg">{s.prompt}</div>
                <div className="mono mt-1 truncate text-xs text-fg-faint" title={s.cwd}>
                  {s.cwd}
                </div>
                {s.webhookUrl && (
                  <div className="mono mt-1 truncate text-xs text-fg-faint" title={s.webhookUrl}>
                    {t("sched_webhook")}: {s.webhookUrl}
                  </div>
                )}
              </div>
            ),
          )}
        </div>
      )}
    </Card>
  );
}
