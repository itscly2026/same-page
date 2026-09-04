import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  backfillLegacyScoreFileNames,
  executeD1,
} from "./backfill-score-file-names.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const persistencePath = mkdtempSync(join(tmpdir(), "same-page-migration-"));
const targetArgs = ["--local", "--persist-to", persistencePath];

try {
  for (const migration of [
    "0001_auth_and_choirs.sql",
    "0002_scores_and_pdf_versions.sql",
    "0003_queue_deleted_score_objects.sql",
    "0004_annotations_and_sync.sql",
  ]) {
    executeD1({ file: join(repositoryRoot, "migrations", migration), targetArgs });
  }

  executeD1({ command: legacyFixtureSql(), targetArgs });
  executeD1({
    file: join(repositoryRoot, "migrations", "0005_filename_library_and_trash.sql"),
    targetArgs,
  });
  assert.equal(backfillLegacyScoreFileNames(targetArgs), 4);
  assert.equal(backfillLegacyScoreFileNames(targetArgs), 0);
  executeD1({
    file: join(repositoryRoot, "migrations", "0006_default_shared_layer_slots.sql"),
    targetArgs,
  });
  executeD1({
    file: join(repositoryRoot, "migrations", "0006_preview_entry.sql"),
    targetArgs,
  });
  executeD1({ command: legacyPreviewFixtureSql(), targetArgs });
  executeD1({
    file: join(repositoryRoot, "migrations", "0007_rename_product_drives.sql"),
    targetArgs,
  });
  executeD1({
    file: join(repositoryRoot, "migrations", "0008_text_annotation_font_scale.sql"),
    targetArgs,
  });
  executeD1({
    file: join(repositoryRoot, "migrations", "0009_fixed_layer_preferences.sql"),
    targetArgs,
  });
  executeD1({
    file: join(repositoryRoot, "migrations", "0010_remove_score_layer_colors.sql"),
    targetArgs,
  });

  const inviteState = query("SELECT id, join_code_hash, guest_session_version FROM choirs ORDER BY id");
  executeD1({
    file: join(repositoryRoot, "migrations", "0011_retrievable_join_codes.sql"),
    targetArgs,
  });
  assert.deepEqual(query("SELECT id, join_code_hash, guest_session_version FROM choirs ORDER BY id"), inviteState);
  assert(query("SELECT join_code_ciphertext FROM choirs").every((row) => row.join_code_ciphertext === null));

  executeD1({ command: "INSERT INTO rate_limits VALUES ('expired-fixture', 3, 0), ('live-fixture', 4, 9999999999999)", targetArgs });
  executeD1({
    file: join(repositoryRoot, "migrations", "0012_rate_limit_expiry_index.sql"),
    targetArgs,
  });
  assert.deepEqual(query("SELECT * FROM rate_limits ORDER BY key"), [
    { key: "expired-fixture", count: 3, window_expires_at: 0 },
    { key: "live-fixture", count: 4, window_expires_at: 9999999999999 },
  ]);
  assert.deepEqual(query("PRAGMA index_info(rate_limits_expiry_key_idx)").map((row) => row.name), ["window_expires_at", "key"]);
  const expiryPlan = query("EXPLAIN QUERY PLAN SELECT key FROM rate_limits WHERE window_expires_at <= 100 ORDER BY window_expires_at, key LIMIT 500");
  assert(expiryPlan.some((row) => /COVERING INDEX rate_limits_expiry_key_idx/.test(row.detail)));
  assert(!expiryPlan.some((row) => /SCAN rate_limits|TEMP B-TREE/.test(row.detail)));

  executeD1({ file: join(repositoryRoot, "migrations", "0013_safe_pdf_replacement.sql"), targetArgs });
  assert(query("SELECT version_revision, last_version_number FROM scores")
    .every((row) => row.version_revision === 1 && row.last_version_number >= 1));
  verifySchema();
  verifyDriveNames();
  verifyContentReset();
  verifyRelatedRecords();
  executeD1({ command: `
    INSERT INTO sqlite_sequence (name, seq)
      SELECT 'annotation_sync_operations', 1000
      WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'annotation_sync_operations');
    UPDATE sqlite_sequence SET seq = 1000 WHERE name = 'annotation_sync_operations';
  `, targetArgs });
  assert.deepEqual(query("SELECT seq FROM sqlite_sequence WHERE name = 'annotation_sync_operations'"), [{ seq: 1000 }]);
  executeD1({ file: join(repositoryRoot, "migrations", "0014_user_and_membership_lifecycle.sql"), targetArgs });
  assert.deepEqual(query("SELECT seq FROM sqlite_sequence WHERE name = 'annotation_sync_operations'"), [{ seq: 1000 }]);
  assert.equal(query("SELECT * FROM user_lifecycle").length, 0);
  assert(query("PRAGMA foreign_key_list(annotation_sync_operations)")
    .some((row) => row.from === "actor_user_id" && row.on_delete === "SET NULL"));
  process.stdout.write("Verified legacy score schema migration.\n");
} finally {
  rmSync(persistencePath, { recursive: true, force: true });
}

