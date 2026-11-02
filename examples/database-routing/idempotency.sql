-- Optional: provision only when using Idempotency-Key with atomic mutations.
-- Apply administratively, outside the public PolicySQL endpoint.
--
-- `created_at` is filled by the database's clock (never written by PolicySQL) and is what
-- administrative cleanup deletes by (ADR 0028). A table created before this column existed
-- keeps working for the library, but no cleanup runs on it until it is rebuilt: SQLite cannot
-- add a CURRENT_TIMESTAMP default to a table that has rows.
-- The table must not be WITHOUT ROWID: the cleanup selects its batch by rowid.
CREATE TABLE policysql_idempotency (
  key_hash TEXT PRIMARY KEY NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX policysql_idempotency_created_at ON policysql_idempotency (created_at);
