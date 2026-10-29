-- Optional: provision only when using Idempotency-Key with atomic mutations.
-- Apply administratively, outside the public PolicySQL endpoint.
CREATE TABLE policysql_idempotency (key_hash TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL);
