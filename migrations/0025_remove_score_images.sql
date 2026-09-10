-- Preserve every registered derivative before removing its metadata. Existing
-- deletion entries retain their identity and age; PDF references are checked by
-- the storage cleanup worker before deleting any queued R2 object.
INSERT OR IGNORE INTO score_object_deletions (id, object_key)
SELECT lower(hex(randomblob(16))), object_key FROM score_image_objects;

DROP TRIGGER score_image_object_cleanup;
DROP TABLE score_image_objects;
DROP TABLE score_image_jobs;
