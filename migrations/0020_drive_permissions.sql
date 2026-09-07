-- Operators may prepopulate this table before applying this migration.
CREATE TABLE IF NOT EXISTS drive_owner_mapping (choir_id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
ALTER TABLE choirs ADD COLUMN owner_membership_id TEXT REFERENCES memberships(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE memberships ADD COLUMN permissions TEXT NOT NULL DEFAULT '{"operations":[],"sharedLayers":[]}' CHECK (json_valid(permissions));
ALTER TABLE memberships ADD COLUMN management_scope TEXT NOT NULL DEFAULT '{"operations":[],"sharedLayers":[]}' CHECK (json_valid(management_scope));
-- Explicit mappings take precedence, including when there is no active administrator.
UPDATE choirs SET owner_membership_id = (
 SELECT m.id FROM memberships m WHERE m.choir_id = choirs.id AND m.status = 'active'
 AND NOT EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = m.user_id)
 AND (m.user_id = (SELECT user_id FROM drive_owner_mapping WHERE choir_id = choirs.id)
 OR (NOT EXISTS (SELECT 1 FROM drive_owner_mapping WHERE choir_id = choirs.id) AND m.role = 'admin'
 AND (SELECT count(*) FROM memberships a WHERE a.choir_id = choirs.id AND a.status = 'active' AND a.role = 'admin'
 AND NOT EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = a.user_id)) = 1)));
CREATE TABLE drive_owner_migration_guard (valid INTEGER CHECK (valid = 1));
INSERT INTO drive_owner_migration_guard SELECT 0 FROM choirs WHERE owner_membership_id IS NULL;
DROP TABLE drive_owner_migration_guard;
UPDATE memberships SET permissions = CASE WHEN role = 'admin' AND status = 'active' THEN '{"operations":["uploadFiles","modifyFiles","trashFiles","manageInvites","removeMembers","configureLayers","editDriveInfo"],"sharedLayers":"all"}'
 ELSE json_object('operations',json('[]'),'sharedLayers',json(COALESCE((SELECT json_group_array(slot) FROM shared_layer_edit_grants WHERE membership_id = memberships.id),'[]'))) END,
 management_scope = CASE WHEN role = 'admin' AND status = 'active' THEN '{"operations":["uploadFiles","modifyFiles","trashFiles","manageInvites","removeMembers","configureLayers","editDriveInfo"],"sharedLayers":"all"}' ELSE '{"operations":[],"sharedLayers":[]}' END;
-- Ownership itself is implicit; retain no automatic explicit grants for the mapped owner.
UPDATE memberships SET permissions = '{"operations":[],"sharedLayers":[]}', management_scope = '{"operations":[],"sharedLayers":[]}'
 WHERE id IN (SELECT owner_membership_id FROM choirs) AND role = 'admin';
DROP TRIGGER memberships_last_admin_update;
DROP TRIGGER user_lifecycle_restore;
DROP TRIGGER annotation_operation_lifecycle_guard;
DROP TRIGGER score_version_uploader_guard;
DROP TRIGGER score_version_ready_guard;
ALTER TABLE memberships DROP COLUMN role;
CREATE UNIQUE INDEX choirs_owner_membership_uidx ON choirs(owner_membership_id);
CREATE TRIGGER choir_owner_insert BEFORE INSERT ON choirs
WHEN NEW.owner_membership_id IS NULL OR EXISTS (SELECT 1 FROM memberships WHERE id = NEW.owner_membership_id AND (choir_id <> NEW.id OR status <> 'active'))
BEGIN SELECT RAISE(ABORT, 'owner_required'); END;
CREATE TRIGGER choir_owner_update BEFORE UPDATE OF owner_membership_id ON choirs
WHEN NEW.owner_membership_id IS NULL OR NOT EXISTS (SELECT 1 FROM memberships WHERE id = NEW.owner_membership_id AND choir_id = NEW.id AND status = 'active'
 AND NOT EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = memberships.user_id))
