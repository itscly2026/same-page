import { prepareDriveOwners } from "./prepare-drive-owners.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
  applyMigrations(
    "0001_auth_and_choirs.sql",
    "0002_scores_and_pdf_versions.sql",
    "0003_queue_deleted_score_objects.sql",
    "0004_annotations_and_sync.sql",
  );

  executeD1({ command: legacyFixtureSql(), targetArgs });
  applyMigrations("0005_filename_library_and_trash.sql");
  assert.equal(backfillLegacyScoreFileNames(targetArgs), 4);
  assert.equal(backfillLegacyScoreFileNames(targetArgs), 0);
  applyMigrations(
    "0006_default_shared_layer_slots.sql",
    "0006_preview_entry.sql",
  );
  executeD1({ command: legacyPreviewFixtureSql(), targetArgs });
  applyMigrations(
    "0007_rename_product_drives.sql",
    "0008_text_annotation_font_scale.sql",
    "0009_fixed_layer_preferences.sql",
    "0010_remove_score_layer_colors.sql",
  );

  const inviteState = query("SELECT id, join_code_hash, guest_session_version FROM choirs ORDER BY id");
  applyMigrations("0011_retrievable_join_codes.sql");
  const [currentInviteState, inviteCiphertexts] = queryMany([
    "SELECT id, join_code_hash, guest_session_version FROM choirs ORDER BY id",
    "SELECT join_code_ciphertext FROM choirs",
  ]);
  assert.deepEqual(currentInviteState, inviteState);
  assert(inviteCiphertexts.every((row) => row.join_code_ciphertext === null));

  executeD1({ command: "INSERT INTO rate_limits VALUES ('expired-fixture', 3, 0), ('live-fixture', 4, 9999999999999)", targetArgs });
  applyMigrations("0012_rate_limit_expiry_index.sql");
  const [rateLimits, expiryIndex, expiryPlan] = queryMany([
    "SELECT * FROM rate_limits ORDER BY key",
    "PRAGMA index_info(rate_limits_expiry_key_idx)",
    "EXPLAIN QUERY PLAN SELECT key FROM rate_limits WHERE window_expires_at <= 100 ORDER BY window_expires_at, key LIMIT 500",
  ]);
  assert.deepEqual(rateLimits, [
    { key: "expired-fixture", count: 3, window_expires_at: 0 },
    { key: "live-fixture", count: 4, window_expires_at: 9999999999999 },
  ]);
  assert.deepEqual(expiryIndex.map((row) => row.name), ["window_expires_at", "key"]);
  assert(expiryPlan.some((row) => /COVERING INDEX rate_limits_expiry_key_idx/.test(row.detail)));
  assert(!expiryPlan.some((row) => /SCAN rate_limits|TEMP B-TREE/.test(row.detail)));

  applyMigrations("0013_safe_pdf_replacement.sql");
  const state = queryNamed({
    scoreVersions: "SELECT version_revision, last_version_number FROM scores",
    scoreColumns: "PRAGMA table_info(scores)",
    scoreIndexes: "PRAGMA index_list(scores)",
    layerColumns: "PRAGMA table_info(annotation_layers)",
    layerIndexes: "PRAGMA index_list(annotation_layers)",
    scorePreferenceColumns: "PRAGMA table_info(user_score_layer_preferences)",
    defaultSharedColor: "SELECT default_color FROM choir_shared_layer_settings WHERE choir_id = 'choir' AND slot = 'S'",
    drives: "SELECT id, name FROM choirs ORDER BY id",
    scores: "SELECT id FROM scores",
    versions: "SELECT id FROM score_versions",
    layers: "SELECT id FROM annotation_layers",
    objects: "SELECT id FROM annotation_objects",
    syncOperations: "SELECT op_id FROM annotation_sync_operations",
    deletions: "SELECT id FROM score_object_deletions",
    foreignKeyCheck: "PRAGMA foreign_key_check",
  });
  assert(state.scoreVersions
    .every((row) => row.version_revision === 1 && row.last_version_number >= 1));
  verifySchema(state);
  verifyDriveNames(state.drives);
  verifyResetAndRelatedRecords(state);
  executeD1({ command: `
    INSERT INTO sqlite_sequence (name, seq)
      SELECT 'annotation_sync_operations', 1000
      WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'annotation_sync_operations');
    UPDATE sqlite_sequence SET seq = 1000 WHERE name = 'annotation_sync_operations';
  `, targetArgs });
  assert.deepEqual(query("SELECT seq FROM sqlite_sequence WHERE name = 'annotation_sync_operations'"), [{ seq: 1000 }]);
  applyMigrations("0014_user_and_membership_lifecycle.sql");
  const [sequence, userLifecycle, operationForeignKeys] = queryMany([
    "SELECT seq FROM sqlite_sequence WHERE name = 'annotation_sync_operations'",
    "SELECT * FROM user_lifecycle",
    "PRAGMA foreign_key_list(annotation_sync_operations)",
  ]);
  assert.deepEqual(sequence, [{ seq: 1000 }]);
  assert.equal(userLifecycle.length, 0);
  assert(operationForeignKeys
    .some((row) => row.from === "actor_user_id" && row.on_delete === "SET NULL"));
  applyMigrations("0015_score_images.sql", "0016_diagnostic_reports.sql");
  executeD1({ command: `
    INSERT INTO scores (id, choir_id, file_name, file_name_key, created_at, updated_at)
      VALUES ('preserved-score', 'choir', '保留.pdf', '保留.pdf', 1, 1);
    INSERT INTO annotation_layers(id, choir_id, score_id, kind, default_slot, name, default_color)
      VALUES ('preserved-layer', 'choir', 'preserved-score', 'shared', 'E', 'Ensemble', '#a12652');
    INSERT INTO annotation_objects(id, choir_id, score_id, layer_id, version, deleted, payload_json, created_by_display_name, updated_by_display_name, created_at, updated_at)
      VALUES ('preserved-object', 'choir', 'preserved-score', 'preserved-layer', 3, 0, '{}', '作者', '作者', 1, 1);
    INSERT INTO annotation_sync_operations(op_id, choir_id, score_id, layer_id, annotation_id, actor_user_id, base_version, operation_type, payload_hash, status, resulting_version, created_at)
      VALUES ('preserved-op', 'choir', 'preserved-score', 'preserved-layer', 'preserved-object', 'user', 2, 'upsert', '', 'accepted', 3, 1);
    INSERT INTO user_drive_layer_preferences(user_id, choir_id, slot, subscribed, color_override) VALUES ('user', 'choir', 'E', 0, '#123456');
    INSERT INTO user_score_layer_preferences(user_id, choir_id, score_id, slot, subscribed_override) VALUES ('user', 'choir', 'preserved-score', 'E', 1);
    INSERT INTO shared_layer_edit_grants(id, choir_id, slot, membership_id) VALUES ('preserved-grant', 'choir', 'E', 'membership');
    UPDATE sqlite_sequence SET seq = 2000 WHERE name = 'annotation_sync_operations';
  `, targetArgs });
  const preservedQueries = {
    objects: "SELECT * FROM annotation_objects",
    operations: "SELECT * FROM annotation_sync_operations",
    grants: "SELECT * FROM shared_layer_edit_grants",
    drivePreferences: "SELECT * FROM user_drive_layer_preferences",
    scorePreferences: "SELECT * FROM user_score_layer_preferences",
    sequence: "SELECT seq FROM sqlite_sequence WHERE name = 'annotation_sync_operations'",
  };
  const preserved = queryNamed(preservedQueries);
  applyMigrations("0017_configurable_and_published_layers.sql");
  const driveNames = query("SELECT id, name FROM choirs");
  applyMigrations("0018_drive_name_revision.sql");
  assert.deepEqual(query("SELECT id, name FROM choirs"), driveNames);
  assert(query("SELECT name_revision FROM choirs").every(row => row.name_revision === 0));
  applyMigrations("0019_shared_layer_recycle.sql");
  assert(query("SELECT deleted_at, revision FROM choir_shared_layer_settings").every(row => row.deleted_at === null && row.revision === 0));
  assert.deepEqual(queryNamed(preservedQueries), preserved);
  assert.deepEqual(query("PRAGMA foreign_key_check"), []);
  assert.deepEqual(query("SELECT id, sharing FROM annotation_layers"), [{ id: "preserved-layer", sharing: 0 }]);
  executeD1({ command: "INSERT INTO choir_shared_layer_settings(choir_id, slot, name, default_color) VALUES ('choir', 'custom-piano', '钢琴', '#123456')", targetArgs });
  assert.equal(query("SELECT name FROM choir_shared_layer_settings WHERE slot = 'custom-piano'")[0].name, "钢琴");
  // A second active administrator makes ownership ambiguous; preview has none.
  executeD1({ command: `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('second-user', 'Second', 'second@example.test', 1, 1, 1);
    INSERT INTO memberships (id, choir_id, user_id, display_name, role) VALUES ('second-member', 'choir', 'second-user', 'Second', 'admin');
    INSERT INTO memberships (id, choir_id, user_id, display_name) SELECT 'preview-member', id, 'user', 'Preview' FROM choirs WHERE id <> 'choir';`, targetArgs });
  assert.throws(() => prepareDriveOwners(targetArgs), /explicit valid active member/);
  const mapping = Object.fromEntries(query("SELECT id FROM choirs").map(row => [row.id, 'user']));
  assert.throws(() => prepareDriveOwners(targetArgs, { ...mapping, choir: 'missing-user' }), /explicit valid active member/);
  prepareDriveOwners(targetArgs, mapping);
  applyMigrations("0020_drive_permissions.sql");
  assert(!query("PRAGMA table_info(memberships)").some(row => row.name === 'role'));
  assert(query("SELECT owner_membership_id FROM choirs").every(row => row.owner_membership_id));
  const formerAdmin = query("SELECT permissions, management_scope FROM memberships WHERE id = 'second-member'")[0];
  assert.equal(JSON.parse(formerAdmin.permissions).operations.length, 7);
  assert.equal(JSON.parse(formerAdmin.management_scope).sharedLayers, 'all');
  assert.deepEqual(query("PRAGMA foreign_key_check"), []);
  assert.throws(() => query("UPDATE memberships SET status = 'removed' WHERE id = 'membership'"));
  assert.throws(() => query("UPDATE choirs SET owner_membership_id = 'preview-member' WHERE id = 'choir'"));
  query("UPDATE choirs SET owner_membership_id = 'second-member' WHERE id = 'choir'");
  query("UPDATE memberships SET status = 'removed' WHERE id = 'membership'");
  assert.equal(query("SELECT count(*) AS count FROM effective_shared_layer_permissions WHERE membership_id = 'membership'")[0].count, 0);
  executeD1({ command: `INSERT INTO annotation_layers
    (id, choir_id, score_id, kind, owner_user_id, name, sort_order, default_color, created_at, updated_at)
    SELECT 'personal-before-209', 'choir', score_id, 'personal', 'second-user', 'Personal', 10000, '#b4235a', 1, 1
    FROM annotation_layers WHERE id = 'preserved-layer';`, targetArgs });
  const before209 = queryNamed({ objects: "SELECT * FROM annotation_objects", colors: "SELECT choir_id, slot, default_color FROM choir_shared_layer_settings ORDER BY choir_id, slot" });
  applyMigrations("0021_personal_layers_and_score_colors.sql");
  const after209 = queryNamed({ objects: "SELECT * FROM annotation_objects", colors: "SELECT choir_id, slot, default_color FROM choir_shared_layer_settings ORDER BY choir_id, slot", personal: "SELECT id, name, revision, deleted_at FROM annotation_layers WHERE kind = 'personal'", indexes: "PRAGMA index_list(annotation_layers)", preferences: "PRAGMA table_info(user_score_layer_preferences)", foreignKeys: "PRAGMA foreign_key_check" });
  assert.deepEqual(after209.objects, before209.objects);
  assert.deepEqual(after209.colors, before209.colors);
  assert.deepEqual(after209.personal, [{ id: 'personal-before-209', name: '我的笔记', revision: 0, deleted_at: null }]);
  assert(!after209.indexes.some(row => row.name === 'annotation_layers_personal_owner_uidx'));
  assert(after209.preferences.some(row => row.name === 'color_override'));
  assert.deepEqual(after209.foreignKeys, []);
  executeD1({ command: `INSERT INTO annotation_layers
    (id, choir_id, score_id, kind, owner_user_id, name, sort_order, default_color, created_at, updated_at)
    SELECT 'personal-after-209', choir_id, score_id, kind, owner_user_id, '演出提示', sort_order, default_color, 2, 2
    FROM annotation_layers WHERE id = 'personal-before-209';`, targetArgs });
  assert.equal(query("SELECT count(*) AS count FROM annotation_layers WHERE owner_user_id = 'second-user'")[0].count, 2);
  const beforeTrial = query("SELECT id, storage_limit_bytes, storage_used_bytes FROM choirs ORDER BY id");
  applyMigrations("0022_annotation_brush_styles.sql", "0023_annotation_nib.sql", "0024_free_trial_drives.sql");
  assert.deepEqual(query("SELECT id, storage_limit_bytes, storage_used_bytes FROM choirs ORDER BY id"), beforeTrial);
  assert(query("SELECT plan, score_limit, member_limit, purged_at FROM choirs").every(row => row.plan === "configured" && row.score_limit === null && row.member_limit === null && row.purged_at === null));
  assert.deepEqual(query("PRAGMA foreign_key_check"), []);
  verifyImageRetirement();
  process.stdout.write("Verified legacy score schema migration, including image retirement.\n");
} finally {
  rmSync(persistencePath, { recursive: true, force: true });
}

