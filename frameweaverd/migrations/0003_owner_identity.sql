CREATE TABLE auth_identity_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  key BLOB NOT NULL
);
