PRAGMA defer_foreign_keys = ON;

-- Preserve every annotation identity and sync cursor while opening layer keys to drive configuration.

DROP TRIGGER memberships_remove_grants;

DROP TRIGGER user_lifecycle_delete;

DROP TRIGGER user_lifecycle_restore;

DROP TRIGGER annotation_operation_lifecycle_guard;

DROP TRIGGER annotation_attribution_sync;

DROP TRIGGER membership_final_attribution;

CREATE TABLE _layer_migration_sequence AS SELECT seq FROM sqlite_sequence WHERE name = 'annotation_sync_operations';

CREATE TABLE _layer_backup_choir_shared_layer_settings AS SELECT * FROM choir_shared_layer_settings;

CREATE TABLE _layer_backup_user_drive_layer_preferences AS SELECT * FROM user_drive_layer_preferences;

CREATE TABLE _layer_backup_user_score_layer_preferences AS SELECT * FROM user_score_layer_preferences;

CREATE TABLE _layer_backup_shared_layer_edit_grants AS SELECT * FROM shared_layer_edit_grants;

CREATE TABLE _layer_backup_annotation_layers AS SELECT * FROM annotation_layers;

CREATE TABLE _layer_backup_annotation_objects AS SELECT * FROM annotation_objects;

CREATE TABLE _layer_backup_annotation_sync_operations AS SELECT * FROM annotation_sync_operations;

DROP TABLE annotation_sync_operations;

DROP TABLE annotation_objects;

DROP TABLE annotation_layers;

DROP TABLE shared_layer_edit_grants;

DROP TABLE user_score_layer_preferences;

DROP TABLE user_drive_layer_preferences;

DROP TABLE choir_shared_layer_settings;

CREATE TABLE choir_shared_layer_settings (
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  default_color TEXT NOT NULL,
  updated_by_membership_id TEXT REFERENCES memberships(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 AS INTEGER)),
  PRIMARY KEY (choir_id, slot)
);

INSERT INTO choir_shared_layer_settings SELECT * FROM _layer_backup_choir_shared_layer_settings;

DROP TABLE _layer_backup_choir_shared_layer_settings;

CREATE TABLE user_drive_layer_preferences (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  subscribed INTEGER NOT NULL DEFAULT 1 CHECK (subscribed IN (0, 1)),
  color_override TEXT,
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 AS INTEGER)),
  PRIMARY KEY (user_id, choir_id, slot)
);

INSERT INTO user_drive_layer_preferences SELECT * FROM _layer_backup_user_drive_layer_preferences;

DROP TABLE _layer_backup_user_drive_layer_preferences;

CREATE TABLE user_score_layer_preferences (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  score_id TEXT NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  subscribed_override INTEGER CHECK (subscribed_override IS NULL OR subscribed_override IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 AS INTEGER)),
  PRIMARY KEY (user_id, score_id, slot)
);

INSERT INTO user_score_layer_preferences SELECT * FROM _layer_backup_user_score_layer_preferences;

DROP TABLE _layer_backup_user_score_layer_preferences;

CREATE INDEX user_score_layer_preferences_choir_idx
  ON user_score_layer_preferences(user_id, choir_id, score_id);

CREATE TABLE shared_layer_edit_grants (
  id TEXT PRIMARY KEY NOT NULL,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 AS INTEGER))
);

INSERT INTO shared_layer_edit_grants SELECT * FROM _layer_backup_shared_layer_edit_grants;

DROP TABLE _layer_backup_shared_layer_edit_grants;

CREATE UNIQUE INDEX shared_layer_edit_grants_slot_membership_uidx
  ON shared_layer_edit_grants(choir_id, slot, membership_id);

CREATE TABLE annotation_layers (
  id TEXT PRIMARY KEY,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  score_id TEXT NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('shared', 'personal')),
  owner_user_id TEXT REFERENCES user(id) ON DELETE CASCADE,
  default_slot TEXT,
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

INSERT INTO annotation_layers SELECT * FROM _layer_backup_annotation_layers;

DROP TABLE _layer_backup_annotation_layers;

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

INSERT INTO annotation_objects SELECT * FROM _layer_backup_annotation_objects;

