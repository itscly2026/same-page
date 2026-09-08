import type { LocalWorkspace } from "../platform/local-workspace";
import { assertLocalWorkspaceActive } from "../platform/local-workspace";
import { readScoreAnnotationState } from "../annotations/annotation-state";
import { syncAnnotations, refreshLayerCapabilities } from "../annotations/sync";
import { findVerifiedOfflineScore } from "../offline/offline-score-verification";
import { exportAnnotatedPdf } from "./export-pdf";
import type { PDFDocumentProxy } from "./pdf-document";

export async function exportScore(workspace: LocalWorkspace, source: PDFDocumentProxy, versionId: string, selected: string[], authenticatedUserId: string | null) {
  const online = navigator.onLine;
  let offlineCopy: Awaited<ReturnType<typeof findVerifiedOfflineScore>> = null;
  if (online) {
    if (workspace.ownerKey.startsWith("user:") && workspace.ownerKey !== `user:${authenticatedUserId}`) throw new Error("请先确认登录身份再导出");
    await syncAnnotations(workspace, { pull: true, freshLayers: true, push: false });
  } else if (selected.length) {
    const copy = offlineCopy = await findVerifiedOfflineScore(workspace);
    if (!copy || copy.versionId !== versionId || selected.some(id => !copy.annotationSnapshot.layers.some(layer => layer.id === id))) throw new Error("所选笔记层的完整离线数据尚未准备好，请联网后导出");
  }
  const state = await readScoreAnnotationState(workspace);
  if (selected.some(id => !state.layers.some(layer => layer.id === id))) throw new Error("所选笔记层已不可用，请重新选择后导出");
  const layers = state.layers.filter(layer => selected.includes(layer.id));
  const annotations = [...new Map([...(offlineCopy?.annotationSnapshot.annotations ?? []), ...state.annotations].map(annotation => [annotation.id, annotation])).values()];
  const blob = selected.length ? await exportAnnotatedPdf(source, annotations, layers) : new Blob([new Uint8Array(await source.getData())], { type: "application/pdf" });
  await assertLocalWorkspaceActive(workspace);
  if (online) await refreshLayerCapabilities(workspace, AbortSignal.timeout(30000));
  // A revocation received by another window during rendering must also win.
  const latest = await readScoreAnnotationState(workspace);
  if (selected.some(id => !latest.layers.some(layer => layer.id === id))) throw new Error("笔记层权限已变化，请重新选择后导出");
  return blob;
}
