import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { annotationLayerListResponseSchema } from "../../shared/annotations";
import type { ScoreSummary } from "../../shared/scores";
import { cacheAnnotationLayers } from "../annotations/local-annotations";
import { captureOfflineAnnotationSnapshot, ensureOfflineAppShell } from "../annotations/offline-snapshot";
import { syncAnnotations } from "../annotations/sync";
import { activateVerifiedOfflineScore, localDatabase } from "../platform/local-database";
import { assertLocalWorkspaceActive, localWorkspaceRecordKey, type LocalWorkspace } from "../platform/local-workspace";

import { findVerifiedOfflineScore, hasCompleteOfflineLayers, sha256Hex, verifyOfflineScore } from "./offline-score-verification";

// Both entry points use the same verified replacement path. A failed attempt never
// activates the new PDF or removes the existing copy, annotations, or drafts.
export async function prepareOfflineScore(workspace: LocalWorkspace, score: ScoreSummary) {
  await assertLocalWorkspaceActive(workspace);
  if (workspace.choirId !== score.choirId || workspace.scoreId !== score.id) throw new Error("offline_score_scope_mismatch");
  const base = `/api/choirs/${encodeURIComponent(score.choirId)}/scores/${encodeURIComponent(score.id)}`;
  const response = await diagnosticFetch(`${base}/versions/${encodeURIComponent(score.currentVersion.id)}/pdf`);
  if (!response.ok) throw new Error("offline_pdf_download_failed");
  const data = await response.arrayBuffer();
  if (data.byteLength !== score.currentVersion.sizeBytes || await sha256Hex(data) !== score.currentVersion.sha256) throw new Error("offline_pdf_checksum_mismatch");
  await ensureOfflineAppShell();
  await assertLocalWorkspaceActive(workspace);
  const layerResponse = await diagnosticFetch(`${base}/layers`);
  if (!layerResponse.ok) throw new Error("offline_layer_download_failed");
  const { layers } = await parseDiagnosticResponse(layerResponse, annotationLayerListResponseSchema);
  // An expired user can keep their local copy, but a guest API response must
  // never replace that user's private layer metadata while preparing a download.
  if (!hasCompleteOfflineLayers(layers, workspace.ownerKey)) throw new Error("offline_download_requires_matching_identity");
  const existing = await localDatabase.annotationLayers.where("scopeKey").equals(workspace.scopeKey).toArray();
  const currentById = new Map(existing.map((layer) => [layer.id, layer]));
  await cacheAnnotationLayers(workspace, workspace.ownerKey.startsWith("user:") ? layers : layers.map((layer) => ({
    ...layer, subscribed: currentById.get(layer.id)?.subscribed ?? layer.subscribed,
  })));
  const synced = await syncAnnotations(workspace, { pull: true });
  if (!synced) throw new Error("offline_annotation_sync_busy");
  const annotationSnapshot = await captureOfflineAnnotationSnapshot(workspace);
  const record = {
    key: localWorkspaceRecordKey(workspace, score.currentVersion.id), ...workspace,
    versionId: score.currentVersion.id, fileName: score.fileName,
    sha256: score.currentVersion.sha256, pageCount: score.currentVersion.pageCount,
    blob: new Blob([data], { type: "application/pdf" }), annotationSnapshot,
  };
  if (!(await verifyOfflineScore({ ...record, active: 1, verifiedAt: Date.now() }))) throw new Error("offline_annotation_snapshot_incomplete");
  await activateVerifiedOfflineScore(record);
  const verified = await findVerifiedOfflineScore(workspace);
  if (!verified) throw new Error("offline_copy_unavailable");
  return verified;
}
