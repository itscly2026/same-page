import Dexie, { type EntityTable, type Table, type Transaction } from "dexie";

import type {
  AnnotationLayerSummary,
  AnnotationObjectRecord,
  AnnotationPayload,
} from "../../shared/annotations";
import { DEFAULT_TEXT_FONT_SCALE } from "../../shared/annotations";
import type { LocalWorkspaceOwnerKey } from "./local-workspace";

export const LAST_AUTHENTICATED_OWNER_KEY =
  "local-workspace:last-authenticated-owner";
export const ACTIVE_LOCAL_OWNER_KEY = "local-workspace:active-owner";
export const LEGACY_LAST_AUTHENTICATED_USER_ID_KEY =
  "last-authenticated-user-id";
export const guestOwnerSystemKey = (choirId: string) =>
  `local-workspace:guest-owner:${choirId}`;

export interface SystemRecord {
  key: string;
  value: string;
}

export interface OfflineScoreRecord {
  key: string;
  ownerKey: LocalWorkspaceOwnerKey;
  scopeKey: string;
  choirId: string;
  scoreId: string;
  versionId: string;
  fileName: string;
  sha256: string;
  pageCount: number;
  // PDF bytes, or the ordered lossless offline page bundle described by imageManifest.
  blob: Blob;
  imageManifest?: import("../../shared/score-images").ImageManifest;
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

export type LocalAnnotationState =
  | "synced"
  | "draft"
  | "pending"
  | "conflict"
  | "sync-error";

export type AnnotationSyncErrorCode = "op_id_reused" | "permission_denied";

export interface LocalAnnotationRecord {
  key: string;
  ownerKey: LocalWorkspaceOwnerKey;
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
  syncErrorCode: AnnotationSyncErrorCode | null;
  updatedAt: number;
}

export interface AnnotationOutboxRecord {
  opId: string;
  ownerKey: LocalWorkspaceOwnerKey;
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
  ownerKey: LocalWorkspaceOwnerKey;
  scopeKey: string;
  choirId: string;
  scoreId: string;
  annotationId: string;
  layerId: string;
  localPayload: AnnotationPayload | null;
  localDeleted: boolean;
  canonical: AnnotationObjectRecord | null;
  createdAt: number;
}

export interface AnnotationSyncCursorRecord {
  ownerKey: LocalWorkspaceOwnerKey;
  scopeKey: string;
  choirId: string;
  scoreId: string;
  cursor: number;
  layerIds?: string[];
}

export interface GuestLayerPreferenceRecord {
  key: string;
  ownerKey: LocalWorkspaceOwnerKey;
  scopeKey: string;
  choirId: string;
  scoreId: string;
  layerId: string;
  visible: boolean;
}

export interface SyncLeaseRecord {
  ownerKey: LocalWorkspaceOwnerKey;
  scopeKey: string;
  choirId: string;
  scoreId: string;
  lockOwner: string;
  expiresAt: number;
}

export interface LocalAnnotationLayerRecord extends AnnotationLayerSummary {
  key: string;
  ownerKey: LocalWorkspaceOwnerKey;
  scopeKey: string;
  choirId: string;
  scoreId: string;
}

export class SamePageDatabase extends Dexie {
  system!: EntityTable<SystemRecord, "key">;
  offlineScores!: EntityTable<OfflineScoreRecord, "key">;
  annotations!: EntityTable<LocalAnnotationRecord, "key">;
  annotationOutbox!: EntityTable<AnnotationOutboxRecord, "opId">;
  annotationConflicts!: EntityTable<AnnotationConflictRecord, "opId">;
  annotationSyncCursors!: EntityTable<AnnotationSyncCursorRecord, "scopeKey">;
  guestLayerPreferences!: EntityTable<GuestLayerPreferenceRecord, "key">;
  syncLeases!: EntityTable<SyncLeaseRecord, "scopeKey">;
  annotationLayers!: EntityTable<LocalAnnotationLayerRecord, "key">;

