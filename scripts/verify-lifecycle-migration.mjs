import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { executeD1 } from "./backfill-score-file-names.mjs";

// A single result row avoids D1's compound-SELECT limit.
export const lifecycleSnapshotSql = `SELECT
  (SELECT COUNT(*) FROM user) AS users,
  (SELECT COUNT(*) FROM memberships) AS memberships,
  (SELECT COUNT(*) FROM annotation_objects) AS annotations,
  (SELECT COUNT(*) FROM annotation_sync_operations) AS sync_operations,
  (SELECT COALESCE(MAX(seq), 0) FROM sqlite_sequence WHERE name = 'annotation_sync_operations') AS sync_high_water,
  (SELECT COUNT(*) FROM scores) AS scores,
  (SELECT COUNT(current_version_id) FROM scores) AS current_pdf_pointers,
  (SELECT COUNT(*) FROM score_versions) AS pdf_versions,
  (SELECT COALESCE(SUM(storage_used_bytes), 0) FROM choirs) AS logical_storage_bytes,
  (SELECT COUNT(*) FROM score_object_deletions) AS object_deletion_queue`;

export function assertLifecycleMigration({ before, foreignKeys, violations, sequence }) {
  assert.equal(violations.length, 0, "Production migration has foreign-key violations");
  assert(foreignKeys.some((row) => row.from === "actor_user_id" && row.table === "user" && row.on_delete === "SET NULL"),
    "Shared synchronization actors must survive identity deletion");
  assert(Number.isSafeInteger(before.sync_high_water) && before.sync_high_water >= 0, "Missing pre-migration cursor");
  assert(Number.isSafeInteger(sequence) && sequence >= before.sync_high_water, "Synchronization cursor regressed during migration");
}

function query(command) {
  return executeD1({ command, targetArgs: ["--remote"] });
}

function main(mode, snapshotPath) {
  assert(snapshotPath && (mode === "before" || mode === "after"), "Usage: verify-lifecycle-migration.mjs before|after snapshot-path");
  if (mode === "before") {
    const snapshot = query(lifecycleSnapshotSql)[0].results[0];
    assert(Number.isSafeInteger(snapshot.sync_high_water), "Missing pre-migration cursor");
    writeFileSync(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
    console.log("Captured production lifecycle recovery snapshot.");
    return;
  }
  // Selecting the new columns also makes a missing migration fail before deploy.
  query(`SELECT version_revision, last_version_number FROM scores LIMIT 0;
    SELECT candidate_expires_at, base_revision FROM score_versions LIMIT 0;
    SELECT lifecycle_revision, last_lifecycle_action, removed_for_deletion_id FROM memberships LIMIT 0;
    SELECT user_id, deletion_id, expires_at FROM user_lifecycle LIMIT 0;
    SELECT user_id, allowed_methods FROM lifecycle_reauthentication LIMIT 0;
    SELECT session_id, method FROM session_auth_methods LIMIT 0`);
  const results = query(`PRAGMA foreign_key_list(annotation_sync_operations);
    PRAGMA foreign_key_check;
    SELECT COALESCE(MAX(seq), 0) AS sequence FROM sqlite_sequence WHERE name = 'annotation_sync_operations'`);
  assertLifecycleMigration({ before: JSON.parse(readFileSync(snapshotPath, "utf8")),
    foreignKeys: results[0].results, violations: results[1].results, sequence: results[2].results[0].sequence });
  console.log("Verified production lifecycle columns, foreign keys, and synchronization cursor.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2], process.argv[3]);
}
