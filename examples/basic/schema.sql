CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  customer_id TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX projects_tenant_id_idx ON projects (tenant_id);
