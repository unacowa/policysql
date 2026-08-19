CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL
) STRICT;
