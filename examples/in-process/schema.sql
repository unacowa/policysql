-- Provision both databases outside the public PolicySQL endpoint.
CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
