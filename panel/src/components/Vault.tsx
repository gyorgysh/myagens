import { useEffect, useState } from "react";
import { api, AuthError, type SecretView } from "../api.ts";
import { useI18n } from "../lib/useI18n.ts";
import { toast } from "../lib/useToast.ts";
import { useListAnimate } from "../lib/useListAnimate.ts";
import { Badge, Button, Callout, Card, ConfirmDialog, Empty, Input, Label } from "./ui.tsx";
import { VaultArt } from "./onboarding.tsx";

const blank = { name: "", value: "", description: "" };

type UsageMap = Record<string, Array<{ kind: string; name: string }>>;

export function VaultView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [secrets, setSecrets] = useState<SecretView[]>([]);
  const [usages, setUsages] = useState<UsageMap>({});
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<typeof blank>(blank);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [keyRotatedAt, setKeyRotatedAt] = useState<number | undefined>(undefined);
  const [exportPass, setExportPass] = useState("");
  const [exportBlob, setExportBlob] = useState<string | null>(null);
  const [importBlob, setImportBlob] = useState("");
  const [importPass, setImportPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [listRef] = useListAnimate();

  const load = () =>
    api
      .vault()
      .then((r) => { setSecrets(r.secrets); setUsages(r.usages ?? {}); setKeyRotatedAt(r.keyRotatedAt); })
      .catch((e) => (e instanceof AuthError ? onAuthError() : toast.error(String(e))));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startNew = () => {
    setForm(blank);
    setEditing("new");
  };
  const startEdit = (s: SecretView) => {
    setForm({ name: s.name, value: "", description: s.description });
    setEditing(s.id);
  };

  const save = async () => {
    const wasEditing = editing;
    try {
      const saved =
        wasEditing === "new"
          ? await api.createSecret(form)
          : await api.updateSecret(wasEditing!, form); // empty value = keep existing
      // Reconcile the single returned secret into local state instead of
      // re-fetching the whole list (avoids the flash + layout shift).
      setSecrets((prev) => {
        const idx = prev.findIndex((s) => s.id === saved.id);
        if (idx === -1) return [...prev, saved];
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

  const reveal = async (id: string) => {
    if (revealed[id] !== undefined) {
      setRevealed((r) => {
        const next = { ...r };
        delete next[id];
        return next;
      });
      return;
    }
    const { value } = await api.revealSecret(id);
    setRevealed((r) => ({ ...r, [id]: value }));
  };

  const del = (id: string) => {
    // Optimistically remove the row and open a 5s undo window. The server
    // delete only fires once the window closes; undo restores the row.
    const prev = secrets;
    setSecrets((cur) => cur.filter((s) => s.id !== id));
    toast.undo(t("deleted"), {
      undoLabel: t("toast_undo"),
      onUndo: () => setSecrets(prev),
      onCommit: async () => {
        try {
          await api.deleteSecret(id);
        } catch (e) {
          setSecrets(prev);
          if (e instanceof AuthError) return onAuthError();
          toast.error(String(e));
        }
      },
    });
  };

  const importProviders = async () => {
    try {
      const { imported } = await api.importSecrets();
      if (imported) toast.success(t("vault_imported").replace("{n}", String(imported)));
      else toast.info(t("vault_no_import"));
      await load();
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(String(e));
    }
  };

  const rotate = async () => {
    setConfirmRotate(false);
    setBusy(true);
    try {
      const { rotated } = await api.rotateVaultKey();
      toast.success(t("vault_rotated").replace("{n}", String(rotated)));
      await load();
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doExport = async () => {
    setBusy(true);
    try {
      const { blob } = await api.exportVault(exportPass);
      setExportBlob(blob);
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyExport = async () => {
    if (exportBlob) {
      await navigator.clipboard.writeText(exportBlob).catch(() => {});
      toast.success(t("vault_copied"));
    }
  };

  const doImport = async () => {
    setBusy(true);
    try {
      const { imported } = await api.importVaultBackup(importBlob.trim(), importPass);
      toast.success(t("vault_imported").replace("{n}", String(imported)));
      setImportBlob("");
      setImportPass("");
      await load();
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={t("vault_title")}
      right={
        editing ? null : (
          <Button variant="primary" onClick={startNew}>
            {t("vault_new")}
          </Button>
        )
      }
    >
      <p className="mb-3 text-sm text-fg-dim">{t("vault_desc")}</p>

      <Callout title={t("vault_migrate_title")} dismissId="vault-import">
        {t("vault_migrate_desc")}
        <div className="mt-2">
          <Button onClick={importProviders}>{t("vault_scan_import")}</Button>
        </div>
      </Callout>

      {editing && (
        <div className="my-4 space-y-3 rounded-lg border border-line bg-input p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{t("vault_name")}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t("vault_name_placeholder")}
              />
            </div>
            <div>
              <Label>{t("vault_description")}</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
          </div>
          <div>
            <Label>{editing === "new" ? t("vault_value") : t("vault_value_edit")}</Label>
            <Input
              type="password"
              value={form.value}
              onChange={(e) => setForm({ ...form, value: e.target.value })}
              placeholder="••••••••"
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={save}
              disabled={!form.name.trim() || (editing === "new" && !form.value)}
            >
              {t("save")}
            </Button>
            <Button onClick={() => setEditing(null)}>{t("cancel")}</Button>
          </div>
        </div>
      )}

      {secrets.length === 0 && !editing ? (
        <Empty
          icon={<VaultArt />}
          title={t("vault_empty")}
          action={
            <Button variant="primary" onClick={startNew}>
              {t("vault_new")}
            </Button>
          }
        >
          {t("onb_step_vault_desc")}
        </Empty>
      ) : (
        <div ref={listRef} className="mt-3 space-y-2">
          {secrets.map((s) => {
            const uses = usages[s.id] ?? [];
            return (
              <div
                key={s.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-line p-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{s.name}</span>
                    <Badge>vault:{s.id}</Badge>
                    {uses.length === 0 ? (
                      <Badge tone="zinc">{t("vault_unused")}</Badge>
                    ) : (
                      uses.map((u, i) => (
                        <Badge key={i} tone="blue">{u.kind}: {u.name}</Badge>
                      ))
                    )}
                  </div>
                  {s.description && <p className="text-sm text-fg-dim">{s.description}</p>}
                  <p className="mono mt-1 text-xs text-fg-faint">
                    {revealed[s.id] !== undefined ? revealed[s.id] : s.hint}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button onClick={() => reveal(s.id)}>
                    {revealed[s.id] !== undefined ? t("hide") : t("vault_reveal")}
                  </Button>
                  <Button onClick={() => startEdit(s)}>{t("edit")}</Button>
                  <Button variant="danger" onClick={() => del(s.id)}>
                    {t("delete")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-6 border-t border-line pt-4">
        <h3 className="text-sm font-semibold text-fg">{t("vault_keymgmt_title")}</h3>
        <p className="mt-1 text-xs text-fg-dim">{t("vault_keymgmt_desc")}</p>

        {/* Rotate */}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button onClick={() => setConfirmRotate(true)} disabled={busy}>
            {t("vault_rotate")}
          </Button>
          <span className="text-xs text-fg-faint">
            {keyRotatedAt
              ? t("vault_last_rotated").replace("{date}", new Date(keyRotatedAt).toLocaleString())
              : t("vault_never_rotated")}
          </span>
        </div>

        {/* Export */}
        <div className="mt-4 rounded-lg border border-line p-3">
          <Label>{t("vault_export_title")}</Label>
          <p className="mb-2 text-xs text-fg-dim">{t("vault_export_desc")}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              type="password"
              value={exportPass}
              onChange={(e) => setExportPass(e.target.value)}
              placeholder={t("vault_passphrase")}
            />
            <Button onClick={doExport} disabled={busy || exportPass.length < 8}>
              {t("vault_export_btn")}
            </Button>
          </div>
          {exportBlob && (
            <div className="mt-2">
              <textarea
                readOnly
                value={exportBlob}
                onFocus={(e) => e.currentTarget.select()}
                className="mono h-24 w-full resize-none rounded-md border border-line bg-input p-2 text-xs text-fg-dim"
              />
              <div className="mt-1 flex gap-2">
                <Button onClick={copyExport}>{t("vault_copy")}</Button>
                <Button onClick={() => setExportBlob(null)}>{t("vault_hide_export")}</Button>
              </div>
            </div>
          )}
        </div>

        {/* Import */}
        <div className="mt-3 rounded-lg border border-line p-3">
          <Label>{t("vault_import_title")}</Label>
          <p className="mb-2 text-xs text-fg-dim">{t("vault_import_desc")}</p>
          <textarea
            value={importBlob}
            onChange={(e) => setImportBlob(e.target.value)}
            placeholder="vaultbak1.…"
            className="mono h-20 w-full resize-none rounded-md border border-line bg-input p-2 text-xs text-fg"
          />
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              type="password"
              value={importPass}
              onChange={(e) => setImportPass(e.target.value)}
              placeholder={t("vault_passphrase")}
            />
            <Button
              variant="primary"
              onClick={doImport}
              disabled={busy || !importBlob.trim() || !importPass}
            >
              {t("vault_import_btn")}
            </Button>
          </div>
        </div>
      </div>

      {confirmRotate && (
        <ConfirmDialog
          title={t("vault_rotate")}
          description={t("vault_rotate_confirm")}
          confirmLabel={t("vault_rotate")}
          busy={busy}
          onConfirm={rotate}
          onCancel={() => setConfirmRotate(false)}
        />
      )}
    </Card>
  );
}
