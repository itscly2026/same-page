import { annotationLayerSummarySchema, annotationPayloadSchema } from "../../shared/annotations";
import { findActiveOfflineScore, type OfflineScoreRecord } from "../platform/local-database";
import { assertLocalWorkspaceActive, type LocalWorkspace } from "../platform/local-workspace";

export async function verifyOfflineScore(record: OfflineScoreRecord) {
  try {
    if (!record.blob.size || !record.verifiedAt || !record.annotationSnapshot?.verifiedAt) return false;
    if (await sha256Hex(await record.blob.arrayBuffer()) !== record.sha256) return false;
    const layers = record.annotationSnapshot.layers;
    const sharedSlots = layers.filter((layer) => layer.kind === "shared").map((layer) => layer.defaultSlot).sort().join(",");
    if (sharedSlots !== "A,B,E,S,T") return false;
    const personalCount = layers.filter((layer) => layer.kind === "personal").length;
    if (personalCount !== (record.ownerKey.startsWith("user:") ? 1 : 0)) return false;
    const layerIds = new Set(layers.map((layer) => layer.id));
    for (const layer of record.annotationSnapshot.layers) {
      annotationLayerSummarySchema.parse(layer);
      if (layer.scopeKey !== record.scopeKey) return false;
    }
    for (const annotation of record.annotationSnapshot.annotations) {
      if (annotation.scopeKey !== record.scopeKey || !layerIds.has(annotation.layerId)) return false;
      if (annotation.payload) annotationPayloadSchema.parse(annotation.payload);
    }
    return true;
  } catch {
    return false;
  }
}

export async function findVerifiedOfflineScore(workspace: LocalWorkspace) {
  await assertLocalWorkspaceActive(workspace);
  const record = await findActiveOfflineScore(workspace.ownerKey, workspace.choirId, workspace.scoreId);
  if (!record || !(await verifyOfflineScore(record))) return null;
  await assertLocalWorkspaceActive(workspace);
  return record;
}

export async function sha256Hex(data: ArrayBuffer) {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
