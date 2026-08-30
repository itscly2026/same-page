PRAGMA foreign_keys = ON;

CREATE TABLE user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER))
);

CREATE TABLE session (
  id TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX session_userId_idx ON session(user_id);

CREATE TABLE account (
  id TEXT PRIMARY KEY NOT NULL,
  issuer TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX account_issuer_accountId_uidx ON account(issuer, account_id);
CREATE INDEX account_userId_idx ON account(user_id);

CREATE TABLE verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER))
);
CREATE INDEX verification_identifier_idx ON verification(identifier);

CREATE TABLE choirs (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  join_code_hash TEXT NOT NULL,
  join_code_version INTEGER NOT NULL DEFAULT 1,
  storage_limit_bytes INTEGER NOT NULL DEFAULT 1073741824 CHECK (storage_limit_bytes > 0),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX choirs_join_code_hash_uidx ON choirs(join_code_hash);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY NOT NULL,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  joined_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)),
  removed_at INTEGER
);
CREATE UNIQUE INDEX memberships_choir_user_uidx ON memberships(choir_id, user_id);
CREATE INDEX memberships_user_status_idx ON memberships(user_id, status);

CREATE TABLE shared_layer_edit_grants (
  id TEXT PRIMARY KEY NOT NULL,
  choir_id TEXT NOT NULL REFERENCES choirs(id) ON DELETE CASCADE,
  shared_layer_id TEXT NOT NULL,
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX shared_layer_edit_grants_layer_membership_uidx
  ON shared_layer_edit_grants(choir_id, shared_layer_id, membership_id);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL,
  window_expires_at INTEGER NOT NULL
);