  constructor(name = "same-page") {
    super(name);
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
    this.version(5)
      .stores({
        system: "&key",
        offlineScores:
          "&key,ownerKey,scopeKey,[ownerKey+choirId+scoreId],versionId,active,verifiedAt",
        annotations:
          "&key,ownerKey,scopeKey,[scopeKey+layerId],[scopeKey+state],id,updatedAt",
        annotationOutbox:
          "&opId,ownerKey,scopeKey,[scopeKey+annotationId],createdAt",
        annotationConflicts:
          "&opId,ownerKey,scopeKey,[scopeKey+annotationId],createdAt",
        annotationSyncCursors: "&scopeKey,ownerKey,[ownerKey+choirId+scoreId]",
        guestLayerPreferences:
          "&key,ownerKey,scopeKey,[scopeKey+layerId]",
        syncLeases: "&scopeKey,ownerKey,expiresAt",
        annotationLayers:
          "&key,ownerKey,scopeKey,[scopeKey+id],kind,sortOrder",
      })
      .upgrade(migrateLegacyLocalWorkspaces);
    this.version(6)
      .stores({
        system: "&key",
        offlineScores:
          "&key,ownerKey,scopeKey,[ownerKey+choirId+scoreId],versionId,active,verifiedAt",
        annotations:
          "&key,ownerKey,scopeKey,[scopeKey+layerId],[scopeKey+state],id,updatedAt",
        annotationOutbox:
          "&opId,ownerKey,scopeKey,[scopeKey+annotationId],createdAt",
        annotationConflicts:
          "&opId,ownerKey,scopeKey,[scopeKey+annotationId],createdAt",
        annotationSyncCursors: "&scopeKey,ownerKey,[ownerKey+choirId+scoreId]",
        guestLayerPreferences:
          "&key,ownerKey,scopeKey,[scopeKey+layerId]",
        syncLeases: "&scopeKey,ownerKey,expiresAt",
        annotationLayers:
          "&key,ownerKey,scopeKey,[scopeKey+id],kind,sortOrder",
      })
      .upgrade(migrateStoredTextPayloads);
    this.version(7)
      .stores({
        system: "&key",
        offlineScores:
          "&key,ownerKey,scopeKey,[ownerKey+choirId+scoreId],versionId,active,verifiedAt",
        annotations:
          "&key,ownerKey,scopeKey,[scopeKey+layerId],[scopeKey+state],id,updatedAt",
        annotationOutbox:
          "&opId,ownerKey,scopeKey,[scopeKey+annotationId],createdAt",
        annotationConflicts:
          "&opId,ownerKey,scopeKey,[scopeKey+annotationId],createdAt",
        annotationSyncCursors: "&scopeKey,ownerKey,[ownerKey+choirId+scoreId]",
        guestLayerPreferences:
          "&key,ownerKey,scopeKey,[scopeKey+layerId]",
        syncLeases: "&scopeKey,ownerKey,expiresAt",
        annotationLayers:
          "&key,ownerKey,scopeKey,[scopeKey+id],kind,sortOrder",
      })
      .upgrade(clearSupersededLayerModelData);
    this.version(8).stores({
      annotationOutbox: "&opId,ownerKey,scopeKey,[ownerKey+scopeKey],[scopeKey+annotationId],createdAt",
    });
    this.version(9).stores({}).upgrade(async transaction => {
      const renameSlot = (layer: Record<string, unknown>) => {
        layer.sharedSlot = layer.defaultSlot;
        delete layer.defaultSlot;
      };
      await transaction.table("annotationLayers").toCollection().modify(renameSlot);
      await transaction.table("offlineScores").toCollection().modify((record: OfflineScoreRecord) => {
        for (const layer of record.annotationSnapshot?.layers ?? []) renameSlot(layer as unknown as Record<string, unknown>);
      });
    });
  }
}

async function clearSupersededLayerModelData(transaction: Transaction) {
  await Promise.all([
    "offlineScores",
    "annotations",
    "annotationOutbox",
    "annotationConflicts",
    "annotationSyncCursors",
    "guestLayerPreferences",
    "syncLeases",
    "annotationLayers",
  ].map((table) => transaction.table(table).clear()));
}

async function migrateStoredTextPayloads(transaction: Transaction) {
  await transaction
    .table<LocalAnnotationRecord, string>("annotations")
    .toCollection()
    .modify((record) => {
      record.payload = migrateStoredTextPayload(record.payload);
    });
  await transaction
    .table<AnnotationOutboxRecord, string>("annotationOutbox")
    .toCollection()
    .modify((record) => {
      record.payload = migrateStoredTextPayload(record.payload);
    });
  await transaction
    .table<AnnotationConflictRecord, string>("annotationConflicts")
    .toCollection()
    .modify((record) => {
      record.localPayload = migrateStoredTextPayload(record.localPayload);
      if (record.canonical) {
        record.canonical.payload = migrateStoredTextPayload(record.canonical.payload);
      }
    });
  await transaction
    .table<OfflineScoreRecord, string>("offlineScores")
    .toCollection()
    .modify((record) => {
      if (!record.annotationSnapshot) return;
      record.annotationSnapshot.annotations =
        record.annotationSnapshot.annotations.map((annotation) => ({
          ...annotation,
          payload: migrateStoredTextPayload(annotation.payload),
        }));
    });
}

export function migrateStoredTextPayload(payload: AnnotationPayload | null) {
  if (!payload || payload.kind !== "text" || "fontScale" in payload) return payload;
  const legacy = payload as unknown as Omit<
    Extract<AnnotationPayload, { kind: "text" }>,
    "fontScale"
  >;
  return { ...legacy, fontScale: DEFAULT_TEXT_FONT_SCALE };
}

export const localDatabase = new SamePageDatabase();

export async function activateVerifiedOfflineScore(
  record: Omit<OfflineScoreRecord, "active" | "verifiedAt"> & { sessionEpoch?: string },
  expected?: { activeKey: string | null },
) {
  await localDatabase.transaction(
    "rw",
    [localDatabase.system, localDatabase.offlineScores, localDatabase.annotationLayers, localDatabase.annotations, localDatabase.annotationSyncCursors],
    async () => {
      const activeOwner = await localDatabase.system.get(ACTIVE_LOCAL_OWNER_KEY);
      const guestOwner = record.ownerKey.startsWith("guest:")
        ? await localDatabase.system.get(guestOwnerSystemKey(record.choirId))
        : null;
      const ownerIsActive = record.ownerKey.startsWith("user:")
        ? activeOwner?.value === record.ownerKey
        : !activeOwner?.value.startsWith("user:") &&
          guestOwner?.value === record.ownerKey;
      const epoch = (await localDatabase.system.get("local-workspace:epoch"))?.value ?? "";
      if (!ownerIsActive || (record.sessionEpoch !== undefined && record.sessionEpoch !== epoch)) throw new Error("local_workspace_owner_changed");
      const existing = await localDatabase.offlineScores
        .where("[ownerKey+choirId+scoreId]")
        .equals([record.ownerKey, record.choirId, record.scoreId])
        .toArray();
      if (expected && (existing.find((entry) => entry.active === 1)?.key ?? null) !== expected.activeKey) {
        if (existing.some((entry) => entry.active === 1 && entry.key === record.key)) return;
        throw new Error("offline_copy_changed_during_download");
      }
      // A download can be verified while another sync revokes layer access.
      // Capture metadata and notes under the same transaction that activates the
      // bytes; an older in-memory candidate must never restore that access.
      const layers = await localDatabase.annotationLayers.where("scopeKey").equals(record.scopeKey).toArray();
      const layerIds = new Set(layers.map(layer => layer.id));
      const annotations = await localDatabase.annotations.where("scopeKey").equals(record.scopeKey)
        .filter(annotation => layerIds.has(annotation.layerId)).toArray();
      const annotationSnapshot: OfflineAnnotationSnapshot = {
        layers, annotations, cursor: (await localDatabase.annotationSyncCursors.get(record.scopeKey))?.cursor ?? 0,
        verifiedAt: Date.now(),
      };
      // Blob values already read by another session remain valid after deleting
      // the IndexedDB reference. Annotation tables are deliberately untouched.
      await localDatabase.offlineScores.bulkDelete(existing.map((entry) => entry.key));
      await localDatabase.offlineScores.put({
        ...record,
        annotationSnapshot,
        active: 1,
        verifiedAt: Date.now(),
      });
    },
  );
}

export function findActiveOfflineScore(
  ownerKey: LocalWorkspaceOwnerKey,
  choirId: string,
  scoreId: string,
) {
  return localDatabase.offlineScores
    .where("[ownerKey+choirId+scoreId]")
    .equals([ownerKey, choirId, scoreId])
    .filter((record) => record.active === 1)
    .first();
}

export function annotationRecordKey(scopeKey: string, annotationId: string) {
  return JSON.stringify([scopeKey, annotationId]);
}

interface LegacyScopedRecord {
  key?: string;
  scopeKey: string;
  choirId?: string;
  scoreId?: string;
}

async function migrateLegacyLocalWorkspaces(transaction: Transaction) {
  const system = transaction.table<SystemRecord>("system");
  const legacyUser = await system.get(LEGACY_LAST_AUTHENTICATED_USER_ID_KEY);
  const knownOwner = legacyUser?.value
    ? (`user:${legacyUser.value}` as LocalWorkspaceOwnerKey)
    : null;

  const tables = {
    offlineScores: transaction.table<OfflineScoreRecord>("offlineScores"),
    annotations: transaction.table<LocalAnnotationRecord>("annotations"),
    annotationOutbox:
      transaction.table<AnnotationOutboxRecord>("annotationOutbox"),
    annotationConflicts:
      transaction.table<AnnotationConflictRecord>("annotationConflicts"),
    annotationSyncCursors:
      transaction.table<AnnotationSyncCursorRecord>("annotationSyncCursors"),
    guestLayerPreferences:
      transaction.table<GuestLayerPreferenceRecord>("guestLayerPreferences"),
    syncLeases: transaction.table<SyncLeaseRecord>("syncLeases"),
    annotationLayers:
      transaction.table<LocalAnnotationLayerRecord>("annotationLayers"),
  };

  const legacyLayers = (await tables.annotationLayers.toArray()) as Array<
    LocalAnnotationLayerRecord & LegacyScopedRecord
  >;
  const sharedLayerIdsByScope = new Map<string, Set<string>>();
  for (const layer of legacyLayers) {
    if (layer.kind !== "shared") continue;
    const ids = sharedLayerIdsByScope.get(layer.scopeKey) ?? new Set<string>();
    ids.add(layer.id);
    sharedLayerIdsByScope.set(layer.scopeKey, ids);
  }

  const guestOwners = new Map<string, LocalWorkspaceOwnerKey>();
  const ownerFor = async (choirId: string) => {
    if (knownOwner) return knownOwner;
    const existing = guestOwners.get(choirId);
    if (existing) return existing;
    const ownerKey = `guest:${crypto.randomUUID()}` as LocalWorkspaceOwnerKey;
    guestOwners.set(choirId, ownerKey);
    await system.put({ key: guestOwnerSystemKey(choirId), value: ownerKey });
    return ownerKey;
  };

  const migrateScope = async (record: LegacyScopedRecord) => {
    const parsed = legacyScope(record);
    const ownerKey = await ownerFor(parsed.choirId);
    const scopeKey = migrationScopeKey(ownerKey, parsed.choirId, parsed.scoreId);
    return { ...parsed, ownerKey, scopeKey };
  };

  const migratedLayers: LocalAnnotationLayerRecord[] = [];
  for (const layer of legacyLayers) {
    if (!knownOwner && layer.kind !== "shared") continue;
    const scope = await migrateScope(layer);
    migratedLayers.push({
      ...layer,
      ...scope,
      key: annotationRecordKey(scope.scopeKey, layer.id),
      canEdit: knownOwner ? layer.canEdit : false,
      subscribed: knownOwner ? layer.subscribed : true,
      scoreSubscriptionOverride: knownOwner ? layer.scoreSubscriptionOverride : null,
    });
  }
  await tables.annotationLayers.clear();
  await tables.annotationLayers.bulkPut(migratedLayers);

  const migratedAnnotations: LocalAnnotationRecord[] = [];
  for (const annotation of (await tables.annotations.toArray()) as Array<
    LocalAnnotationRecord & LegacyScopedRecord
  >) {
    if (
      !knownOwner &&
      (annotation.state !== "synced" ||
        !sharedLayerIdsByScope.get(annotation.scopeKey)?.has(annotation.layerId))
    ) {
      continue;
    }
    const scope = await migrateScope(annotation);
    migratedAnnotations.push({
      ...annotation,
      ...scope,
      key: annotationRecordKey(scope.scopeKey, annotation.id),
    });
  }
  await tables.annotations.clear();
  await tables.annotations.bulkPut(migratedAnnotations);

  const migrateCollection = async <T extends LegacyScopedRecord>(
    table: Table<T, string>,
    keyFor: (record: T, scopeKey: string) => string,
  ) => {
    const migrated: T[] = [];
    for (const record of await table.toArray()) {
      const scope = await migrateScope(record);
      migrated.push({
        ...record,
        ...scope,
        key: keyFor(record, scope.scopeKey),
      } as T);
    }
    await table.clear();
    await table.bulkPut(migrated);
  };

  if (knownOwner) {
    await migrateCollection(
      tables.guestLayerPreferences as unknown as Table<
        GuestLayerPreferenceRecord & LegacyScopedRecord,
        string
      >,
      (record, scopeKey) => annotationRecordKey(scopeKey, record.layerId),
    );
  } else {
    await tables.guestLayerPreferences.clear();
  }

  const migratedOffline: OfflineScoreRecord[] = [];
  for (const offline of (await tables.offlineScores.toArray()) as Array<
    OfflineScoreRecord & LegacyScopedRecord
  >) {
    const scope = await migrateScope(offline);
    const legacyOfflineScope = `${offline.choirId}:${offline.scoreId}`;
    const sharedIds = sharedLayerIdsByScope.get(legacyOfflineScope) ?? new Set();
    const legacySnapshot = offline.annotationSnapshot ?? {
      layers: [],
      annotations: [],
      cursor: 0,
      verifiedAt: offline.verifiedAt,
    };
    const snapshot = {
      ...legacySnapshot,
      layers: legacySnapshot.layers
        .filter((layer) => knownOwner || layer.kind === "shared")
        .map((layer) => ({
          ...layer,
          ...scope,
          key: annotationRecordKey(scope.scopeKey, layer.id),
          canEdit: knownOwner ? layer.canEdit : false,
          subscribed: knownOwner ? layer.subscribed : true,
          scoreSubscriptionOverride: knownOwner ? layer.scoreSubscriptionOverride : null,
        })),
      annotations: legacySnapshot.annotations
        .filter(
          (annotation) =>
            knownOwner ||
            (annotation.state === "synced" && sharedIds.has(annotation.layerId)),
        )
        .map((annotation) => ({
          ...annotation,
          ...scope,
          key: annotationRecordKey(scope.scopeKey, annotation.id),
        })),
    };
    migratedOffline.push({
      ...offline,
      ...scope,
      key: annotationRecordKey(scope.scopeKey, offline.versionId),
      annotationSnapshot: snapshot,
    });
  }
  await tables.offlineScores.clear();
  await tables.offlineScores.bulkPut(migratedOffline);

  if (knownOwner) {
    for (const operation of await tables.annotationOutbox.toArray()) {
      const scope = await migrateScope(operation);
      await tables.annotationOutbox.put({ ...operation, ...scope });
    }
    for (const conflict of await tables.annotationConflicts.toArray()) {
      const scope = await migrateScope(conflict);
      await tables.annotationConflicts.put({ ...conflict, ...scope });
    }
    for (const cursor of await tables.annotationSyncCursors.toArray()) {
      const scope = await migrateScope(cursor);
      await tables.annotationSyncCursors.delete(cursor.scopeKey);
      await tables.annotationSyncCursors.put({ ...cursor, ...scope });
    }
    for (const lease of await tables.syncLeases.toArray()) {
      const scope = await migrateScope(lease);
      await tables.syncLeases.delete(lease.scopeKey);
      await tables.syncLeases.put({
        ...lease,
        ...scope,
        lockOwner: (lease as unknown as { owner: string }).owner,
      });
    }
    await system.put({ key: LAST_AUTHENTICATED_OWNER_KEY, value: knownOwner });
    await system.put({ key: ACTIVE_LOCAL_OWNER_KEY, value: knownOwner });
  } else {
    await Promise.all([
      tables.annotationOutbox.clear(),
      tables.annotationConflicts.clear(),
      tables.annotationSyncCursors.clear(),
      tables.syncLeases.clear(),
    ]);
  }
  await system.delete(LEGACY_LAST_AUTHENTICATED_USER_ID_KEY);
}

function legacyScope(record: LegacyScopedRecord) {
  if (record.choirId && record.scoreId) {
    return { choirId: record.choirId, scoreId: record.scoreId };
  }
  const [choirId, scoreId] = record.scopeKey.split(":");
  if (!choirId || !scoreId) throw new Error("legacy_local_scope_invalid");
  return { choirId, scoreId };
}

function migrationScopeKey(
  ownerKey: LocalWorkspaceOwnerKey,
  choirId: string,
  scoreId: string,
) {
  return JSON.stringify([ownerKey, choirId, scoreId]);
}