BEGIN SELECT RAISE(ABORT, 'owner_required'); END;
CREATE TRIGGER owner_membership_insert BEFORE INSERT ON memberships
WHEN EXISTS (SELECT 1 FROM choirs WHERE owner_membership_id = NEW.id AND (id <> NEW.choir_id OR NEW.status <> 'active'))
BEGIN SELECT RAISE(ABORT, 'owner_required'); END;
CREATE TRIGGER owner_membership_update BEFORE UPDATE OF status, choir_id, user_id, id ON memberships
WHEN EXISTS (SELECT 1 FROM choirs WHERE owner_membership_id = OLD.id) AND (NEW.status <> 'active' OR NEW.choir_id <> OLD.choir_id OR NEW.user_id <> OLD.user_id OR NEW.id <> OLD.id)
BEGIN SELECT RAISE(ABORT, 'owner_requires_transfer'); END;
CREATE TRIGGER owner_membership_delete BEFORE DELETE ON memberships
WHEN EXISTS (SELECT 1 FROM choirs WHERE owner_membership_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'owner_requires_transfer'); END;
CREATE TRIGGER removed_membership_permissions AFTER UPDATE OF status ON memberships WHEN NEW.status = 'removed'
BEGIN UPDATE memberships SET permissions = '{"operations":[],"sharedLayers":[]}', management_scope = '{"operations":[],"sharedLayers":[]}' WHERE id = NEW.id; END;
CREATE TRIGGER user_lifecycle_restore AFTER DELETE ON user_lifecycle WHEN EXISTS (SELECT 1 FROM user WHERE id = OLD.user_id)
BEGIN
 UPDATE memberships SET status = 'active', removed_at = NULL, removed_for_deletion_id = NULL,
 lifecycle_revision = lifecycle_revision + 1, last_lifecycle_action = 'restore-user'
 WHERE user_id = OLD.user_id AND removed_for_deletion_id = OLD.deletion_id;
 DELETE FROM session WHERE user_id = OLD.user_id;
END;
CREATE TABLE permission_changes (
 id TEXT PRIMARY KEY, choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
 actor_name TEXT NOT NULL, target_name TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX permission_changes_drive_time ON permission_changes(choir_id, created_at DESC);
CREATE VIEW membership_capabilities AS SELECT m.*, c.owner_membership_id = m.id AS is_owner,
 (c.owner_membership_id = m.id OR EXISTS (SELECT 1 FROM json_each(m.permissions, '$.operations') WHERE value = 'uploadFiles')) AS uploadFiles,
 (c.owner_membership_id = m.id OR EXISTS (SELECT 1 FROM json_each(m.permissions, '$.operations') WHERE value = 'modifyFiles')) AS modifyFiles,
 (c.owner_membership_id = m.id OR EXISTS (SELECT 1 FROM json_each(m.permissions, '$.operations') WHERE value = 'trashFiles')) AS trashFiles,
 (c.owner_membership_id = m.id OR EXISTS (SELECT 1 FROM json_each(m.permissions, '$.operations') WHERE value = 'manageInvites')) AS manageInvites,
 (c.owner_membership_id = m.id OR EXISTS (SELECT 1 FROM json_each(m.permissions, '$.operations') WHERE value = 'removeMembers')) AS removeMembers,
 (c.owner_membership_id = m.id OR EXISTS (SELECT 1 FROM json_each(m.permissions, '$.operations') WHERE value = 'configureLayers')) AS configureLayers,
 (c.owner_membership_id = m.id OR EXISTS (SELECT 1 FROM json_each(m.permissions, '$.operations') WHERE value = 'editDriveInfo')) AS editDriveInfo
 FROM memberships m JOIN choirs c ON c.id = m.choir_id WHERE m.status = 'active' AND NOT EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = m.user_id);
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
          OR (layer.kind = 'shared' AND member.id IS NOT NULL AND (EXISTS (SELECT 1 FROM effective_shared_layer_permissions WHERE membership_id = member.id AND choir_id = layer.choir_id AND slot = layer.default_slot))))
    ))
