-- Personal layer identity is the layer ID, never its owner's score pair or name.
DROP INDEX annotation_layers_personal_owner_uidx;
CREATE INDEX annotation_layers_personal_owner_idx ON annotation_layers(score_id, owner_user_id) WHERE kind = 'personal';
ALTER TABLE annotation_layers ADD COLUMN deleted_at INTEGER;
ALTER TABLE annotation_layers ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
UPDATE annotation_layers SET name = '我的笔记' WHERE kind = 'personal' AND name = 'Personal';
ALTER TABLE user_score_layer_preferences ADD COLUMN color_override TEXT CHECK (color_override IS NULL OR (length(color_override) = 7 AND substr(color_override, 1, 1) = '#'));
CREATE TRIGGER personal_layer_delete_unshares AFTER UPDATE OF deleted_at ON annotation_layers
WHEN NEW.kind = 'personal' AND NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE annotation_layers SET sharing = 0 WHERE id = NEW.id;
  DELETE FROM personal_layer_subscriptions WHERE layer_id = NEW.id;
END;
CREATE TRIGGER personal_layer_deleted_operation_guard BEFORE INSERT ON annotation_sync_operations
WHEN EXISTS (SELECT 1 FROM annotation_layers WHERE id = NEW.layer_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'annotation_permission_revoked'); END;
ALTER TABLE personal_layer_subscriptions ADD COLUMN subscribed INTEGER NOT NULL DEFAULT 1 CHECK(subscribed IN (0, 1));
-- Unsharing revokes readers, but does not reset the author's own display choice.
DROP TRIGGER personal_layer_unshare;
CREATE TRIGGER personal_layer_unshare AFTER UPDATE OF sharing ON annotation_layers
WHEN OLD.sharing = 1 AND NEW.sharing = 0
BEGIN
  DELETE FROM personal_layer_subscriptions WHERE layer_id = NEW.id AND user_id <> NEW.owner_user_id;
END;
-- Membership/user lifecycle triggers revoke sharing outside the layer API.
-- Advance metadata revision so an older client cannot republish on restoration.
CREATE TRIGGER personal_layer_revocation_revision AFTER UPDATE OF sharing ON annotation_layers
WHEN OLD.sharing = 1 AND NEW.sharing = 0 AND NEW.deleted_at IS NULL AND NEW.revision = OLD.revision
BEGIN UPDATE annotation_layers SET revision = revision + 1 WHERE id = NEW.id; END;
