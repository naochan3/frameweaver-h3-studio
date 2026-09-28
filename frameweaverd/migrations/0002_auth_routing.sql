CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX oauth_states_expiry_idx ON oauth_states(expires_at);

CREATE TABLE sessions (
  session_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  discord_user_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX sessions_owner_expiry_idx ON sessions(owner_id, expires_at);

ALTER TABLE jobs ADD COLUMN worker_id TEXT;
