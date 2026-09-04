ALTER TABLE scores ADD COLUMN version_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE scores ADD COLUMN last_version_number INTEGER NOT NULL DEFAULT 1;
UPDATE scores SET last_version_number = COALESCE(
  (SELECT MAX(version_number) FROM score_versions WHERE score_id = scores.id), 1
);
ALTER TABLE score_versions ADD COLUMN candidate_expires_at INTEGER;
ALTER TABLE score_versions ADD COLUMN base_revision INTEGER;

-- Pointer publication and retention changes are one SQLite statement/transaction.
CREATE TRIGGER scores_publish_version
AFTER UPDATE OF current_version_id ON scores
WHEN OLD.current_version_id IS NOT NULL AND NEW.current_version_id <> OLD.current_version_id
BEGIN
  UPDATE scores SET version_revision = OLD.version_revision + 1 WHERE id = NEW.id;
  UPDATE score_versions SET retention_expires_at = NEW.updated_at + 2592000000
    WHERE id = OLD.current_version_id;
  UPDATE score_versions SET retention_expires_at = NULL, candidate_expires_at = NULL
    WHERE id = NEW.current_version_id;
END;
CREATE INDEX score_versions_candidate_expiry_idx ON score_versions(candidate_expires_at);
