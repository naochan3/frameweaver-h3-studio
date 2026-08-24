ALTER TABLE jobs ADD COLUMN request_key TEXT;
CREATE UNIQUE INDEX jobs_owner_request_key_idx
  ON jobs(owner_id, request_key)
  WHERE request_key IS NOT NULL;
