-- Existing drives retain their configured capacity and unrestricted counts.
ALTER TABLE choirs ADD COLUMN plan TEXT NOT NULL DEFAULT 'configured' CHECK (plan IN ('configured','free'));
ALTER TABLE choirs ADD COLUMN score_limit INTEGER CHECK (score_limit > 0);
ALTER TABLE choirs ADD COLUMN member_limit INTEGER CHECK (member_limit > 0);
ALTER TABLE choirs ADD COLUMN purged_at INTEGER;
ALTER TABLE scores ADD COLUMN purged_at INTEGER;
ALTER TABLE score_versions ADD COLUMN purged_at INTEGER;
CREATE INDEX choirs_purged_idx ON choirs(purged_at);
CREATE INDEX scores_purged_idx ON scores(purged_at);
CREATE INDEX versions_purged_idx ON score_versions(purged_at);
CREATE TABLE drive_platform_limits (id INTEGER PRIMARY KEY CHECK (id = 1), free_drive_limit INTEGER NOT NULL CHECK (free_drive_limit > 0));
INSERT INTO drive_platform_limits VALUES (1, 100);
CREATE TRIGGER free_drive_count BEFORE INSERT ON choirs
WHEN NEW.plan = 'free' AND NEW.purged_at IS NULL AND (SELECT count(*) FROM choirs WHERE plan = 'free' AND purged_at IS NULL) >= (SELECT free_drive_limit FROM drive_platform_limits WHERE id = 1)
BEGIN SELECT RAISE(ABORT, 'free_drive_limit_reached'); END;
CREATE TRIGGER free_drive_owner_insert BEFORE INSERT ON memberships
WHEN EXISTS (SELECT 1 FROM choirs WHERE owner_membership_id = NEW.id AND plan = 'free' AND purged_at IS NULL)
AND EXISTS (SELECT 1 FROM choirs c JOIN memberships m ON m.id = c.owner_membership_id WHERE c.plan = 'free' AND c.purged_at IS NULL AND m.user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'owned_drive_limit_reached'); END;
CREATE TRIGGER free_drive_owner_transfer BEFORE UPDATE OF owner_membership_id ON choirs
WHEN NEW.plan = 'free' AND NEW.purged_at IS NULL AND EXISTS (
 SELECT 1 FROM choirs c JOIN memberships m ON m.id = c.owner_membership_id
 WHERE c.id <> NEW.id AND c.plan = 'free' AND c.purged_at IS NULL
 AND m.user_id = (SELECT user_id FROM memberships WHERE id = NEW.owner_membership_id))
BEGIN SELECT RAISE(ABORT, 'owned_drive_limit_reached'); END;
CREATE TRIGGER drive_member_limit_insert BEFORE INSERT ON memberships WHEN NEW.status = 'active' AND
(SELECT count(*) FROM memberships WHERE choir_id = NEW.choir_id AND status = 'active') >= (SELECT member_limit FROM choirs WHERE id = NEW.choir_id)
BEGIN SELECT RAISE(ABORT, 'member_limit_reached'); END;
CREATE TRIGGER drive_member_limit_restore BEFORE UPDATE OF status ON memberships WHEN NEW.status = 'active' AND OLD.status <> 'active' AND
(SELECT count(*) FROM memberships WHERE choir_id = NEW.choir_id AND status = 'active') >= (SELECT member_limit FROM choirs WHERE id = NEW.choir_id)
BEGIN SELECT RAISE(ABORT, 'member_limit_reached'); END;
CREATE TRIGGER drive_score_limit_insert BEFORE INSERT ON scores WHEN NEW.trashed_at IS NULL AND
(SELECT count(*) FROM scores WHERE choir_id = NEW.choir_id AND trashed_at IS NULL) >= (SELECT score_limit FROM choirs WHERE id = NEW.choir_id)
BEGIN SELECT RAISE(ABORT, 'score_limit_reached'); END;
CREATE TRIGGER drive_score_limit_restore BEFORE UPDATE OF trashed_at ON scores WHEN NEW.trashed_at IS NULL AND OLD.trashed_at IS NOT NULL AND
(SELECT count(*) FROM scores WHERE choir_id = NEW.choir_id AND trashed_at IS NULL) >= (SELECT score_limit FROM choirs WHERE id = NEW.choir_id)
BEGIN SELECT RAISE(ABORT, 'score_limit_reached'); END;
DROP VIEW membership_capabilities;
CREATE VIEW membership_capabilities AS SELECT m.*, c.owner_membership_id = m.id AS is_owner,
 (c.owner_membership_id = m.id OR EXISTS (SELECT 1 FROM json_each(m.permissions, '$.operations') WHERE value = 'uploadFiles')) AS uploadFiles,
 (c.owner_membership_id = m.id OR EXISTS (SELECT 1 FROM json_each(m.permissions, '$.operations') WHERE value = 'modifyFiles')) AS modifyFiles,
 (c.owner_membership_id = m.id OR EXISTS (SELECT 1 FROM json_each(m.permissions, '$.operations') WHERE value = 'trashFiles')) AS trashFiles,
 (c.owner_membership_id = m.id OR EXISTS (SELECT 1 FROM json_each(m.permissions, '$.operations') WHERE value = 'manageInvites')) AS manageInvites,
 (c.owner_membership_id = m.id OR EXISTS (SELECT 1 FROM json_each(m.permissions, '$.operations') WHERE value = 'removeMembers')) AS removeMembers,
 (c.owner_membership_id = m.id OR EXISTS (SELECT 1 FROM json_each(m.permissions, '$.operations') WHERE value = 'configureLayers')) AS configureLayers,
 (c.owner_membership_id = m.id OR EXISTS (SELECT 1 FROM json_each(m.permissions, '$.operations') WHERE value = 'editDriveInfo')) AS editDriveInfo
 FROM memberships m JOIN choirs c ON c.id = m.choir_id WHERE c.purged_at IS NULL AND m.status = 'active' AND NOT EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = m.user_id);

