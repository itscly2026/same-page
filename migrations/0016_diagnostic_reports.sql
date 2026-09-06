CREATE TABLE diagnostic_reports (
  id TEXT PRIMARY KEY NOT NULL,
  client_build TEXT,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'investigating', 'resolved')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX diagnostic_reports_expiry_idx ON diagnostic_reports(expires_at, id);
CREATE INDEX diagnostic_reports_status_created_idx ON diagnostic_reports(status, created_at);
CREATE INDEX diagnostic_reports_build_created_idx ON diagnostic_reports(client_build, created_at);
