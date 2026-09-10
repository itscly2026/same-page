import { readScoreAnnotationState, restoreOfflineAnnotationSnapshot } from "../annotations/annotation-state";
import { syncAnnotations } from "../annotations/sync";
import { findVerifiedOfflineScore } from "../offline/offline-score-verification";
import { assertLocalWorkspaceActive, type LocalWorkspace } from "../platform/local-workspace";
import { loadPdfDocument, type PdfDocumentLoad } from "./pdf-document";

// Own the PDF lifetime separately from the reader and offline preparation queue.
export function prepareExport(workspace: LocalWorkspace, versionId: string) {
  let cancelled = false;
  let pdf: PdfDocumentLoad | undefined;
  const promise = (async () => {
    let source: string | ArrayBuffer;
    if (navigator.onLine) {
      await syncAnnotations(workspace, { pull: true, freshLayers: true, push: false });
      source = `/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/versions/${encodeURIComponent(versionId)}/pdf`;
    } else {
      const copy = await findVerifiedOfflineScore(workspace);
      if (!copy || copy.versionId !== versionId) throw new Error("这份谱的完整 PDF 尚未保存在本机，请联网后导出。");
      await restoreOfflineAnnotationSnapshot(workspace, copy);
      source = await copy.blob.arrayBuffer();
    }
    await assertLocalWorkspaceActive(workspace);
    if (cancelled) throw new DOMException("Export cancelled", "AbortError");
    pdf = loadPdfDocument(source, versionId);
    const [{ document }, state] = await Promise.all([pdf.promise, readScoreAnnotationState(workspace)]);
    await assertLocalWorkspaceActive(workspace);
    if (!state.layersReady) throw new Error("笔记层尚未准备好，请联网后重试。");
    return { source: document, layers: state.layers };
  })();
  return { promise, destroy: () => { cancelled = true; void pdf?.destroy().catch(() => undefined); } };
}
