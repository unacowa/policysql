CREATE TABLE nullabletexts (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'label',
  state TEXT,
  note TEXT,
  amount REAL,
  count INTEGER,
  flag INTEGER,
  meta TEXT,
  payload BLOB,
  due TEXT,
  secret TEXT,
  owner TEXT
);
