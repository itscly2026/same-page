-- Derived resources do not count against the PDF-only drive quota.
CREATE TABLE score_image_jobs (
  version_id TEXT PRIMARY KEY REFERENCES score_versions(id) ON DELETE CASCADE,
  generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('preparing', 'ready', 'failed')),
  updated_at INTEGER NOT NULL,
  manifest TEXT,
  failure TEXT
);
CREATE TABLE score_image_objects (
  object_key TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES score_image_jobs(version_id) ON DELETE CASCADE,
  generation TEXT NOT NULL
);
CREATE INDEX score_image_objects_version ON score_image_objects(version_id);
CREATE TRIGGER score_image_object_cleanup AFTER DELETE ON score_image_objects BEGIN
  INSERT INTO score_object_deletions(id, object_key, created_at)
  VALUES (lower(hex(randomblob(16))), OLD.object_key, unixepoch('subsec') * 1000);
END;
