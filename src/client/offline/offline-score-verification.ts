import { imageManifestSchema } from "../../shared/score-images";
import Dexie from "dexie";
import { annotationLayerSummarySchema, annotationPayloadSchema, type AnnotationLayerSummary } from "../../shared/annotations";
import { findActiveOfflineScore, type OfflineScoreRecord } from "../platform/local-database";
import { assertLocalWorkspaceActive, type LocalWorkspace } from "../platform/local-workspace";

const verificationTasks = new WeakMap<Blob, Map<string, Promise<boolean>>>();
const waiting: Array<() => void> = [];
let running = 0;

// Deduplicate only in-flight checks. Opening again always validates current bytes.
export function verifyOfflineScore(record: OfflineScoreRecord) {
  const identity = JSON.stringify([record.key, record.verifiedAt, record.sha256, record.blob.size, record.annotationSnapshot, record.imageManifest]);
  let tasks = verificationTasks.get(record.blob);
  if (!tasks) { tasks = new Map(); verificationTasks.set(record.blob, tasks); }
  let task = tasks.get(identity);
  if (!task) {
    task = (async () => {
      if (running >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
      else running++;
      try { return await verifyRecord(record); }
      finally {
        const next = waiting.shift();
        if (next) next();
        else running--;
        tasks.delete(identity);
      }
    })();
    tasks.set(identity, task);
  }
  return task;
}

async function verifyRecord(record: OfflineScoreRecord) {
  try {
    if (!record.blob.size || !record.verifiedAt || !record.annotationSnapshot?.verifiedAt) return false;
    if (await sha256Hex(await record.blob.arrayBuffer()) !== record.sha256) return false;
    if (record.imageManifest) {
      const manifest = imageManifestSchema.parse(record.imageManifest);
      if (manifest.versionId !== record.versionId || manifest.pages.length !== record.pageCount) return false;
      let offset = 0;
      for (const page of manifest.pages) {
        const asset = page.assets[0];
        const bytes = await record.blob.slice(offset, offset + asset.sizeBytes).arrayBuffer();
        if (bytes.byteLength !== asset.sizeBytes || await sha256Hex(bytes) !== asset.sha256) return false;
        if (bytes.byteLength < 24) return false;
        const header = new DataView(bytes);
        if (header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a || header.getUint32(16) !== asset.width || header.getUint32(20) !== asset.height) return false;
        offset += asset.sizeBytes;
      }
      if (offset !== record.blob.size) return false;
    }
    const layers = record.annotationSnapshot.layers;
    if (!hasCompleteOfflineLayers(layers, record.ownerKey)) return false;
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

export function hasCompleteOfflineLayers(layers: AnnotationLayerSummary[], ownerKey: string) {
  const sharedSlots = layers.filter((layer) => layer.kind === "shared").map((layer) => layer.defaultSlot).sort().join(",");
  const personalCount = layers.filter((layer) => layer.kind === "personal").length;
  return sharedSlots === "A,B,E,S,T" && personalCount === (ownerKey.startsWith("user:") ? 1 : 0);
}

type OfflineInspection = { record: OfflineScoreRecord | null; invalid: boolean };
const inspections = new Map<string, Promise<OfflineInspection>>();
// A committed mutation invalidates sharing, including writes from another tab.
// Thus a newly read corrupt replacement cannot inherit an older in-flight result.
Dexie.on("storagemutated", () => inspections.clear());

export async function inspectOfflineScore(workspace: LocalWorkspace): Promise<OfflineInspection> {
  await assertLocalWorkspaceActive(workspace);
  const identity = JSON.stringify([workspace.scopeKey, workspace.sessionEpoch]);
  let task = inspections.get(identity);
  if (!task) {
    task = (async () => {
      const record = await findActiveOfflineScore(workspace.ownerKey, workspace.choirId, workspace.scoreId);
      const valid = record ? await verifyOfflineScore(record) : false;
      return { record: valid ? record ?? null : null, invalid: Boolean(record && !valid) };
    })();
    inspections.set(identity, task);
    const current = task;
    void task.finally(() => { if (inspections.get(identity) === current) inspections.delete(identity); }).catch(() => undefined);
  }
  const result = await task;
  await assertLocalWorkspaceActive(workspace);
  return result;
}

export async function findVerifiedOfflineScore(workspace: LocalWorkspace) {
  return (await inspectOfflineScore(workspace)).record;
}

export async function sha256Hex(data: ArrayBuffer) {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
