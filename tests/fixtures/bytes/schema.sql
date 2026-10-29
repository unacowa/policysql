CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  state BLOB,
  seed BLOB NOT NULL,
  private_state BLOB NOT NULL DEFAULT X'ff',
  forbidden BLOB NOT NULL DEFAULT X'01',
  metadata TEXT NOT NULL DEFAULT '{}'
);
