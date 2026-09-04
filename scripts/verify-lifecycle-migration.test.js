// @vitest-environment node

import { describe, expect, it } from "vitest";
import { assertLifecycleMigration } from "./verify-lifecycle-migration.mjs";

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
