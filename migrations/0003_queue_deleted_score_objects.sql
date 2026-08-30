CREATE TRIGGER score_versions_queue_object_delete
AFTER DELETE ON score_versions
BEGIN
  INSERT OR IGNORE INTO score_object_deletions (id, object_key)
  VALUES (lower(hex(randomblob(16))), OLD.object_key);
END;
