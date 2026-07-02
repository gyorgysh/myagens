import { useEffect, useRef, useState } from "react";
import { api, AuthError, type BackupManifest } from "../api.ts";
import { useI18n } from "../lib/useI18n.ts";
import { errorMessage } from "../lib/errorMessage.ts";
import { toast } from "../lib/useToast.ts";
import { Badge, Button, Card, Input, Label } from "./ui.tsx";

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read a File into a base64 string (no data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("could not read file"));
    r.onload = () => {
      const res = String(r.result);
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    r.readAsDataURL(file);
  });
}

export function BackupView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [manifest, setManifest] = useState<BackupManifest | null>(null);
  const [exportPass, setExportPass] = useState("");
  const [importPass, setImportPass] = useState("");
  const [includeVault, setIncludeVault] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () =>
    api
      .backupManifest()
      .then(setManifest)
      .catch((e) => (e instanceof AuthError ? onAuthError() : toast.error(errorMessage(e, t))));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doExport = async () => {
    setBusy(true);
    try {
      const blob = await api.exportBackup(exportPass);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      a.href = url;
      a.download = `myagens-backup-${stamp}.mag`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t("backup_exported"));
      setExportPass("");
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!file) return;
    if (!confirm(t("backup_import_confirm"))) return;
    setBusy(true);
    try {
      const archive = await fileToBase64(file);
      const r = await api.importBackup(archive, importPass, includeVault);
      toast.success(
        t("backup_imported")
          .replace("{files}", String(r.filesRestored))
          .replace("{secrets}", String(r.vaultRestored)),
      );
      setFile(null);
      setImportPass("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t("backup_title")}>
      <p className="mb-3 text-sm text-fg-dim">{t("backup_desc")}</p>

      {/* What's included */}
      <div className="rounded-lg border border-line p-3">
        <Label>{t("backup_contents")}</Label>
        {manifest ? (
          <>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {manifest.files.map((f) => (
                <Badge key={f.name} tone="blue">
                  {f.name} · {humanBytes(f.bytes)}
                </Badge>
              ))}
              {manifest.vaultSecrets > 0 && (
                <Badge tone="green">
                  {t("backup_vault_secrets").replace("{n}", String(manifest.vaultSecrets))}
                </Badge>
              )}
            </div>
            <p className="mt-2 text-xs text-fg-faint">
              {t("backup_total").replace("{size}", humanBytes(manifest.totalBytes))}
            </p>
            {manifest.skipped.length > 0 && (
              <p className="mt-1 text-xs text-fg-faint">
                {t("backup_skipped").replace("{names}", manifest.skipped.join(", "))}
              </p>
            )}
          </>
        ) : (
          <p className="mt-2 text-xs text-fg-faint">…</p>
        )}
      </div>

      {/* Export */}
      <div className="mt-4 rounded-lg border border-line p-3">
        <Label>{t("backup_export_title")}</Label>
        <p className="mb-2 text-xs text-fg-dim">{t("backup_export_desc")}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            type="password"
            value={exportPass}
            onChange={(e) => setExportPass(e.target.value)}
            placeholder={t("backup_passphrase")}
          />
          <Button variant="primary" onClick={doExport} disabled={busy || exportPass.length < 8}>
            {t("backup_export_btn")}
          </Button>
        </div>
        <p className="mt-1 text-xs text-fg-faint">{t("backup_passphrase_hint")}</p>
      </div>

      {/* Import / restore */}
      <div className="mt-3 rounded-lg border border-line p-3">
        <Label>{t("backup_import_title")}</Label>
        <p className="mb-2 text-xs text-fg-dim">{t("backup_import_desc")}</p>
        <div className="rounded-lg border border-warn-subtle bg-warn-subtle/30 p-2.5 text-xs text-warn-fg">
          <span className="font-medium">⚠ {t("backup_warn_title")}</span>
          <p className="mt-0.5">{t("backup_warn_desc")}</p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".mag,.mhq,application/octet-stream"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="mt-2 block w-full text-sm text-fg-dim file:mr-3 file:rounded-md file:border file:border-line file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:text-fg hover:file:bg-surface"
        />
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            type="password"
            value={importPass}
            onChange={(e) => setImportPass(e.target.value)}
            placeholder={t("backup_passphrase")}
          />
          <Button
            variant="primary"
            onClick={doImport}
            disabled={busy || !file || !importPass}
          >
            {t("backup_import_btn")}
          </Button>
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs text-fg-dim">
          <input
            type="checkbox"
            checked={includeVault}
            onChange={(e) => setIncludeVault(e.target.checked)}
          />
          {t("backup_include_vault")}
        </label>
      </div>
    </Card>
  );
}
