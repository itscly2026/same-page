import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  backfillLegacyScoreFileNames,
  executeD1,
} from "./backfill-score-file-names.mjs";
import { canonicalScoreFileNameKey } from "../src/shared/score-file-name-key.mjs";

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

  verifySchema();
  verifyMigratedNames();
  verifyDriveNames();
  verifyDefaultSharedLayers();
  verifyRelatedRecords();
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
}

function verifyMigratedNames() {
  const rows = query(
    "SELECT id, choir_id, file_name, file_name_key FROM scores ORDER BY id",
  );
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((row) => `${row.choir_id}\0${row.file_name_key}`)).size, 4);
  for (const row of rows) {
    assert(row.file_name.endsWith(".pdf"));
    assert(row.file_name.length <= 255);
    assert.equal(row.file_name, row.file_name.normalize("NFC"));
    assert.equal(row.file_name_key, canonicalScoreFileNameKey(row.file_name));
  }
  assert.deepEqual(
    rows.slice(0, 2).map((row) => [row.file_name, row.file_name_key]),
    [
      ["Été.pdf", "été.pdf"],
      ["ÉTÉ (2).pdf", "été (2).pdf"],
    ],
  );
  assert.equal(rows[3].file_name, "Untitled.pdf");
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
  assert.equal(query("SELECT id FROM score_versions").length, 1);
  assert.equal(query("SELECT id FROM annotation_layers").length, 21);
  assert.equal(query("SELECT id FROM annotation_objects").length, 1);
  assert.deepEqual(query("PRAGMA foreign_key_check"), []);
}

function verifyDefaultSharedLayers() {
  const legacy = query(
    "SELECT name, default_slot FROM annotation_layers WHERE id = 'layer'",
  );
  assert.deepEqual(legacy, [{ name: "Shared", default_slot: null }]);
  const defaults = query(
    `SELECT score_id, default_slot, kind, name
     FROM annotation_layers
     WHERE default_slot IS NOT NULL
     ORDER BY score_id, sort_order`,
  );
  assert.equal(defaults.length, 20);
  for (const scoreId of ["a", "b", "c", "d"]) {
    assert.deepEqual(
      defaults.filter((row) => row.score_id === scoreId),
      ["G", "S", "A", "T", "B"].map((slot) => ({
        score_id: scoreId,
        default_slot: slot,
        kind: "shared",
        name: slot,
      })),
    );
  }
  executeD1({
    command: `INSERT OR IGNORE INTO annotation_layers
      (id, choir_id, score_id, kind, default_slot, name, sort_order,
       default_color, created_at, updated_at)
      VALUES ('duplicate-g', 'choir', 'a', 'shared', 'G', 'G duplicate', 99,
              '#000000', 1, 1)`,
    targetArgs,
  });
  assert.equal(
    query(
      "SELECT id FROM annotation_layers WHERE score_id = 'a' AND default_slot = 'G'",
    ).length,
    1,
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
      ('annotation', 'choir', 'a', 'layer', 1, 0, '{}', 'user', 'Admin',
       'user', 'Admin', 1, 1);
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
