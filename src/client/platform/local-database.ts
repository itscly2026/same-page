import Dexie, { type EntityTable } from "dexie";

import type {
  AnnotationLayerSummary,
  AnnotationObjectRecord,
  AnnotationPayload,
} from "../../shared/annotations";

export interface SystemRecord {
  key: string;
  value: string;
}

export interface OfflineScoreRecord {
  key: string;
  choirId: string;
  scoreId: string;
  versionId: string;
  title: string;
  sha256: string;
  pageCount: number;
  blob: Blob;
  active: 0 | 1;
  verifiedAt: number;
  annotationSnapshot: OfflineAnnotationSnapshot;
}

export interface OfflineAnnotationSnapshot {
  layers: LocalAnnotationLayerRecord[];
  annotations: LocalAnnotationRecord[];
  cursor: number;
  verifiedAt: number;
}

export type LocalAnnotationState = "synced" | "draft" | "pending" | "conflict";

export interface LocalAnnotationRecord {
  key: string;
  scopeKey: string;
  choirId: string;
  scoreId: string;
  id: string;
  layerId: string;
  version: number;
  baseVersion: number;
  deleted: boolean;
  payload: AnnotationPayload | null;
  state: LocalAnnotationState;
  lastOpId: string | null;
  updatedAt: number;
}

export interface AnnotationOutboxRecord {
  opId: string;
  scopeKey: string;
  choirId: string;
  scoreId: string;
  annotationId: string;
  layerId: string;
  baseVersion: number;
  type: "upsert" | "delete";
  payload: AnnotationPayload | null;
  attemptedAt: number | null;
  createdAt: number;
}

export interface AnnotationConflictRecord {
  opId: string;
  scopeKey: string;
  annotationId: string;
  layerId: string;
  localPayload: AnnotationPayload | null;
  localDeleted: boolean;
  canonical: AnnotationObjectRecord | null;
  createdAt: number;
}

export interface AnnotationSyncCursorRecord {
  scopeKey: string;
  cursor: number;
}

export interface GuestLayerPreferenceRecord {
  key: string;
  scopeKey: string;
  layerId: string;
  visible: boolean;
  colorOverride: string | null;
}

export interface SyncLeaseRecord {
  scopeKey: string;
  owner: string;
  expiresAt: number;
}

export interface LocalAnnotationLayerRecord extends AnnotationLayerSummary {
  key: string;
  scopeKey: string;
}

class SamePageDatabase extends Dexie {
  system!: EntityTable<SystemRecord, "key">;
  offlineScores!: EntityTable<OfflineScoreRecord, "key">;
  annotations!: EntityTable<LocalAnnotationRecord, "key">;
  annotationOutbox!: EntityTable<AnnotationOutboxRecord, "opId">;
  annotationConflicts!: EntityTable<AnnotationConflictRecord, "opId">;
  annotationSyncCursors!: EntityTable<AnnotationSyncCursorRecord, "scopeKey">;
  guestLayerPreferences!: EntityTable<GuestLayerPreferenceRecord, "key">;
  syncLeases!: EntityTable<SyncLeaseRecord, "scopeKey">;
  annotationLayers!: EntityTable<LocalAnnotationLayerRecord, "key">;

  constructor() {
    super("same-page");
    this.version(1).stores({
      system: "&key",
    });
    this.version(2).stores({
      system: "&key",
      offlineScores: "&key,[choirId+scoreId],versionId,active,verifiedAt",
    });
    this.version(3).stores({
      system: "&key",
      offlineScores: "&key,[choirId+scoreId],versionId,active,verifiedAt",
      annotations: "&key,scopeKey,[scopeKey+layerId],[scopeKey+state],id,updatedAt",
      annotationOutbox: "&opId,scopeKey,[scopeKey+annotationId],createdAt",
      annotationConflicts: "&opId,scopeKey,[scopeKey+annotationId],createdAt",
      annotationSyncCursors: "&scopeKey",
      guestLayerPreferences: "&key,scopeKey,[scopeKey+layerId]",
      syncLeases: "&scopeKey,expiresAt",
    });
    this.version(4).stores({
      system: "&key",
      offlineScores: "&key,[choirId+scoreId],versionId,active,verifiedAt",
      annotations: "&key,scopeKey,[scopeKey+layerId],[scopeKey+state],id,updatedAt",
      annotationOutbox: "&opId,scopeKey,[scopeKey+annotationId],createdAt",
      annotationConflicts: "&opId,scopeKey,[scopeKey+annotationId],createdAt",
      annotationSyncCursors: "&scopeKey",
      guestLayerPreferences: "&key,scopeKey,[scopeKey+layerId]",
      syncLeases: "&scopeKey,expiresAt",
      annotationLayers: "&key,scopeKey,[scopeKey+id],kind,sortOrder",
    });
  }
}

export const localDatabase = new SamePageDatabase();

export async function verifyLocalDatabase(): Promise<void> {
  await localDatabase.open();
}

export async function activateVerifiedOfflineScore(
  record: Omit<OfflineScoreRecord, "active" | "verifiedAt">,
) {
  await localDatabase.transaction("rw", localDatabase.offlineScores, async () => {
    const existing = await localDatabase.offlineScores
      .where("[choirId+scoreId]")
      .equals([record.choirId, record.scoreId])
      .toArray();
    await Promise.all(
      existing.map((entry) =>
        localDatabase.offlineScores.update(entry.key, { active: 0 }),
      ),
    );
    await localDatabase.offlineScores.put({
      ...record,
      active: 1,
      verifiedAt: Date.now(),
    });
  });
}

export function findActiveOfflineScore(choirId: string, scoreId: string) {
  return localDatabase.offlineScores
    .where("[choirId+scoreId]")
    .equals([choirId, scoreId])
    .filter((record) => record.active === 1)
    .first();
}

export function annotationScopeKey(choirId: string, scoreId: string) {
  return `${choirId}:${scoreId}`;
}

export function annotationRecordKey(scopeKey: string, annotationId: string) {
  return `${scopeKey}:${annotationId}`;
}
