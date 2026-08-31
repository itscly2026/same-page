ALTER TABLE choirs
  ADD COLUMN storage_used_bytes INTEGER NOT NULL DEFAULT 0
  CHECK (storage_used_bytes >= 0);

CREATE TRIGGER choirs_storage_quota_guard
BEFORE UPDATE OF storage_used_bytes ON choirs
WHEN NEW.storage_used_bytes > NEW.storage_limit_bytes
BEGIN
  SELECT RAISE(ABORT, 'choir_storage_quota_exceeded');
END;

CREATE TABLE scores (
  id TEXT PRIMARY KEY NOT NULL,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  composer TEXT,
  arranger TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  current_version_id TEXT,
  replacement_lock_id TEXT,
  replacement_lock_expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)),
  published_at INTEGER,
  archived_at INTEGER
);
CREATE INDEX scores_choir_status_sort_idx
  ON scores(choir_id, status, sort_order, title);

CREATE TABLE score_versions (
  id TEXT PRIMARY KEY NOT NULL,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  score_id TEXT NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  sha256 TEXT NOT NULL,
  etag TEXT,
  page_count INTEGER NOT NULL CHECK (page_count > 0),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'ready')),
  uploaded_by_membership_id TEXT REFERENCES memberships(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)),
  ready_at INTEGER,
  retention_expires_at INTEGER,
  UNIQUE(score_id, version_number)
);
CREATE INDEX score_versions_retention_idx
  ON score_versions(state, retention_expires_at);
CREATE INDEX score_versions_pending_idx
  ON score_versions(state, created_at);

CREATE TRIGGER score_versions_release_storage
AFTER DELETE ON score_versions
BEGIN
  UPDATE choirs
  SET storage_used_bytes = MAX(0, storage_used_bytes - OLD.size_bytes)
  WHERE id = OLD.choir_id;
END;

CREATE TABLE score_object_deletions (
  id TEXT PRIMARY KEY NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER))
);