function verifyImageRetirement() {
  // Seed the actual 0015 tables after every preceding migration, with an
  // authorized uploader and a current PDF belonging to the existing note tree.
  executeD1({ command: `
    UPDATE choirs SET storage_used_bytes = storage_used_bytes + 100 WHERE id = 'choir';
    INSERT INTO score_versions
      (id, choir_id, score_id, version_number, object_key, size_bytes, sha256,
       etag, page_count, state, uploaded_by_membership_id, created_at, ready_at)
      VALUES ('preserved-version', 'choir', 'preserved-score', 1,
        'scores/preserved.pdf', 100, 'preserved-sha256', 'preserved-etag', 1,
        'ready', 'second-member', 1, 1);
    UPDATE scores SET current_version_id = 'preserved-version' WHERE id = 'preserved-score';
    INSERT INTO score_image_jobs (version_id, generation, state, updated_at, manifest)
      VALUES ('preserved-version', 'generation', 'ready', 123, '{}');
    INSERT INTO score_image_objects (object_key, version_id, generation) VALUES
      ('derived/new.png', 'preserved-version', 'generation'),
      ('derived/already-queued.png', 'preserved-version', 'generation'),
      ('scores/preserved.pdf', 'preserved-version', 'generation');
    INSERT INTO score_object_deletions (id, object_key, created_at) VALUES
      ('original-derivative-deletion', 'derived/already-queued.png', 123),
      ('original-pdf-deletion', 'scores/preserved.pdf', 456),
      ('original-unrelated-deletion', 'unrelated/queued.pdf', 789);
  `, targetArgs });
  const preservedQueries = {
    drives: "SELECT * FROM choirs ORDER BY id",
    scores: "SELECT * FROM scores ORDER BY id",
    versions: "SELECT * FROM score_versions ORDER BY id",
    layers: "SELECT * FROM annotation_layers ORDER BY id",
    objects: "SELECT * FROM annotation_objects ORDER BY id",
    operations: "SELECT * FROM annotation_sync_operations ORDER BY op_id",
    drivePreferences: "SELECT * FROM user_drive_layer_preferences ORDER BY user_id, choir_id, slot",
    scorePreferences: "SELECT * FROM user_score_layer_preferences ORDER BY user_id, choir_id, score_id, slot",
    sequence: "SELECT seq FROM sqlite_sequence WHERE name = 'annotation_sync_operations'",
  };
  const before = queryNamed({
    ...preservedQueries,
    foreignKeys: "PRAGMA foreign_key_check",
    jobs: "SELECT * FROM score_image_jobs",
    objectsToRetire: "SELECT object_key FROM score_image_objects ORDER BY object_key",
    deletions: "SELECT * FROM score_object_deletions ORDER BY object_key",
  });
  assert.deepEqual(before.foreignKeys, []);
  assert.equal(before.jobs.length, 1);
  assert.equal(before.objectsToRetire.length, 3);
  assert.equal(before.versions.length, 1);
  assert(before.objects.length > 0 && before.operations.length > 0);
  const expectedKeys = [...new Set([...before.deletions, ...before.objectsToRetire].map(row => row.object_key))].sort();

  applyMigrations("0025_remove_score_images.sql");

  const after = queryNamed({
    ...preservedQueries,
    foreignKeys: "PRAGMA foreign_key_check",
    retiredSchema: "SELECT name FROM sqlite_master WHERE name GLOB 'score_image_*'",
    deletions: "SELECT * FROM score_object_deletions ORDER BY object_key",
  });
  assert.deepEqual(after.retiredSchema, []);
  assert.deepEqual(after.foreignKeys, []);
  assert.deepEqual(after.deletions.map(row => row.object_key), expectedKeys);
  for (const row of before.deletions) {
    // Compare the whole record: deduplication must not replace its id or age.
    assert.deepEqual(after.deletions.find(item => item.object_key === row.object_key), row);
  }
  for (const key of Object.keys(preservedQueries)) assert.deepEqual(after[key], before[key], key);
}

