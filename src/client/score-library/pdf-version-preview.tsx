import { useCallback, useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { annotationLayerListResponseSchema, annotationPullResponseSchema, type AnnotationObjectRecord } from "../../shared/annotations";
import { authClient } from "../auth/auth-client";
import { AnnotationOverlay } from "../annotations/annotation-overlay";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { type LocalAnnotationRecord } from "../platform/local-database";
import { createLocalWorkspace, currentLocalOwnerKey, assertLocalWorkspaceActive, type LocalWorkspace } from "../platform/local-workspace";
import { loadPdfDocument, type PDFDocumentProxy } from "../reader/pdf-document";
import { PdfPageCanvas } from "../reader/pdf-page";

type Preview = {
  document: PDFDocumentProxy;
  workspace: LocalWorkspace;
  layers: ReturnType<typeof annotationLayerListResponseSchema.parse>["layers"];
  annotations: LocalAnnotationRecord[];
};

export function PdfVersionPreview({ scorePath, choirId, scoreId, versionId, onReady }: {
  scorePath: string; choirId: string; scoreId: string; versionId: string;
  onReady(ready: boolean): void;
}) {
  const session = authClient.useSession();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [page, setPage] = useState(1);
  const [ratio, setRatio] = useState(0.707);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const loading = loadPdfDocument(`${scorePath}/versions/${versionId}/pdf`, versionId);
    const load = async () => {
      const owner = await currentLocalOwnerKey();
      if (!owner?.startsWith("user:")) throw new Error("user_required");
      const workspace = createLocalWorkspace(owner, choirId, scoreId);
      const fetchJson = async (path: string) => {
        const response = await diagnosticFetch(path, { signal: controller.signal });
        if (!response.ok) throw new Error("preview_unavailable");
        return response;
      };
      const layers = await parseDiagnosticResponse(await fetchJson(`${scorePath}/layers`), annotationLayerListResponseSchema);
      const objects = new Map<string, AnnotationObjectRecord>();
      let cursor = 0;
      // Pull through the public paginated API, without changing the local cursor/outbox.
      for (;;) {
        const batch = await parseDiagnosticResponse(await fetchJson(`${scorePath}/annotations?cursor=${cursor}`), annotationPullResponseSchema);
        for (const object of batch.objects) objects.set(object.id, object);
        if (batch.cursor === cursor) break;
        cursor = batch.cursor;
      }
      const { document } = await loading.promise;
      await assertLocalWorkspaceActive(workspace);
      if (cancelled) return;
      setPreview({ document, workspace, layers: layers.layers.map((layer) => ({ ...layer, subscribed: true })),
        annotations: [...objects.values()].map((object) => ({
          ...object, key: object.id, ownerKey: owner, scopeKey: workspace.scopeKey,
          choirId, scoreId, baseVersion: object.version, state: "synced", lastOpId: null, syncErrorCode: null,
        })),
      });
    };
    void load().catch(() => { if (!cancelled) setError(true); });
    // Observe early PDF failures even while annotations are loading.
    void loading.promise.catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; controller.abort(); void loading.destroy(); };
  }, [scorePath, choirId, scoreId, versionId]);
  useEffect(() => {
    let cancelled = false;
    if (preview) void preview.document.getPage(page).then((pdfPage) => {
      const viewport = pdfPage.getViewport({ scale: 1 });
      if (!cancelled) setRatio(viewport.width / viewport.height);
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [preview, page]);
  const renderStart = useCallback(() => {
    onReady(false);
    return { ready: () => onReady(true), cancel: () => onReady(false) };
  }, [onReady]);
  if (preview && (session.isPending || `user:${session.data?.user.id}` !== preview.workspace.ownerKey)) return <p role="alert">登录身份已变化，请重新打开预览。</p>;
  if (error) return <p role="alert">预览加载失败，请关闭后重试。</p>;
  if (!preview) return <p role="status">正在加载 PDF 与批注…</p>;
  return <section aria-label="PDF 与现有批注预览">
    <p>显示云端共享批注与本人的个人批注；本机未同步草稿不参与此预览。</p>
    <div className="pdf-version-preview" style={{ aspectRatio: String(ratio) }}>
      <PdfPageCanvas document={preview.document} pageNumber={page} width={600} aspectRatio={ratio} onRenderStart={renderStart} />
      <AnnotationOverlay workspace={preview.workspace} layers={preview.layers} annotations={preview.annotations}
        pageNumber={page} editing={false} tool="text" activeLayerId={null} />
    </div>
    <div className="pdf-version-preview__pages">
      <Button className="secondary-button" isDisabled={page === 1} onPress={() => setPage(page - 1)}>上一页</Button>
      <span>{page} / {preview.document.numPages}</span>
      <Button className="secondary-button" isDisabled={page === preview.document.numPages} onPress={() => setPage(page + 1)}>下一页</Button>
    </div>
  </section>;
}
