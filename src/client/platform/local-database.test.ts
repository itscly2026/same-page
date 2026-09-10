import { Blob as NodeBlob } from "node:buffer";
import Dexie from "dexie";
import { describe, expect, it, vi } from "vitest";

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
      text: "旧笔记",
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
      text: "旧笔记",
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

it("upgrades version 10 without losing file bytes, snapshots, drafts, outbox or conflicts", async () => {
  const name = `split-offline-${crypto.randomUUID()}`;
  const old = new Dexie(name);
  old.version(10).stores({ ...versionFiveStores,
    annotationOutbox: "&opId,ownerKey,scopeKey,[ownerKey+scopeKey],[scopeKey+annotationId],createdAt",
    driveDirectories: "&key,ownerKey,[ownerKey+choirId]" });
  await old.open();
  const scope = { ownerKey: "user:a", scopeKey: "scope", choirId: "drive", scoreId: "score" };
  const snapshot = { layers: [], annotations: [], cursor: 12, verifiedAt: 42 };
  const draft = { ...scope, key: "draft", state: "draft", payload: { text: "keep this draft" } };
  await old.table("offlineScores").put({ ...scope, key: "file", blob: new NodeBlob(["PDF bytes"]), annotationSnapshot: snapshot, active: 1 });
  await old.table("offlineScores").put({ ...scope, key: "unreadable", blob: new NodeBlob(["retained"]), annotationSnapshot: snapshot, active: 1 });
  await old.table("annotations").put(draft);
  await old.table("annotationOutbox").put({ ...scope, opId: "pending" });
  await old.table("annotationConflicts").put({ ...scope, opId: "conflict" });
  old.close();
  const originalPut = IDBObjectStore.prototype.put;
  const writes = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "offlineScores") throw new DOMException("broken Blob rewrite", "NotFoundError");
    return originalPut.apply(this, args);
  });
  const originalGet = IDBObjectStore.prototype.get;
  const reads = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "offlineScores" && args[0] === "unreadable") throw new DOMException("broken file read", "NotReadableError");
    return originalGet.apply(this, args);
  });
  const upgraded = new SamePageDatabase(name);
  try {
    await upgraded.open();
    const file = await upgraded.offlineScores.get("file");
    expect(file?.blob.size).toBe(9);
    expect(await file?.blob.text()).toBe("PDF bytes");
    // Legacy embedded metadata is inert; the current snapshot lives separately.
    expect((await upgraded.offlineSnapshots.get("file"))?.annotationSnapshot).toEqual(snapshot);
    expect(await upgraded.offlineScores.count()).toBe(2);
    expect(await upgraded.offlineSnapshots.get("unreadable")).toBeUndefined();
    expect(await upgraded.annotations.get("draft")).toEqual(draft);
    expect(await upgraded.annotationOutbox.get("pending")).toBeDefined();
    expect(await upgraded.annotationConflicts.get("conflict")).toBeDefined();
  } finally { reads.mockRestore(); writes.mockRestore(); upgraded.close(); await Dexie.delete(name); }
});


it.each([10, 14])("upgrades version %s to PDF-only without rewriting PDFs or losing annotation data", async version => {
  const name = `pdf-only-${crypto.randomUUID()}`;
  const old = new Dexie(name);
  old.version(version).stores({ ...versionFiveStores,
    annotationOutbox: "&opId,ownerKey,scopeKey,[ownerKey+scopeKey],[scopeKey+annotationId],createdAt",
    driveDirectories: "&key,ownerKey,[ownerKey+choirId]",
    ...(version >= 11 ? { offlineSnapshots: "&key,ownerKey,scopeKey" } : {}),
    ...(version >= 12 ? { readingPreferences: "&key,ownerKey,[ownerKey+choirId]" } : {}),
  });
  await old.open();
  const scope = { ownerKey: "user:a", scopeKey: "scope", choirId: "drive", scoreId: "score" };
  const snapshot = { layers: [], annotations: [], cursor: 12, verifiedAt: 42 };
  const pdfKey = JSON.stringify([scope.scopeKey, "v1:pdf"]);
  const imageKey = JSON.stringify([scope.scopeKey, "v1:images"]);
  const files = [
    { ...scope, key: pdfKey, blob: new NodeBlob(["%PDF-1.7 retained"]), active: 0 },
    { ...scope, key: imageKey, blob: new NodeBlob(["image bundle"]), imageManifest: { pages: [] }, active: 1 },
    { ...scope, key: "inactive-image", blob: new NodeBlob(["older bundle"]), imageManifest: { pages: [] }, active: 0 },
  ];
  for (const file of files) {
    await old.table("offlineScores").put({ ...file, ...(version < 11 ? { annotationSnapshot: snapshot } : {}) });
    if (version >= 11) await old.table("offlineSnapshots").put({ ...scope, key: file.key, annotationSnapshot: snapshot });
  }
  const draft = { ...scope, key: "draft", state: "draft", payload: { text: "preserve draft" } };
  const pending = { ...scope, opId: "pending", payload: { text: "pending edit" } };
  const conflict = { ...scope, opId: "conflict", localPayload: { text: "conflicting edit" } };
  await old.table("annotations").put(draft);
  await old.table("annotationOutbox").put(pending);
  await old.table("annotationConflicts").put(conflict);
  old.close();
  const originalPut = IDBObjectStore.prototype.put;
  const writes = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "offlineScores") throw new Error("must not rewrite retained PDF Blobs");
    return originalPut.apply(this, args);
  });
  const updates = vi.spyOn(IDBCursor.prototype, "update").mockImplementation(() => {
    throw new Error("must not rewrite file records using cursors");
  });
  // Version 14 already has a separate snapshot. Its broken bundle must be
  // deletable using the historical key without trying to deserialize the Blob.
  const originalGet = IDBObjectStore.prototype.get;
  const reads = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (version === 14 && this.name === "offlineScores" && args[0] === imageKey) throw new DOMException("unreadable bundle", "NotReadableError");
    return originalGet.apply(this, args);
  });
  const upgraded = new SamePageDatabase(name);
  try {
    await upgraded.open();
    expect(await upgraded.offlineScores.toCollection().primaryKeys()).toEqual([pdfKey]);
    const pdf = await upgraded.offlineScores.get(pdfKey);
    expect(await pdf?.blob.text()).toBe("%PDF-1.7 retained");
    expect(pdf?.active).toBe(0);
    for (const file of files) expect((await upgraded.offlineSnapshots.get(file.key))?.annotationSnapshot).toEqual(snapshot);
    expect(await upgraded.annotations.get("draft")).toEqual(draft);
    expect(await upgraded.annotationOutbox.get("pending")).toEqual(pending);
    expect(await upgraded.annotationConflicts.get("conflict")).toEqual(conflict);
  } finally {
    reads.mockRestore(); updates.mockRestore(); writes.mockRestore();
    upgraded.close(); await Dexie.delete(name);
  }
});