DROP TABLE _layer_backup_annotation_objects;

CREATE INDEX annotation_objects_score_layer_idx
  ON annotation_objects(score_id, layer_id, deleted, updated_at);

CREATE TABLE annotation_sync_operations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  score_id TEXT NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
  layer_id TEXT NOT NULL REFERENCES annotation_layers(id) ON DELETE CASCADE,
  annotation_id TEXT NOT NULL,
  actor_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  base_version INTEGER NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('upsert', 'delete')),
  payload_json TEXT,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'accepted', 'conflict')),
  resulting_version INTEGER,
  created_at INTEGER NOT NULL
);

INSERT INTO annotation_sync_operations SELECT * FROM _layer_backup_annotation_sync_operations;

DROP TABLE _layer_backup_annotation_sync_operations;

CREATE INDEX annotation_sync_operations_pull_idx ON annotation_sync_operations(score_id, status, sequence);

INSERT INTO sqlite_sequence(name, seq) SELECT 'annotation_sync_operations', seq FROM _layer_migration_sequence WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'annotation_sync_operations');

UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM _layer_migration_sequence), 0)) WHERE name = 'annotation_sync_operations';

DROP TABLE _layer_migration_sequence;

ALTER TABLE choir_shared_layer_settings ADD COLUMN name TEXT NOT NULL DEFAULT '';

ALTER TABLE choir_shared_layer_settings ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE choir_shared_layer_settings ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1));

UPDATE choir_shared_layer_settings SET name = CASE slot WHEN 'E' THEN 'Ensemble' WHEN 'S' THEN 'Soprano' WHEN 'A' THEN 'Alto' WHEN 'T' THEN 'Tenor' WHEN 'B' THEN 'Bass' END, sort_order = CASE slot WHEN 'E' THEN 0 WHEN 'S' THEN 1 WHEN 'A' THEN 2 WHEN 'T' THEN 3 WHEN 'B' THEN 4 END;

ALTER TABLE annotation_layers ADD COLUMN sharing INTEGER NOT NULL DEFAULT 0 CHECK(sharing IN (0,1));

CREATE TABLE personal_layer_subscriptions (
 user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 layer_id TEXT NOT NULL REFERENCES annotation_layers(id) ON DELETE CASCADE,
 PRIMARY KEY(user_id, layer_id)
);

CREATE TRIGGER memberships_remove_grants
AFTER UPDATE OF status ON memberships WHEN OLD.status = 'active' AND NEW.status = 'removed'
BEGIN
  UPDATE annotation_layers SET sharing = 0 WHERE choir_id = NEW.choir_id AND owner_user_id = NEW.user_id;
  DELETE FROM personal_layer_subscriptions WHERE user_id = NEW.user_id AND layer_id IN (SELECT id FROM annotation_layers WHERE choir_id = NEW.choir_id);
  DELETE FROM shared_layer_edit_grants WHERE membership_id = NEW.id;
END;

CREATE TRIGGER user_lifecycle_delete
AFTER INSERT ON user_lifecycle
BEGIN
  UPDATE annotation_objects SET created_by_display_name = (
    SELECT display_name FROM memberships WHERE user_id = NEW.user_id AND choir_id = annotation_objects.choir_id
  ) WHERE created_by_user_id = NEW.user_id
    AND EXISTS (SELECT 1 FROM annotation_layers WHERE id = annotation_objects.layer_id AND kind = 'shared')
    AND EXISTS (SELECT 1 FROM memberships WHERE user_id = NEW.user_id AND choir_id = annotation_objects.choir_id);
  UPDATE annotation_objects SET updated_by_display_name = (
    SELECT display_name FROM memberships WHERE user_id = NEW.user_id AND choir_id = annotation_objects.choir_id
  ) WHERE updated_by_user_id = NEW.user_id
    AND EXISTS (SELECT 1 FROM annotation_layers WHERE id = annotation_objects.layer_id AND kind = 'shared')
    AND EXISTS (SELECT 1 FROM memberships WHERE user_id = NEW.user_id AND choir_id = annotation_objects.choir_id);
  UPDATE memberships SET status = 'removed', removed_at = NEW.deleted_at,
    removed_for_deletion_id = NEW.deletion_id, lifecycle_revision = lifecycle_revision + 1,
    last_lifecycle_action = 'delete-user'
    WHERE user_id = NEW.user_id AND status = 'active';
  DELETE FROM session WHERE user_id = NEW.user_id;
  DELETE FROM lifecycle_reauthentication WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER user_lifecycle_restore