BEGIN
  SELECT RAISE(ABORT, 'annotation_permission_revoked');
END;
CREATE TRIGGER score_version_uploader_guard BEFORE INSERT ON score_versions
 WHEN NEW.uploaded_by_membership_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM membership_capabilities WHERE id = NEW.uploaded_by_membership_id AND choir_id = NEW.choir_id
 AND CASE WHEN NEW.base_revision IS NOT NULL THEN modifyFiles ELSE uploadFiles END)
 BEGIN SELECT RAISE(ABORT, 'upload_permission_revoked'); END;
CREATE TRIGGER score_version_ready_guard BEFORE UPDATE OF state ON score_versions
 WHEN NEW.state = 'ready' AND OLD.state = 'pending' AND NEW.uploaded_by_membership_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM membership_capabilities WHERE id = NEW.uploaded_by_membership_id AND choir_id = NEW.choir_id
 AND CASE WHEN NEW.base_revision IS NOT NULL THEN modifyFiles ELSE uploadFiles END)
 BEGIN SELECT RAISE(ABORT, 'upload_permission_revoked'); END;

DROP TRIGGER memberships_remove_grants;
CREATE TRIGGER memberships_remove_grants
AFTER UPDATE OF status ON memberships WHEN OLD.status = 'active' AND NEW.status = 'removed'
BEGIN
  UPDATE annotation_layers SET sharing = 0 WHERE choir_id = NEW.choir_id AND owner_user_id = NEW.user_id;
  DELETE FROM personal_layer_subscriptions WHERE user_id = NEW.user_id AND layer_id IN (SELECT id FROM annotation_layers WHERE choir_id = NEW.choir_id);
END;
DROP TRIGGER shared_layer_permanent_cleanup;
CREATE TRIGGER shared_layer_permanent_cleanup BEFORE DELETE ON choir_shared_layer_settings
BEGIN
  UPDATE memberships SET permissions = CASE WHEN json_type(permissions, '$.sharedLayers') = 'array' THEN json_set(permissions, '$.sharedLayers', json((SELECT json_group_array(value) FROM json_each(permissions, '$.sharedLayers') WHERE value <> OLD.slot))) ELSE permissions END,
    management_scope = CASE WHEN json_type(management_scope, '$.sharedLayers') = 'array' THEN json_set(management_scope, '$.sharedLayers', json((SELECT json_group_array(value) FROM json_each(management_scope, '$.sharedLayers') WHERE value <> OLD.slot))) ELSE management_scope END, lifecycle_revision = lifecycle_revision + 1 WHERE choir_id = OLD.choir_id AND (EXISTS (SELECT 1 FROM json_each(permissions, '$.sharedLayers') WHERE value = OLD.slot) OR EXISTS (SELECT 1 FROM json_each(management_scope, '$.sharedLayers') WHERE value = OLD.slot));
  DELETE FROM annotation_layers WHERE choir_id = OLD.choir_id AND kind = 'shared' AND default_slot = OLD.slot;
  DELETE FROM user_drive_layer_preferences WHERE choir_id = OLD.choir_id AND slot = OLD.slot;
  DELETE FROM user_score_layer_preferences WHERE choir_id = OLD.choir_id AND slot = OLD.slot;
END;
DROP TABLE shared_layer_edit_grants;
CREATE VIEW effective_shared_layer_permissions AS
 SELECT m.id || ':' || layer.slot AS id, m.choir_id, layer.slot, m.id AS membership_id
 FROM membership_capabilities m JOIN choir_shared_layer_settings layer ON layer.choir_id = m.choir_id
 WHERE m.is_owner = 1 OR json_extract(m.permissions, '$.sharedLayers') = 'all'
 OR EXISTS (SELECT 1 FROM json_each(m.permissions, '$.sharedLayers') WHERE value = layer.slot);
