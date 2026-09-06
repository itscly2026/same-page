-- A deleted slot retains its enabled flag, identity and references until expiry.
ALTER TABLE choir_shared_layer_settings ADD COLUMN deleted_at INTEGER;
ALTER TABLE choir_shared_layer_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE INDEX shared_layer_recycle_expiry ON choir_shared_layer_settings(deleted_at) WHERE deleted_at IS NOT NULL;

-- The conditional parent DELETE and all dependent cleanup run as one statement.
CREATE TRIGGER shared_layer_permanent_cleanup BEFORE DELETE ON choir_shared_layer_settings
BEGIN
  DELETE FROM annotation_layers WHERE choir_id = OLD.choir_id AND kind = 'shared' AND default_slot = OLD.slot;
  DELETE FROM shared_layer_edit_grants WHERE choir_id = OLD.choir_id AND slot = OLD.slot;
  DELETE FROM user_drive_layer_preferences WHERE choir_id = OLD.choir_id AND slot = OLD.slot;
  DELETE FROM user_score_layer_preferences WHERE choir_id = OLD.choir_id AND slot = OLD.slot;
END;

CREATE TRIGGER shared_layer_operation_guard BEFORE INSERT ON annotation_sync_operations
WHEN NEW.actor_user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM annotation_layers layer JOIN choir_shared_layer_settings setting
    ON setting.choir_id = layer.choir_id AND setting.slot = layer.default_slot
  WHERE layer.id = NEW.layer_id AND layer.kind = 'shared' AND (setting.deleted_at IS NOT NULL OR setting.active = 0)
)
BEGIN
  SELECT RAISE(ABORT, 'annotation_permission_revoked');
END;
