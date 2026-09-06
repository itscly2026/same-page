import { captureOfflineFileFence } from "./local-files";
import { imageManifestSchema, pageImagePath, scoreImagesPath, type ScoreDisplayMode, type ImageManifest } from "../../shared/score-images";
import { prepareImageManifest } from "../reader/image-document";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import type { ScoreSummary } from "../../shared/scores";
import { captureOfflineAnnotationSnapshot, ensureOfflineAppShell } from "../annotations/offline-snapshot";
import { syncAnnotations } from "../annotations/sync";
import { activateVerifiedOfflineScore, findActiveOfflineScore } from "../platform/local-database";
import { assertLocalWorkspaceActive, captureLocalWorkspaceSession, localWorkspaceRecordKey, type LocalWorkspace } from "../platform/local-workspace";

import { findVerifiedOfflineScore, sha256Hex, verifyOfflineScore } from "./offline-score-verification";

// Both entry points use the same verified replacement path. A failed attempt never
// activates the new PDF or removes the previous copy or local drafts. Confirmed
// publication revocations still scrub inaccessible notes, even on failure.
export async function prepareOfflineScore(workspace: LocalWorkspace, score: ScoreSummary, mode: ScoreDisplayMode = "pdf", signal = new AbortController().signal, pdfData?: Uint8Array, fileFence?: string) {
  signal.throwIfAborted();
  fileFence ??= await captureOfflineFileFence(workspace);
  workspace = await captureLocalWorkspaceSession(workspace);
  if (workspace.choirId !== score.choirId || workspace.scoreId !== score.id) throw new Error("offline_score_scope_mismatch");
  const previous = await findActiveOfflineScore(workspace.ownerKey, workspace.choirId, workspace.scoreId);
  const base = `/api/choirs/${encodeURIComponent(score.choirId)}/scores/${encodeURIComponent(score.id)}`;
  let blob: Blob, hash: string, imageManifest: ImageManifest | undefined;
  if (mode === "images") {
    imageManifest = await prepareImageManifest(workspace, score.currentVersion.id, score.currentVersion.sha256, signal);
    if (imageManifest.pages.reduce((sum, page) => sum + page.assets[0].sizeBytes, 0) > 64 * 1024 * 1024) throw new Error("offline_image_memory_limit");
    const pieces: ArrayBuffer[] = [];
    const imageBase = scoreImagesPath(score.choirId, score.id, score.currentVersion.id);
    for (const page of imageManifest.pages) {
      signal.throwIfAborted();
      await assertLocalWorkspaceActive(workspace);
      const asset = page.assets[0];
      const response = await diagnosticFetch(pageImagePath(imageBase, imageManifest, page.pageNumber, asset.edge), { signal });
      if (!response.ok) throw new Error("offline_image_download_failed");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== asset.sizeBytes || await sha256Hex(bytes) !== asset.sha256) throw new Error("offline_image_checksum_mismatch");
      await verifyImageDecode(new Blob([bytes], { type: "image/png" }), asset.width, asset.height);
      pieces.push(bytes);
    }
    blob = new Blob(pieces, { type: "application/octet-stream" });
    hash = await sha256Hex(await blob.arrayBuffer());
  } else {
    let data: ArrayBuffer;
    if (pdfData) {
      data = pdfData.slice().buffer;
    } else {
      const response = await diagnosticFetch(`${base}/versions/${encodeURIComponent(score.currentVersion.id)}/pdf`, { signal });
      if (!response.ok) throw new Error("offline_pdf_download_failed");
      data = await response.arrayBuffer();
    }
    if (data.byteLength !== score.currentVersion.sizeBytes || await sha256Hex(data) !== score.currentVersion.sha256) throw new Error("offline_pdf_checksum_mismatch");
    blob = new Blob([data], { type: "application/pdf" });
    hash = score.currentVersion.sha256;
  }
  signal.throwIfAborted();
  await ensureOfflineAppShell();
  signal.throwIfAborted();
  await assertLocalWorkspaceActive(workspace);
  // This call requires a layer request started after the bytes are prepared;
  // an earlier reader refresh cannot establish fresh access for activation.
  await syncAnnotations(workspace, { pull: true, signal });
  signal.throwIfAborted();
  const annotationSnapshot = await captureOfflineAnnotationSnapshot(workspace);
  const record = {
    key: localWorkspaceRecordKey(workspace, `${score.currentVersion.id}:${mode}`), ...workspace,
    versionId: score.currentVersion.id, fileName: score.fileName,
    sha256: hash, pageCount: score.currentVersion.pageCount,
    blob, ...(imageManifest ? { imageManifest: imageManifestSchema.parse(imageManifest) } : {}), annotationSnapshot,
  };
  if (!(await verifyOfflineScore({ ...record, active: 1, verifiedAt: Date.now() }))) throw new Error("offline_annotation_snapshot_incomplete");
  signal.throwIfAborted();
  await activateVerifiedOfflineScore(record, { activeKey: previous?.key ?? null, fileFence });
  const verified = await findVerifiedOfflineScore(workspace);
  if (!verified) throw new Error("offline_copy_unavailable");
  return verified;
}

async function verifyImageDecode(blob: Blob, width: number, height: number) {
  const url = URL.createObjectURL(blob), image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("offline_image_decode_timeout")), 20_000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error("offline_image_corrupt")); };
      image.src = url;
    });
    if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error("offline_image_dimensions_mismatch");
  } finally { image.src = ""; URL.revokeObjectURL(url); }
}