AFTER DELETE ON user_lifecycle
WHEN EXISTS (SELECT 1 FROM user WHERE id = OLD.user_id)
BEGIN
  UPDATE memberships SET status = 'active', role = 'member', removed_at = NULL,
    removed_for_deletion_id = NULL, lifecycle_revision = lifecycle_revision + 1,
    last_lifecycle_action = 'restore-user'
    WHERE user_id = OLD.user_id AND removed_for_deletion_id = OLD.deletion_id;
  DELETE FROM session WHERE user_id = OLD.user_id;
END;

CREATE TRIGGER annotation_operation_lifecycle_guard
BEFORE INSERT ON annotation_sync_operations
WHEN NEW.status = 'processing' AND NEW.actor_user_id IS NOT NULL
  AND (EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = NEW.actor_user_id)
    OR NOT EXISTS (
      SELECT 1 FROM annotation_layers AS layer JOIN choirs ON choirs.id = layer.choir_id
      JOIN scores ON scores.id = layer.score_id
      LEFT JOIN memberships AS member ON member.choir_id = layer.choir_id
        AND member.user_id = NEW.actor_user_id AND member.status = 'active'
      WHERE layer.id = NEW.layer_id AND layer.choir_id = NEW.choir_id AND layer.score_id = NEW.score_id
        AND scores.trashed_at IS NULL
        AND ((layer.kind = 'personal' AND layer.owner_user_id = NEW.actor_user_id
          AND (member.id IS NOT NULL OR (choirs.is_preview_entry = 1 AND choirs.guest_admission_mode = 'open')))
          OR (layer.kind = 'shared' AND member.id IS NOT NULL AND (member.role = 'admin' OR EXISTS (
            SELECT 1 FROM shared_layer_edit_grants WHERE membership_id = member.id AND choir_id = layer.choir_id AND slot = layer.default_slot))))
    ))
BEGIN
  SELECT RAISE(ABORT, 'annotation_permission_revoked');
END;

CREATE TRIGGER annotation_attribution_sync
AFTER UPDATE OF created_by_display_name, updated_by_display_name ON annotation_objects
WHEN OLD.created_by_display_name <> NEW.created_by_display_name OR OLD.updated_by_display_name <> NEW.updated_by_display_name
BEGIN
  INSERT INTO annotation_sync_operations
    (op_id, choir_id, score_id, layer_id, annotation_id, actor_user_id, base_version,
     operation_type, payload_json, payload_hash, status, resulting_version, created_at)
  VALUES ('attribution:' || lower(hex(randomblob(16))), NEW.choir_id, NEW.score_id, NEW.layer_id, NEW.id,
    NULL, NEW.version, CASE WHEN NEW.deleted = 1 THEN 'delete' ELSE 'upsert' END,
    NEW.payload_json, '', 'accepted', NEW.version, NEW.updated_at);
END;

CREATE TRIGGER membership_final_attribution
BEFORE DELETE ON memberships
BEGIN
  UPDATE annotation_objects SET created_by_display_name = OLD.display_name
    WHERE choir_id = OLD.choir_id AND created_by_user_id = OLD.user_id
    AND EXISTS (SELECT 1 FROM annotation_layers WHERE id = annotation_objects.layer_id AND kind = 'shared');
  UPDATE annotation_objects SET updated_by_display_name = OLD.display_name
    WHERE choir_id = OLD.choir_id AND updated_by_user_id = OLD.user_id
    AND EXISTS (SELECT 1 FROM annotation_layers WHERE id = annotation_objects.layer_id AND kind = 'shared');
END;

CREATE TRIGGER personal_layer_unshare AFTER UPDATE OF sharing ON annotation_layers
WHEN NEW.sharing = 0 AND OLD.sharing = 1
BEGIN
 DELETE FROM personal_layer_subscriptions WHERE layer_id = NEW.id;
END;
