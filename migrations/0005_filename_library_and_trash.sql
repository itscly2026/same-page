DROP INDEX scores_choir_status_sort_idx;

ALTER TABLE scores RENAME COLUMN title TO file_name;
ALTER TABLE scores ADD COLUMN file_name_key TEXT NOT NULL DEFAULT '';
ALTER TABLE scores ADD COLUMN trashed_at INTEGER;
ALTER TABLE scores ADD COLUMN trash_expires_at INTEGER;

UPDATE scores
SET file_name = CASE
  WHEN lower(substr(file_name, -4)) = '.pdf' THEN file_name
  ELSE file_name || '.pdf'
END;
UPDATE scores SET file_name_key = lower(file_name);

ALTER TABLE scores DROP COLUMN composer;
ALTER TABLE scores DROP COLUMN arranger;
ALTER TABLE scores DROP COLUMN sort_order;
ALTER TABLE scores DROP COLUMN status;
ALTER TABLE scores DROP COLUMN published_at;
ALTER TABLE scores DROP COLUMN archived_at;

CREATE UNIQUE INDEX scores_active_filename_uidx
  ON scores(choir_id, file_name_key) WHERE trashed_at IS NULL;
CREATE INDEX scores_choir_filename_idx
  ON scores(choir_id, file_name_key) WHERE trashed_at IS NULL;
CREATE INDEX scores_trash_expiry_idx
  ON scores(trash_expires_at) WHERE trashed_at IS NOT NULL;

CREATE TRIGGER scores_trash_dates_insert_guard
BEFORE INSERT ON scores
WHEN NOT (
  (NEW.trashed_at IS NULL AND NEW.trash_expires_at IS NULL) OR
  (NEW.trashed_at IS NOT NULL AND NEW.trash_expires_at IS NOT NULL
    AND NEW.trash_expires_at > NEW.trashed_at)
)
BEGIN
  SELECT RAISE(ABORT, 'scores_trash_dates_invalid');
END;

CREATE TRIGGER scores_trash_dates_update_guard
BEFORE UPDATE OF trashed_at, trash_expires_at ON scores
WHEN NOT (
  (NEW.trashed_at IS NULL AND NEW.trash_expires_at IS NULL) OR
  (NEW.trashed_at IS NOT NULL AND NEW.trash_expires_at IS NOT NULL
    AND NEW.trash_expires_at > NEW.trashed_at)
)
BEGIN
  SELECT RAISE(ABORT, 'scores_trash_dates_invalid');
END;