-- Releasing product quota is separate from physical cleanup.
DROP TRIGGER score_versions_release_storage;
CREATE TRIGGER score_versions_release_storage AFTER DELETE ON score_versions WHEN OLD.purged_at IS NULL
BEGIN UPDATE choirs SET storage_used_bytes = MAX(0, storage_used_bytes - OLD.size_bytes) WHERE id = OLD.choir_id; END;
CREATE TRIGGER version_soft_delete AFTER UPDATE OF purged_at ON score_versions WHEN OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL
BEGIN UPDATE choirs SET storage_used_bytes = MAX(0, storage_used_bytes - OLD.size_bytes) WHERE id = OLD.choir_id; END;
CREATE TRIGGER score_soft_delete AFTER UPDATE OF purged_at ON scores WHEN OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL
BEGIN UPDATE score_versions SET purged_at = NEW.purged_at WHERE score_id = NEW.id AND purged_at IS NULL; END;
CREATE TRIGGER drive_soft_delete AFTER UPDATE OF purged_at ON choirs WHEN OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL
BEGIN
 UPDATE scores SET trashed_at = COALESCE(trashed_at, NEW.purged_at), trash_expires_at = NEW.purged_at + 2592000000, purged_at = NEW.purged_at WHERE choir_id = NEW.id AND purged_at IS NULL;
END;
CREATE TRIGGER score_version_not_purged BEFORE UPDATE OF current_version_id ON scores WHEN NEW.current_version_id IS NOT NULL AND
 EXISTS (SELECT 1 FROM score_versions WHERE id = NEW.current_version_id AND purged_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'resource_deleted'); END;
CREATE TRIGGER score_no_restore_purged BEFORE UPDATE ON scores WHEN OLD.purged_at IS NOT NULL AND
 (NEW.purged_at IS NOT OLD.purged_at OR NEW.trashed_at IS NULL OR NEW.current_version_id IS NOT OLD.current_version_id)
BEGIN SELECT RAISE(ABORT, 'resource_deleted'); END;
CREATE TRIGGER drive_no_restore_purged BEFORE UPDATE OF purged_at ON choirs WHEN OLD.purged_at IS NOT NULL AND NEW.purged_at IS NOT OLD.purged_at
BEGIN SELECT RAISE(ABORT, 'resource_deleted'); END;
CREATE TRIGGER version_no_restore_purged BEFORE UPDATE OF purged_at ON score_versions WHEN OLD.purged_at IS NOT NULL AND NEW.purged_at IS NOT OLD.purged_at
BEGIN SELECT RAISE(ABORT, 'resource_deleted'); END;
CREATE TRIGGER annotation_deleted_drive BEFORE INSERT ON annotation_sync_operations WHEN NEW.status = 'processing' AND
 EXISTS (SELECT 1 FROM choirs WHERE id = NEW.choir_id AND purged_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'annotation_permission_revoked'); END;
