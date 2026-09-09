import { diagnosticScope, diagnosticErrorType } from "../diagnostics/diagnostics";
import { diagnoseLocalOperation } from "../diagnostics/local-operation";
import type { DiagnosticStep } from "../../shared/diagnostics";
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
  return verifyOfflineScoreWithDiagnostics(record, diagnosticScope());
}

function verifyOfflineScoreWithDiagnostics(record: OfflineScoreRecord, report: ReturnType<typeof diagnosticScope>) {
  if (!(record.blob instanceof Blob)) {
    report({ operation: "storage", category: "validation", stage: "decode", step: "offline-file", errorType: "ValidationError" });
    return Promise.resolve(false);
  }
  const identity = JSON.stringify([record.key, record.verifiedAt, record.sha256, record.blob.size, record.annotationSnapshot, record.imageManifest]);
  let tasks = verificationTasks.get(record.blob);
  if (!tasks) { tasks = new Map(); verificationTasks.set(record.blob, tasks); }
  let task = tasks.get(identity);
  if (!task) {
    task = (async () => {
      if (running >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
      else running++;
      try { return await verifyRecord(record, report); }
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

async function verifyRecord(record: OfflineScoreRecord, report: ReturnType<typeof diagnosticScope>) {
  let step: DiagnosticStep = "offline-file";
  const invalid = () => {
    report({ operation: "storage", category: "validation", stage: "decode", step, errorType: "ValidationError" });
    return false;
  };
  try {
    if (!record.blob.size || !record.verifiedAt) return invalid();
    if (await sha256Hex(await readOfflineFileBytes(record.blob)) !== record.sha256) return invalid();
    if (record.imageManifest) {
      step = "offline-manifest";
      const manifest = imageManifestSchema.parse(record.imageManifest);
      if (manifest.versionId !== record.versionId || manifest.pages.length !== record.pageCount) return invalid();
      let offset = 0;
      for (const page of manifest.pages) {
        const asset = page.assets[0];
        const bytes = await readOfflineFileBytes(record.blob.slice(offset, offset + asset.sizeBytes));
        if (bytes.byteLength !== asset.sizeBytes || await sha256Hex(bytes) !== asset.sha256) return invalid();
        if (bytes.byteLength < 24) return invalid();
        const header = new DataView(bytes);
        if (header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a || header.getUint32(16) !== asset.width || header.getUint32(20) !== asset.height) return invalid();
        offset += asset.sizeBytes;
      }
      if (offset !== record.blob.size) return invalid();
    }
    step = "offline-snapshot";
    if (!record.annotationSnapshot?.verifiedAt) return invalid();
    const layers = record.annotationSnapshot.layers;
    if (!Array.isArray(layers) || !Array.isArray(record.annotationSnapshot.annotations)) return invalid();
    for (const layer of record.annotationSnapshot.layers) {
      annotationLayerSummarySchema.parse(layer);
      if (layer.scopeKey !== record.scopeKey) return invalid();
    }
    if (!hasCompleteOfflineLayers(layers, record.ownerKey)) return invalid();
    const layerIds = new Set(layers.map((layer) => layer.id));
    for (const annotation of record.annotationSnapshot.annotations) {
      if (typeof annotation !== "object" || annotation === null) return invalid();
      if (annotation.scopeKey !== record.scopeKey || !layerIds.has(annotation.layerId)) return invalid();
      if (annotation.payload) annotationPayloadSchema.parse(annotation.payload);
    }
    return true;
  } catch (error) {
    if (diagnosticErrorType(error) === "ValidationError") return invalid();
    report({ operation: "storage", category: "internal", stage: "decode", step, errorType: diagnosticErrorType(error) });
    throw error;
  }
}

export function hasCompleteOfflineLayers(layers: AnnotationLayerSummary[], ownerKey: string) {
  const ownPersonal = layers.filter(layer => layer.kind === "personal" && (layer.canEdit || !layer.sharing));
  const shared = layers.filter(layer => layer.kind === "shared");
  return new Set(shared.map(layer => layer.sharedSlot)).size === shared.length
    && shared.every(layer => !!layer.sharedSlot)
    && (ownerKey.startsWith("user:") ? ownPersonal.length >= 1 : ownPersonal.length === 0);
}

type OfflineInspection = { record: OfflineScoreRecord | null; invalid: boolean };
const inspections = new Map<string, Promise<OfflineInspection>>();
// A committed mutation invalidates sharing, including writes from another tab.
// Thus a newly read corrupt replacement cannot inherit an older in-flight result.
Dexie.on("storagemutated", () => inspections.clear());

export async function inspectOfflineScore(workspace: LocalWorkspace, report = diagnosticScope()): Promise<OfflineInspection> {
  await assertLocalWorkspaceActive(workspace);
  const identity = JSON.stringify([workspace.scopeKey, workspace.sessionEpoch]);
  let task = inspections.get(identity);
  if (!task) {
    task = (async () => {
      const record = await diagnoseLocalOperation("offline-read", () => findActiveOfflineScore(workspace.ownerKey, workspace.choirId, workspace.scoreId), { report });
      const valid = record ? await verifyOfflineScoreWithDiagnostics(record, report) : false;
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

// Some storage engines can leave a Blob read pending. Release verification slots
// and let the reader choose its online source without waiting indefinitely.
export function readOfflineFileBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DOMException("offline_file_read_timeout", "TimeoutError")), 15_000);
    void blob.arrayBuffer().then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
