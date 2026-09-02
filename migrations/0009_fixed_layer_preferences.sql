PRAGMA defer_foreign_keys = ON;

DROP TABLE annotation_sync_operations;
DROP TABLE annotation_objects;
DROP TABLE annotation_layer_preferences;
DROP TABLE annotation_layers;
DROP TABLE shared_layer_edit_grants;

INSERT OR IGNORE INTO score_object_deletions (id, object_key, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-8' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  object_key,
  cast(unixepoch('subsecond') * 1000 AS INTEGER)
FROM score_versions;

DELETE FROM scores;
UPDATE choirs SET storage_used_bytes = 0;

CREATE TABLE choir_shared_layer_settings (
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('E', 'S', 'A', 'T', 'B')),
  default_color TEXT NOT NULL,
  updated_by_membership_id TEXT REFERENCES memberships(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 AS INTEGER)),
  PRIMARY KEY (choir_id, slot)
);

CREATE TABLE user_drive_layer_preferences (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('E', 'S', 'A', 'T', 'B')),
  subscribed INTEGER NOT NULL DEFAULT 1 CHECK (subscribed IN (0, 1)),
  color_override TEXT,
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 AS INTEGER)),
  PRIMARY KEY (user_id, choir_id, slot)
);

CREATE TABLE user_score_layer_preferences (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  score_id TEXT NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('E', 'S', 'A', 'T', 'B')),
  subscribed_override INTEGER CHECK (subscribed_override IS NULL OR subscribed_override IN (0, 1)),
  color_override TEXT,
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 AS INTEGER)),
  PRIMARY KEY (user_id, score_id, slot)
);
CREATE INDEX user_score_layer_preferences_choir_idx
  ON user_score_layer_preferences(user_id, choir_id, score_id);

CREATE TABLE shared_layer_edit_grants (
  id TEXT PRIMARY KEY NOT NULL,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('E', 'S', 'A', 'T', 'B')),
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX shared_layer_edit_grants_slot_membership_uidx
  ON shared_layer_edit_grants(choir_id, slot, membership_id);

CREATE TABLE annotation_layers (
  id TEXT PRIMARY KEY,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  score_id TEXT NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('shared', 'personal')),
  owner_user_id TEXT REFERENCES user(id) ON DELETE CASCADE,
  default_slot TEXT CHECK (default_slot IS NULL OR default_slot IN ('E', 'S', 'A', 'T', 'B')),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  default_color TEXT NOT NULL,
  created_by_membership_id TEXT REFERENCES memberships(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 AS INTEGER)),
  CHECK (
    (kind = 'shared' AND owner_user_id IS NULL AND default_slot IS NOT NULL) OR
    (kind = 'personal' AND owner_user_id IS NOT NULL AND default_slot IS NULL)
  )
);
CREATE INDEX annotation_layers_score_sort_idx
  ON annotation_layers(score_id, kind, sort_order, created_at);
CREATE UNIQUE INDEX annotation_layers_personal_owner_uidx
  ON annotation_layers(score_id, owner_user_id) WHERE kind = 'personal';
CREATE UNIQUE INDEX annotation_layers_default_slot_uidx
  ON annotation_layers(score_id, default_slot) WHERE default_slot IS NOT NULL;

CREATE TABLE annotation_objects (
  id TEXT PRIMARY KEY,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  score_id TEXT NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
  layer_id TEXT NOT NULL REFERENCES annotation_layers(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  payload_json TEXT,
  created_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  created_by_display_name TEXT NOT NULL,
  updated_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  updated_by_display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (deleted = 0 AND payload_json IS NOT NULL) OR
    (deleted = 1 AND payload_json IS NULL)
  )
);
CREATE INDEX annotation_objects_score_layer_idx
  ON annotation_objects(score_id, layer_id, deleted, updated_at);

CREATE TABLE annotation_sync_operations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  score_id TEXT NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
  layer_id TEXT NOT NULL REFERENCES annotation_layers(id) ON DELETE CASCADE,
  annotation_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  base_version INTEGER NOT NULL CHECK (base_version >= 0),
  operation_type TEXT NOT NULL CHECK (operation_type IN ('upsert', 'delete')),
  payload_json TEXT,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'accepted', 'conflict')),
  resulting_version INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX annotation_sync_operations_pull_idx
  ON annotation_sync_operations(score_id, status, sequence);

INSERT INTO choir_shared_layer_settings (choir_id, slot, default_color)
SELECT choirs.id, slots.slot, slots.default_color
FROM choirs
CROSS JOIN (
  SELECT 'E' AS slot, '#a12652' AS default_color
  UNION ALL SELECT 'S', '#c2415d'
  UNION ALL SELECT 'A', '#8a5a00'
  UNION ALL SELECT 'T', '#0f766e'
  UNION ALL SELECT 'B', '#3157a4'
) AS slots;