DROP TRIGGER owner_membership_update;
CREATE TRIGGER owner_membership_update BEFORE UPDATE OF status, choir_id, user_id, id ON memberships
WHEN EXISTS (SELECT 1 FROM choirs WHERE owner_membership_id = OLD.id AND purged_at IS NULL) AND (NEW.status <> 'active' OR NEW.choir_id <> OLD.choir_id OR NEW.user_id <> OLD.user_id OR NEW.id <> OLD.id)
BEGIN SELECT RAISE(ABORT, 'owner_requires_transfer'); END;
DROP TRIGGER owner_membership_delete;
CREATE TRIGGER owner_membership_delete BEFORE DELETE ON memberships
WHEN EXISTS (SELECT 1 FROM choirs WHERE owner_membership_id = OLD.id AND purged_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'owner_requires_transfer'); END;
DROP TRIGGER user_lifecycle_restore;
CREATE TRIGGER user_lifecycle_restore AFTER DELETE ON user_lifecycle WHEN EXISTS (SELECT 1 FROM user WHERE id = OLD.user_id)
BEGIN
 UPDATE memberships SET status = 'active', removed_at = NULL, removed_for_deletion_id = NULL,
 lifecycle_revision = lifecycle_revision + 1, last_lifecycle_action = 'restore-user'
 WHERE user_id = OLD.user_id AND removed_for_deletion_id = OLD.deletion_id
 AND EXISTS (SELECT 1 FROM choirs c WHERE c.id = memberships.choir_id AND c.purged_at IS NULL AND
 (c.member_limit IS NULL OR (SELECT count(*) FROM memberships m WHERE m.choir_id = c.id AND m.status = 'active') < c.member_limit));
 UPDATE memberships SET removed_for_deletion_id = NULL WHERE user_id = OLD.user_id AND removed_for_deletion_id = OLD.deletion_id;
 DELETE FROM session WHERE user_id = OLD.user_id;
END;
CREATE TRIGGER member_active_drive_insert BEFORE INSERT ON memberships WHEN NEW.status = 'active' AND
 (EXISTS (SELECT 1 FROM choirs WHERE id = NEW.choir_id AND purged_at IS NOT NULL) OR EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = NEW.user_id))
BEGIN SELECT RAISE(ABORT, 'resource_deleted'); END;
CREATE TRIGGER member_active_drive_restore BEFORE UPDATE OF status ON memberships WHEN NEW.status = 'active' AND OLD.status <> 'active' AND
 EXISTS (SELECT 1 FROM choirs WHERE id = NEW.choir_id AND purged_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'resource_deleted'); END;
CREATE TRIGGER version_active_score_insert BEFORE INSERT ON score_versions WHEN
 EXISTS (SELECT 1 FROM scores WHERE id = NEW.score_id AND purged_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'resource_deleted'); END;
CREATE TRIGGER version_active_score_ready BEFORE UPDATE OF state ON score_versions WHEN NEW.state = 'ready' AND OLD.state = 'pending' AND
 EXISTS (SELECT 1 FROM scores WHERE id = NEW.score_id AND purged_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'resource_deleted'); END;
-- A separate platform ceiling includes retained PDFs, so cycling user quota cannot
-- grow the free-trial archive without bound. Operators may adjust this ceiling.
ALTER TABLE drive_platform_limits ADD COLUMN retained_pdf_limit_bytes INTEGER NOT NULL DEFAULT 21474836480 CHECK (retained_pdf_limit_bytes > 0);
CREATE TRIGGER free_platform_storage_guard BEFORE INSERT ON score_versions WHEN
 EXISTS (SELECT 1 FROM choirs WHERE id = NEW.choir_id AND plan = 'free') AND
 (SELECT COALESCE(sum(v.size_bytes),0) FROM score_versions v JOIN choirs c ON c.id = v.choir_id WHERE c.plan = 'free') + NEW.size_bytes >
 (SELECT retained_pdf_limit_bytes FROM drive_platform_limits WHERE id = 1)
BEGIN SELECT RAISE(ABORT, 'platform_storage_limit_reached'); END;