function verifySchema(state) {
  const columns = state.scoreColumns.map((row) => row.name);
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
  const indexes = state.scoreIndexes.map((row) => row.name);
  assert(indexes.includes("scores_active_filename_uidx"));
  assert(indexes.includes("scores_choir_filename_idx"));
  assert(indexes.includes("scores_trash_expiry_idx"));
  const layerColumns = state.layerColumns.map(
    (row) => row.name,
  );
  assert(layerColumns.includes("default_slot"));
  const layerIndexes = state.layerIndexes.map(
    (row) => row.name,
  );
  assert(layerIndexes.includes("annotation_layers_default_slot_uidx"));
  const scorePreferenceColumns = state.scorePreferenceColumns.map((row) => row.name);
  assert(!scorePreferenceColumns.includes("color_override"));
  assert.deepEqual(
    state.defaultSharedColor,
    [{ default_color: "#7c3aed" }],
  );
}

function verifyDriveNames(drives) {
  assert.deepEqual(
    drives,
    [
      { id: "choir", name: "示例云盘" },
      { id: "preview", name: "公开体验云盘" },
    ],
  );
}

function verifyResetAndRelatedRecords(state) {
  assert.equal(state.scores.length, 0);
  assert.equal(state.versions.length, 0);
  assert.equal(state.layers.length, 0);
  assert.equal(state.objects.length, 0);
  assert.equal(state.syncOperations.length, 0);
  assert.equal(state.deletions.length, 1);
  assert.deepEqual(state.foreignKeyCheck, []);
}

function query(command) {
  return executeD1({ command, targetArgs })[0]?.results ?? [];
}

function queryMany(commands) {
  const result = executeD1({ command: commands.join(";\n"), targetArgs });
  assert.equal(result.length, commands.length);
  return result.map((entry) => entry.results ?? []);
}

function queryNamed(commands) {
  const entries = Object.entries(commands);
  const results = queryMany(entries.map(([, command]) => command));
  return Object.fromEntries(entries.map(([name], index) => [name, results[index]]));
}

function applyMigrations(...names) {
  // Calls are the data-observation boundaries above. Preserve SQL order and
  // per-migration PRAGMAs while avoiding a Wrangler process for each file.
  const file = join(persistencePath, "migration-batch.sql");
  writeFileSync(file, names.map(name => readFileSync(join(repositoryRoot, "migrations", name), "utf8")).join("\n;\n"));
  executeD1({ file, targetArgs });
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
