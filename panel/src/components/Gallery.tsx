import { useEffect, useState } from "react";
import { Download, Images, Trash2 } from "lucide-react";
import {
  api,
  AuthError,
  type Connector,
  type GalleryImage,
  type ImageProviderId,
} from "../api.ts";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Empty,
  Input,
  Label,
  Modal,
  Select,
  Skeleton,
  TextArea,
} from "./ui.tsx";
import { useI18n } from "../lib/useI18n.ts";
import { errorMessage } from "../lib/errorMessage.ts";
import { toast } from "../lib/useToast.ts";
import { useListAnimate } from "../lib/useListAnimate.ts";
import type { Tab } from "./Sidebar.tsx";

const IMAGE_PROVIDER_IDS: ImageProviderId[] = ["recraft", "ideogram", "replicate", "fal", "local_sd"];
const PROVIDER_LABELS: Record<ImageProviderId, string> = {
  recraft: "Recraft",
  ideogram: "Ideogram",
  replicate: "Replicate",
  fal: "fal.ai",
  local_sd: "Local SD",
};
const GATEWAY_PROVIDERS: ImageProviderId[] = ["replicate", "fal"];

/** Renders a gallery image via an authenticated blob fetch + object URL. The
 *  REST file route only accepts the Bearer header (not `?token=`, which is
 *  reserved for the `/ws` handshake — see api.ts `reqBlob`), so a plain
 *  `<img src>` pointed at the route can't be used. */
