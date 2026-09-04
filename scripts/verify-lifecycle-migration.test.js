// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { assertLifecycleMigration, lifecycleSnapshotSql } from "./verify-lifecycle-migration.mjs";

const valid = () => ({ before: { sync_high_water: 1000 }, sequence: 1001, violations: [],
  foreignKeys: [{ from: "actor_user_id", table: "user", on_delete: "SET NULL" }] });
describe("production lifecycle migration gate", () => {
  it("accepts the preserved cursor and nullable identity reference", () => {
    expect(() => assertLifecycleMigration(valid())).not.toThrow();
  });
  it("blocks deploy on a foreign-key violation", () => {
    expect(() => assertLifecycleMigration({ ...valid(), violations: [{ table: "annotation_objects" }] })).toThrow("foreign-key violations");
  });
  it("blocks deploy if identity deletion would erase synchronization history", () => {
    expect(() => assertLifecycleMigration({ ...valid(), foreignKeys: [{ from: "actor_user_id", table: "user", on_delete: "CASCADE" }] })).toThrow("survive identity deletion");
  });
  it("blocks deploy on cursor regression or a missing pre-migration snapshot", () => {
    expect(() => assertLifecycleMigration({ ...valid(), sequence: 999 })).toThrow("cursor regressed");
    expect(() => assertLifecycleMigration({ ...valid(), before: {} })).toThrow("Missing pre-migration cursor");
  });
});


describe("production aggregate snapshot", () => {
  it("returns one aggregate row and preserves a deleted high-water mark", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE user (id TEXT);
        CREATE TABLE memberships (id TEXT);
        CREATE TABLE annotation_objects (id TEXT);
        CREATE TABLE annotation_sync_operations (sequence INTEGER PRIMARY KEY AUTOINCREMENT);
        CREATE TABLE scores (current_version_id TEXT);
        CREATE TABLE score_versions (id TEXT);
        CREATE TABLE choirs (storage_used_bytes INTEGER);
        CREATE TABLE score_object_deletions (id TEXT);
        INSERT INTO user VALUES ('a'), ('b');
        INSERT INTO memberships VALUES ('a');
        INSERT INTO annotation_objects VALUES ('a');
        INSERT INTO annotation_sync_operations VALUES (1), (1000);
        DELETE FROM annotation_sync_operations WHERE sequence = 1000;
        INSERT INTO scores VALUES ('a'), (NULL);
        INSERT INTO score_versions VALUES ('a');
        INSERT INTO choirs VALUES (123), (456);`);
      expect(db.prepare(lifecycleSnapshotSql).all()).toEqual([{
        users: 2, memberships: 1, annotations: 1, sync_operations: 1,
        sync_high_water: 1000, scores: 2, current_pdf_pointers: 1,
        pdf_versions: 1, logical_storage_bytes: 579, object_deletion_queue: 0,
      }]);
    } finally { db.close(); }
  });
});
