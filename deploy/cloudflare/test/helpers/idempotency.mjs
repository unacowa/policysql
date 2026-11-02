// The runner shape the idempotency cleanup takes (`CleanupRunner`, src/idempotency-cleanup.ts),
// implemented over a synchronous SQLite the test can inspect directly. A `PRAGMA` and a `SELECT`
// are reads; the `DELETE` is a write and reports its affected rows. (Calling `all()` on a DELETE
// would run it once and report nothing, which is why the two are separated here too.)
export const cleanupRunnerFor = (database) => async (sql, args) => {
  const statement = database.prepare(sql);
  if (/^\s*(?:SELECT|PRAGMA)\b/iu.test(sql)) {
    const rows = statement.all(args);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { columns, rows: rows.map((row) => columns.map((name) => row[name])), rowsAffected: 0 };
  }
  const result = statement.run(args);
  return { columns: [], rows: [], rowsAffected: Number(result.changes ?? 0) };
};

// The canonical table (ADR 0028), so every test starts from the shape the wrapper provisions.
export const IDEMPOTENCY_TABLE = `
  CREATE TABLE policysql_idempotency (
    key_hash TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL,
    response_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX policysql_idempotency_created_at ON policysql_idempotency (created_at);`;

// A row with an explicit `created_at`, or one the database fills, as core's INSERT does.
export const insertIdempotencyRow = (database, key, createdAt = null) => createdAt === null
  ? database.prepare("INSERT INTO policysql_idempotency (key_hash, fingerprint, response_json) VALUES (?, 'f', '{}')").run(key)
  : database.prepare("INSERT INTO policysql_idempotency (key_hash, fingerprint, response_json, created_at) VALUES (?, 'f', '{}', ?)").run(key, createdAt);

export const idempotencyKeys = (database) =>
  database.prepare("SELECT key_hash FROM policysql_idempotency ORDER BY key_hash").all().map((row) => row.key_hash);
