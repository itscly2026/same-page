import Dexie from "dexie";
import { describe, expect, it } from "vitest";

import type { AnnotationPayload } from "../../shared/annotations";
import {
  annotationRecordKey,
  migrateStoredTextPayload,
  SamePageDatabase,
} from "./local-database";

describe("local annotation payload migration", () => {
  it("adds the normalized default font scale to legacy text and is idempotent", () => {
    const legacy = {
      kind: "text",
      pageNumber: 1,
      x: 0.2,
      y: 0.3,
      text: "旧批注",
    } as unknown as AnnotationPayload;
    const migrated = migrateStoredTextPayload(legacy);
    expect(migrated).toMatchObject({ kind: "text", fontScale: 0.024 });
    expect(migrateStoredTextPayload(migrated)).toBe(migrated);
  });

  it("clears superseded annotation and offline records from database version 5", async () => {
    const databaseName = `same-page-migration-${crypto.randomUUID()}`;
    const legacyDatabase = new Dexie(databaseName);
    legacyDatabase.version(5).stores(versionFiveStores);
    await legacyDatabase.open();
    const legacyPayload = {
      kind: "text",
      pageNumber: 1,
      x: 0.2,
      y: 0.3,
      text: "旧批注",
    };
    const scope = {
      ownerKey: "user:user-1",
      scopeKey: "user:user-1:choir-1:score-1",
      choirId: "choir-1",
      scoreId: "score-1",
    };
    const annotationKey = annotationRecordKey(scope.scopeKey, "annotation-1");
    const annotation = {
      key: annotationKey,
      ...scope,
      id: "annotation-1",
      layerId: "layer-1",
      state: "pending",
      lastOpId: "outbox",
      payload: legacyPayload,
    };
    await legacyDatabase.table("annotations").put(annotation);
    await legacyDatabase.table("annotationOutbox").put({
      opId: "outbox",
      ...scope,
      annotationId: "annotation-1",
      attemptedAt: 1,
      payload: legacyPayload,
    });
    await legacyDatabase.table("annotationConflicts").put({
      opId: "conflict",
      ...scope,
      annotationId: "annotation-1",
      localPayload: legacyPayload,
      canonical: { payload: legacyPayload },
    });
    await legacyDatabase.table("offlineScores").put({
      key: "offline",
      ...scope,
      annotationSnapshot: { annotations: [annotation] },
    });
    legacyDatabase.close();

    const migratedDatabase = new SamePageDatabase(databaseName);
    try {
      await migratedDatabase.open();
      expect(await migratedDatabase.table("annotations").count()).toBe(0);
      expect(await migratedDatabase.table("annotationOutbox").count()).toBe(0);
      expect(await migratedDatabase.table("annotationConflicts").count()).toBe(0);
      expect(await migratedDatabase.table("offlineScores").count()).toBe(0);
    } finally {
      migratedDatabase.close();
      await Dexie.delete(databaseName);
    }
  });
});

const versionFiveStores = {
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
  guestLayerPreferences: "&key,ownerKey,scopeKey,[scopeKey+layerId]",
  syncLeases: "&scopeKey,ownerKey,expiresAt",
  annotationLayers: "&key,ownerKey,scopeKey,[scopeKey+id],kind,sortOrder",
};