function GalleryThumb({
  id,
  alt,
  className,
  onAuthError,
}: {
  id: string;
  alt: string;
  className?: string;
  onAuthError: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    api
      .galleryImageBlob(id)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch((e) => {
        if (cancelled) return;
        setFailed(true);
        if (e instanceof AuthError) onAuthError();
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (failed) {
    return (
      <div className={`flex items-center justify-center bg-surface-2 text-fg-faint ${className ?? ""}`}>
        <Images size={20} />
      </div>
    );
  }
  if (!src) return <Skeleton className={className ?? "h-full w-full"} />;
  return <img src={src} alt={alt} className={className} />;
}

// ─── Detail modal ───────────────────────────────────────────────────────────

function ImageDetailModal({
  image,
  onClose,
  onAuthError,
  onSaved,
  onRequestDelete,
}: {
  image: GalleryImage;
  onClose: () => void;
  onAuthError: () => void;
  onSaved: (img: GalleryImage) => void;
  onRequestDelete: (id: string) => void;
}) {
  const { t } = useI18n();
  const [tags, setTags] = useState(image.tags.join(", "));
  const [saving, setSaving] = useState(false);

  const saveTags = async () => {
    setSaving(true);
    try {
      const updated = await api.saveGalleryImageTags(
        image.id,
        tags.split(",").map((s) => s.trim()).filter(Boolean),
      );
      onSaved(updated);
      toast.success(t("gallery_save_tags"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    } finally {
      setSaving(false);
    }
  };

  const download = async () => {
    try {
      const blob = await api.galleryImageBlob(image.id);
      const url = URL.createObjectURL(blob);
      const ext = image.path.split(".").pop() || "png";
      const a = document.createElement("a");
      a.href = url;
      a.download = `${image.id}.${ext}`;
      a.click();
      // Defer the revoke so a synchronous revoke can't abort the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    }
  };

  return (
    <Modal onClose={onClose} size="lg" labelledBy="gallery-detail-title" closeButton>
      <div className="flex flex-col gap-0">
        <div className="max-h-[50vh] overflow-hidden rounded-t-2xl bg-surface-2">
          <GalleryThumb
            id={image.id}
            alt={image.prompt}
            className="mx-auto max-h-[50vh] w-auto object-contain"
            onAuthError={onAuthError}
          />
        </div>
        <div className="space-y-3 p-4">
          <h2 id="gallery-detail-title" className="sr-only">
            {image.prompt}
          </h2>
          <div>
            <Label>{t("gallery_prompt_label")}</Label>
            <p className="text-sm text-fg">{image.prompt}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-fg-faint">
            <span className="inline-flex items-center gap-1.5">
              {t("gallery_provider_label")}:
              <Badge tone="blue">{PROVIDER_LABELS[image.provider as ImageProviderId] ?? image.provider}</Badge>
            </span>
            <span>
              {t("gallery_created_label")}: {new Date(image.createdAt).toLocaleString()}
            </span>
          </div>
          <div>
            <Label>{t("gallery_tags_label")}</Label>
            <div className="flex gap-2">
              <Input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder={t("gallery_tags_placeholder")}
                className="flex-1"
              />
              <Button onClick={saveTags} disabled={saving}>
                {t("gallery_save_tags")}
              </Button>
            </div>
          </div>
          <div className="flex justify-between gap-2 pt-2">
            <Button variant="danger" onClick={() => onRequestDelete(image.id)}>
              <Trash2 size={14} className="mr-1 inline" strokeWidth={2} />
              {t("delete")}
            </Button>
            <Button onClick={download}>
              <Download size={14} className="mr-1 inline" strokeWidth={2} />
              {t("gallery_download")}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ─── Main view ──────────────────────────────────────────────────────────────

const blankGenerate = {
  providerId: "recraft" as ImageProviderId,
  prompt: "",
  size: "",
  style: "",
  model: "",
  negativePrompt: "",
  steps: "",
  extraInput: "",
  showAdvanced: false,
};

export function GalleryView({ onAuthError, onGoto }: { onAuthError: () => void; onGoto?: (t: Tab) => void }) {
  const { t } = useI18n();
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<string>("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<GalleryImage | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [generateForm, setGenerateForm] = useState(blankGenerate);
  const [generating, setGenerating] = useState(false);
  const [listRef] = useListAnimate();

  const imageConnectors = connectors.filter((c) => (IMAGE_PROVIDER_IDS as string[]).includes(c.id));
  const enabledProviders = imageConnectors.filter((c) => c.enabled && c.secretId);

  useEffect(() => {
    void api
      .connectors()
      .then((r) => setConnectors(r.connectors))
      .catch((e) => (e instanceof AuthError ? onAuthError() : undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (enabledProviders.length === 0) return;
    if (!enabledProviders.some((c) => c.id === generateForm.providerId)) {
      setGenerateForm((f) => ({ ...f, providerId: enabledProviders[0].id as ImageProviderId }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectors]);

  const load = () => {
    const fromMs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : undefined;
    const toMs = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : undefined;
    return api
      .gallery({
        q: query.trim() || undefined,
        provider: providerFilter || undefined,
        tag: tagFilter || undefined,
        from: fromMs,
        to: toMs,
      })
      .then((r) => {
        setImages(r.images);
        setAllTags(r.tags);
      })
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(errorMessage(e, t))));
  };

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, providerFilter, tagFilter, dateFrom, dateTo]);

  const generate = async () => {
    if (!generateForm.prompt.trim()) return;
    const isGateway = (GATEWAY_PROVIDERS as string[]).includes(generateForm.providerId);
    const isLocalSd = generateForm.providerId === "local_sd";

    let extraInput: Record<string, unknown> | undefined;
    if (isGateway && generateForm.extraInput.trim()) {
      try {
        extraInput = JSON.parse(generateForm.extraInput) as Record<string, unknown>;
      } catch {
        toast.error(t("gallery_extra_input_invalid"));
        return;
      }
    }
    if (isGateway && !generateForm.model.trim()) return;

    setGenerating(true);
    try {
      const img = await api.generateGalleryImage({
        providerId: generateForm.providerId,
        prompt: generateForm.prompt.trim(),
        size: !isGateway ? generateForm.size.trim() || undefined : undefined,
        style: !isGateway && !isLocalSd ? generateForm.style.trim() || undefined : undefined,
        model: isGateway ? generateForm.model.trim() : undefined,
        negativePrompt: isLocalSd ? generateForm.negativePrompt.trim() || undefined : undefined,
        steps: isLocalSd && generateForm.steps.trim() ? Number(generateForm.steps) : undefined,
        extraInput,
      });
      setImages((cur) => [img, ...cur]);
      setGenerateForm((f) => ({ ...f, prompt: "" }));
      toast.success(t("gallery_generate"));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(`${t("gallery_generate_failed")}: ${errorMessage(e, t)}`);
    } finally {
      setGenerating(false);
    }
  };

  const doDelete = async () => {
    if (!confirmDeleteId) return;
    setDeleting(true);
    try {
      await api.deleteGalleryImage(confirmDeleteId);
      setImages((cur) => cur.filter((i) => i.id !== confirmDeleteId));
      setConfirmDeleteId(null);
      setSelectedImage(null);
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    } finally {
      setDeleting(false);
    }
  };

  const hasFilters = Boolean(query || providerFilter || tagFilter || dateFrom || dateTo);

  return (
    <Card title={t("gallery_title")}>
      <p className="mb-3 text-sm text-fg-dim">{t("gallery_desc")}</p>
      {error && <p className="mb-2 text-sm text-critical-fg">{error}</p>}

      {enabledProviders.length === 0 ? (
        <Empty
          icon={<Images size={40} className="text-accent" />}
          title={t("gallery_no_providers_title")}
          action={
            onGoto && (
              <Button variant="primary" onClick={() => onGoto("connectors")}>
                {t("gallery_no_providers_action")}
              </Button>
            )
          }
        >
          {t("gallery_no_providers_desc")}
        </Empty>
      ) : (
        <div className="mb-4 space-y-2 rounded-lg border border-line bg-input p-3">
          <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
            <Select
              value={generateForm.providerId}
              onChange={(e) => setGenerateForm((f) => ({ ...f, providerId: e.target.value as ImageProviderId }))}
            >
              {enabledProviders.map((c) => (
                <option key={c.id} value={c.id}>
                  {PROVIDER_LABELS[c.id as ImageProviderId] ?? c.name}
                </option>
              ))}
            </Select>
            <TextArea
              rows={2}
              value={generateForm.prompt}
              onChange={(e) => setGenerateForm((f) => ({ ...f, prompt: e.target.value }))}
              placeholder={t("gallery_generate_prompt_ph")}
            />
          </div>
          {(GATEWAY_PROVIDERS as string[]).includes(generateForm.providerId) ? (
            <>
              <Input
                value={generateForm.model}
                onChange={(e) => setGenerateForm((f) => ({ ...f, model: e.target.value }))}
                placeholder={t("gallery_model_ph")}
              />
              <button
                type="button"
                onClick={() => setGenerateForm((f) => ({ ...f, showAdvanced: !f.showAdvanced }))}
                className="text-xs text-fg-faint underline-offset-2 hover:underline"
              >
                {t("gallery_advanced_toggle")}
              </button>
              {generateForm.showAdvanced && (
                <TextArea
                  rows={3}
                  value={generateForm.extraInput}
                  onChange={(e) => setGenerateForm((f) => ({ ...f, extraInput: e.target.value }))}
                  placeholder={t("gallery_extra_input_ph")}
                />
              )}
            </>
          ) : generateForm.providerId === "local_sd" ? (
            <>
              <Input
                value={generateForm.negativePrompt}
                onChange={(e) => setGenerateForm((f) => ({ ...f, negativePrompt: e.target.value }))}
                placeholder={t("gallery_negative_prompt_ph")}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  value={generateForm.size}
                  onChange={(e) => setGenerateForm((f) => ({ ...f, size: e.target.value }))}
                  placeholder={t("gallery_generate_size_ph")}
                />
                <Input
                  type="number"
                  value={generateForm.steps}
                  onChange={(e) => setGenerateForm((f) => ({ ...f, steps: e.target.value }))}
                  placeholder={t("gallery_steps_label")}
                />
              </div>
            </>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                value={generateForm.size}
                onChange={(e) => setGenerateForm((f) => ({ ...f, size: e.target.value }))}
                placeholder={t("gallery_generate_size_ph")}
              />
              <Input
                value={generateForm.style}
                onChange={(e) => setGenerateForm((f) => ({ ...f, style: e.target.value }))}
                placeholder={t("gallery_generate_style_ph")}
              />
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="primary" onClick={generate} disabled={generating || !generateForm.prompt.trim()}>
              {generating ? t("gallery_generating") : t("gallery_generate")}
            </Button>
          </div>
        </div>
      )}

      <div className="mb-3 space-y-2">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("gallery_search")} className="w-full" />
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-fg-faint">{t("gallery_filter_provider")}</span>
          <button
            onClick={() => setProviderFilter("")}
            className={`inline-flex min-h-[32px] items-center rounded px-2.5 text-xs border border-line transition-colors ${
              providerFilter === "" ? "bg-[var(--accent)] text-white" : "text-fg-dim hover:text-fg"
            }`}
          >
            {t("gallery_filter_all")}
          </button>
          {IMAGE_PROVIDER_IDS.map((id) => (
            <button
              key={id}
              onClick={() => setProviderFilter((cur) => (cur === id ? "" : id))}
              className={`inline-flex min-h-[32px] items-center rounded px-2.5 text-xs border border-line transition-colors ${
                providerFilter === id ? "bg-[var(--accent)] text-white" : "text-fg-dim hover:text-fg"
              }`}
            >
              {PROVIDER_LABELS[id]}
            </button>
          ))}
          <span className="ml-2 text-xs text-fg-faint">{t("gallery_filter_from")}</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded border border-line bg-surface px-2 py-1 text-xs text-fg"
          />
          <span className="text-xs text-fg-faint">{t("gallery_filter_to")}</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded border border-line bg-surface px-2 py-1 text-xs text-fg"
          />
        </div>
        {allTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-fg-faint">{t("gallery_filter_tag")}</span>
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setTagFilter((cur) => (cur === tag ? null : tag))}
                className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
                  tagFilter === tag ? "bg-[var(--accent)] text-white" : "bg-accent/15 text-accent hover:bg-accent/25"
                }`}
              >
                {tag}
              </button>
            ))}
            {tagFilter && (
              <button onClick={() => setTagFilter(null)} className="text-xs text-fg-faint underline-offset-2 hover:underline">
                {t("gallery_filter_clear")}
              </button>
            )}
          </div>
        )}
      </div>

      {images.length === 0 ? (
        hasFilters ? (
          <Empty>{t("gallery_empty_query")}</Empty>
        ) : (
          <Empty icon={<Images size={40} className="text-accent" />} title={t("gallery_empty")}>
            {t("gallery_empty_desc")}
          </Empty>
        )
      ) : (
        <div ref={listRef} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {images.map((img) => (
            <button
              key={img.id}
              onClick={() => setSelectedImage(img)}
              className="group relative aspect-square overflow-hidden rounded-lg border border-line bg-surface-2 text-left"
            >
              <GalleryThumb
                id={img.id}
                alt={img.prompt}
                className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                onAuthError={onAuthError}
              />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1.5">
                <p className="line-clamp-1 text-xs text-white">{img.prompt}</p>
              </div>
            </button>
          ))}
        </div>
      )}

      {selectedImage && (
        <ImageDetailModal
          image={selectedImage}
          onClose={() => setSelectedImage(null)}
          onAuthError={onAuthError}
          onSaved={(updated) => {
            setSelectedImage(updated);
            setImages((cur) => cur.map((i) => (i.id === updated.id ? updated : i)));
            setAllTags((cur) => Array.from(new Set([...cur, ...updated.tags])).sort());
          }}
          onRequestDelete={(id) => setConfirmDeleteId(id)}
        />
      )}

      {confirmDeleteId && (
        <ConfirmDialog
          title={t("gallery_delete_confirm")}
          confirmLabel={t("delete")}
          busy={deleting}
          onConfirm={doDelete}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </Card>
  );
}
