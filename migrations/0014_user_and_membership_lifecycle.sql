ALTER TABLE memberships ADD COLUMN lifecycle_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memberships ADD COLUMN last_lifecycle_action TEXT;
ALTER TABLE memberships ADD COLUMN removed_for_deletion_id TEXT;

CREATE TABLE user_lifecycle (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  deletion_id TEXT NOT NULL UNIQUE,
  auth_method TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE lifecycle_reauthentication (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  previous_session_id TEXT NOT NULL,
  allowed_methods TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE session_auth_methods (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  method TEXT NOT NULL
);

-- Preserve the shared synchronization history after deleting identity records.
ALTER TABLE annotation_sync_operations RENAME TO annotation_sync_operations_old;
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
INSERT INTO annotation_sync_operations SELECT * FROM annotation_sync_operations_old;
-- Keep cursors valid even when the old highest operations have been deleted.
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'annotation_sync_operations', seq FROM sqlite_sequence
  WHERE name = 'annotation_sync_operations_old'
    AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'annotation_sync_operations');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE(
  (SELECT seq FROM sqlite_sequence WHERE name = 'annotation_sync_operations_old'), 0))
  WHERE name = 'annotation_sync_operations';
DROP TABLE annotation_sync_operations_old;
CREATE INDEX annotation_sync_operations_pull_idx ON annotation_sync_operations(score_id, status, sequence);

CREATE TRIGGER memberships_last_admin_update
BEFORE UPDATE OF role, status ON memberships
WHEN OLD.role = 'admin' AND OLD.status = 'active' AND (NEW.role <> 'admin' OR NEW.status <> 'active')
  AND EXISTS (SELECT 1 FROM choirs WHERE id = OLD.choir_id)
  AND NOT EXISTS (SELECT 1 FROM memberships WHERE choir_id = OLD.choir_id AND id <> OLD.id AND role = 'admin' AND status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'last_admin_requires_handoff');
END;

CREATE TRIGGER memberships_remove_grants
AFTER UPDATE OF status ON memberships WHEN OLD.status = 'active' AND NEW.status = 'removed'
BEGIN
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
CREATE INDEX user_lifecycle_expiry_idx ON user_lifecycle(expires_at);
CREATE INDEX memberships_removal_expiry_idx ON memberships(status, removed_at);

-- Permission is checked inside the same batch that accepts an operation.
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

-- Attribution-only changes still advance the pull cursor without changing OCC.
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

CREATE TRIGGER score_version_uploader_guard
BEFORE INSERT ON score_versions
WHEN NEW.uploaded_by_membership_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM memberships WHERE id = NEW.uploaded_by_membership_id
    AND choir_id = NEW.choir_id AND status = 'active' AND role = 'admin')
BEGIN
  SELECT RAISE(ABORT, 'upload_permission_revoked');
END;
CREATE TRIGGER score_version_ready_guard
BEFORE UPDATE OF state ON score_versions
WHEN NEW.state = 'ready' AND OLD.state = 'pending' AND NEW.uploaded_by_membership_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM memberships WHERE id = NEW.uploaded_by_membership_id
    AND choir_id = NEW.choir_id AND status = 'active' AND role = 'admin')
BEGIN
  SELECT RAISE(ABORT, 'upload_permission_revoked');
END;

CREATE TRIGGER user_identity_verification_cleanup
BEFORE DELETE ON user
BEGIN
  DELETE FROM verification WHERE identifier IN (
    'sign-in-otp-' || OLD.email,
    'forget-password-otp-' || OLD.email,
    'email-verification-otp-' || OLD.email
  );
END;
