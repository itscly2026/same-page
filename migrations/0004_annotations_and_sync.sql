CREATE TABLE annotation_layers (
  id TEXT PRIMARY KEY,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  score_id TEXT NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('shared', 'personal')),
  owner_user_id TEXT REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  default_color TEXT NOT NULL,
  created_by_membership_id TEXT REFERENCES memberships(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 AS INTEGER)),
  CHECK (
    (kind = 'shared' AND owner_user_id IS NULL) OR
    (kind = 'personal' AND owner_user_id IS NOT NULL)
  )
);

CREATE INDEX annotation_layers_score_sort_idx
  ON annotation_layers(score_id, kind, sort_order, created_at);
CREATE UNIQUE INDEX annotation_layers_personal_owner_uidx
  ON annotation_layers(score_id, owner_user_id) WHERE kind = 'personal';

CREATE TABLE annotation_layer_preferences (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  layer_id TEXT NOT NULL REFERENCES annotation_layers(id) ON DELETE CASCADE,
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  color_override TEXT,
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 AS INTEGER)),
  PRIMARY KEY (user_id, layer_id)
);

CREATE TABLE annotation_objects (
  id TEXT PRIMARY KEY,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  score_id TEXT NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
  layer_id TEXT NOT NULL REFERENCES annotation_layers(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  payload_json TEXT,
  created_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  created_by_display_name TEXT NOT NULL,
  updated_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  updated_by_display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (deleted = 0 AND payload_json IS NOT NULL) OR
    (deleted = 1 AND payload_json IS NULL)
  )
);

CREATE INDEX annotation_objects_score_layer_idx
  ON annotation_objects(score_id, layer_id, deleted, updated_at);

CREATE TABLE annotation_sync_operations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  score_id TEXT NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
  layer_id TEXT NOT NULL REFERENCES annotation_layers(id) ON DELETE CASCADE,
  annotation_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  base_version INTEGER NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('upsert', 'delete')),
  payload_json TEXT,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'accepted', 'conflict')),
  resulting_version INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX annotation_sync_operations_pull_idx
  ON annotation_sync_operations(score_id, status, sequence);
