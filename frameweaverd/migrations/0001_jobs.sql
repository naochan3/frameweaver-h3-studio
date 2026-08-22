CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  mode TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancel_requested','cancelled','orphaned')),
  prompt TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  output_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX jobs_owner_created_idx ON jobs(owner_id, created_at DESC);
