-- Provision both databases outside the public PolicySQL endpoint.
CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE policysql_idempotency (key_hash TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL);