function verifySchema() {
  const columns = query("PRAGMA table_info(scores)").map((row) => row.name);
  assert.deepEqual(columns, [
    "id",
    "choir_id",
    "file_name",
    "current_version_id",
    "replacement_lock_id",
    "replacement_lock_expires_at",
    "created_at",
    "updated_at",
    "file_name_key",
    "trashed_at",
    "trash_expires_at",
    "version_revision",
    "last_version_number",
  ]);
  const indexes = query("PRAGMA index_list(scores)").map((row) => row.name);
  assert(indexes.includes("scores_active_filename_uidx"));
  assert(indexes.includes("scores_choir_filename_idx"));
  assert(indexes.includes("scores_trash_expiry_idx"));
  const layerColumns = query("PRAGMA table_info(annotation_layers)").map(
    (row) => row.name,
  );
  assert(layerColumns.includes("default_slot"));
  const layerIndexes = query("PRAGMA index_list(annotation_layers)").map(
    (row) => row.name,
  );
  assert(layerIndexes.includes("annotation_layers_default_slot_uidx"));
  const scorePreferenceColumns = query(
    "PRAGMA table_info(user_score_layer_preferences)",
  ).map((row) => row.name);
  assert(!scorePreferenceColumns.includes("color_override"));
  assert.deepEqual(
    query(
      "SELECT default_color FROM choir_shared_layer_settings WHERE choir_id = 'choir' AND slot = 'S'",
    ),
    [{ default_color: "#7c3aed" }],
  );
}

function verifyDriveNames() {
  assert.deepEqual(
    query("SELECT id, name FROM choirs ORDER BY id"),
    [
      { id: "choir", name: "示例云盘" },
      { id: "preview", name: "公开体验云盘" },
    ],
  );
}

function verifyRelatedRecords() {
  assert.equal(query("SELECT id FROM scores").length, 0);
  assert.equal(query("SELECT id FROM score_versions").length, 0);
  assert.equal(query("SELECT id FROM annotation_layers").length, 0);
  assert.equal(query("SELECT id FROM annotation_objects").length, 0);
  assert.equal(query("SELECT id FROM score_object_deletions").length, 1);
  assert.deepEqual(query("PRAGMA foreign_key_check"), []);
}

function verifyContentReset() {
  assert.equal(query("SELECT id FROM scores").length, 0);
  assert.equal(query("SELECT id FROM score_versions").length, 0);
  assert.equal(query("SELECT id FROM annotation_objects").length, 0);
  assert.equal(
    query("SELECT op_id FROM annotation_sync_operations").length,
    0,
  );
}

function query(command) {
  return executeD1({ command, targetArgs })[0]?.results ?? [];
}

function legacyFixtureSql() {
  const longTitle = "L".repeat(300);
  return `
    INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
    VALUES ('user', 'Admin', 'admin@example.test', 1, 1, 1);
    INSERT INTO choirs
      (id, name, guest_admission_mode, guest_session_version, join_code_hash,
       storage_limit_bytes, storage_used_bytes, created_at)
    VALUES ('choir', '示例合唱团', 'open', 1, NULL, 1073741824, 100, 1);
    INSERT INTO memberships
      (id, choir_id, user_id, display_name, role, status, joined_at)
    VALUES ('membership', 'choir', 'user', 'Admin', 'admin', 'active', 1);
    INSERT INTO scores
      (id, choir_id, title, status, current_version_id, created_at, updated_at)
    VALUES
      ('a', 'choir', 'Été', 'draft', 'version', 1, 1),
      ('b', 'choir', 'ÉTÉ', 'published', NULL, 2, 2),
      ('c', 'choir', '${longTitle}', 'archived', NULL, 3, 3),
      ('d', 'choir', '   ', 'draft', NULL, 4, 4);
    INSERT INTO score_versions
      (id, choir_id, score_id, version_number, object_key, size_bytes, sha256,
       etag, page_count, state, uploaded_by_membership_id, created_at, ready_at)
    VALUES
      ('version', 'choir', 'a', 1, 'scores/a.pdf', 100, 'sha256', 'etag', 1,
       'ready', 'membership', 1, 1);
    INSERT INTO annotation_layers
      (id, choir_id, score_id, kind, owner_user_id, name, sort_order,
       default_color, created_by_membership_id, created_at, updated_at)
    VALUES
      ('layer', 'choir', 'a', 'shared', NULL, 'Shared', 0, '#000000',
       'membership', 1, 1);
    INSERT INTO annotation_objects
      (id, choir_id, score_id, layer_id, version, deleted, payload_json,
       created_by_user_id, created_by_display_name, updated_by_user_id,
       updated_by_display_name, created_at, updated_at)
    VALUES
      ('annotation', 'choir', 'a', 'layer', 1, 0,
       '{"kind":"text","pageNumber":1,"x":0.2,"y":0.3,"text":"Legacy"}',
       'user', 'Admin',
       'user', 'Admin', 1, 1);
    INSERT INTO annotation_sync_operations
      (op_id, choir_id, score_id, layer_id, annotation_id, actor_user_id,
       base_version, operation_type, payload_json, payload_hash, status, created_at)
    VALUES
      ('legacy-operation', 'choir', 'a', 'layer', 'pending-annotation', 'user',
       0, 'upsert',
       '{"kind":"text","pageNumber":1,"x":0.4,"y":0.5,"text":"Pending"}',
       'legacy-payload-hash', 'processing', 1);
  `;
}

function legacyPreviewFixtureSql() {
  return `
    INSERT INTO choirs
      (id, name, guest_admission_mode, guest_session_version, join_code_hash,
       storage_limit_bytes, storage_used_bytes, is_preview_entry, created_at)
    VALUES
      ('preview', '旧公开合唱团', 'open', 1, NULL, 1073741824, 0, 1, 1);
  `;
}
