// The retention release-smoke section (ADR 0028) against real SQLite, driven through an injected
// runner. It is a smoke, not library code, but a wiring mistake here fails a release (it did:
// the runner wanted `authToken` and the smoke passed `token`), and these tests are the only
// place the section runs with its expectations checked rather than printed.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { idempotencyRetentionSmoke } from "../scripts/smoke-retention.mjs";

const CANONICAL = `
  CREATE TABLE policysql_idempotency (
    key_hash TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL,
    response_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX policysql_idempotency_created_at ON policysql_idempotency (created_at);`;

const runnerFor = (database) => async (sql, args) => {
  const statement = database.prepare(sql);
  if (/^\s*(?:SELECT|PRAGMA)\b/iu.test(sql)) {
    const rows = statement.all(args);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { columns, rows: rows.map((row) => columns.map((name) => row[name])), rowsAffected: 0 };
  }
  return { columns: [], rows: [], rowsAffected: Number(statement.run(args).changes ?? 0) };
};

const SCHEDULE = { schedules: [{ cron: "17 * * * *" }] };
const base = (database, overrides = {}) => ({
  connection: { url: "https://db.example.test", token: "admin-token" },
  retentionSeconds: 30 * 24 * 60 * 60,
  batchSize: 500,
  schedule: Promise.resolve(SCHEDULE),
  create: (connection) => {
    // The smoke must hand the runner the library's own shape, not its `{ url, token }` one.
    assert.deepEqual(connection, { url: "https://db.example.test", authToken: "admin-token" });
    return runnerFor(database);
  },
  ...overrides,
});

test("a canonical table passes: a stale probe row goes, the fresh one stays, the trigger is listed", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(CANONICAL);
  const { failures, report } = await idempotencyRetentionSmoke(base(database));
  assert.deepEqual(failures, []);
  assert.equal(report.columns.includes("created_at"), true);
  assert.equal(report.withoutRowid, false);
  assert.equal(report.cleanup.outcome, "deleted");
  assert.equal(report.oldRows, 0);
  assert.equal(report.freshRows, 1);
  assert.deepEqual(report.crons, ["17 * * * *"]);
  // The probe rows are cleaned up: the section leaves no trace in the real table.
  assert.equal(database.prepare("SELECT count(*) AS n FROM policysql_idempotency").get().n, 0);
});

test("a missing trigger fails the section", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(CANONICAL);
  for (const schedule of [Promise.resolve({ schedules: [] }), Promise.resolve(undefined)]) {
    const { failures } = await idempotencyRetentionSmoke(base(database, { schedule }));
    assert.deepEqual(failures, ["the deployed Worker has a Cron Trigger"]);
  }
});

test("a table without created_at fails the section rather than passing quietly", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE policysql_idempotency (key_hash TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL)");
  const { failures, report } = await idempotencyRetentionSmoke(base(database));
  // The shape check names the problem once; the probe does not run on it, so no insert fails.
  assert.deepEqual(failures, ["the idempotency table has created_at"]);
  assert.equal(report.cleanup, undefined);
});

test("a WITHOUT ROWID table fails the section: the batch DELETE cannot run on it", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE policysql_idempotency (key_hash TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) WITHOUT ROWID");
  const { failures } = await idempotencyRetentionSmoke(base(database));
  assert.deepEqual(failures, ["the idempotency table is not WITHOUT ROWID"]);
});

test("an unusable connection is a failed section, never an exception out of the smoke", async () => {
  const { failures, report } = await idempotencyRetentionSmoke({
    connection: { url: "not a url", token: "admin-token" },
    retentionSeconds: 30 * 24 * 60 * 60,
    batchSize: 500,
    schedule: Promise.resolve(SCHEDULE),
    create: () => { throw new Error("POLICYSQL_DATABASE_UNAVAILABLE"); },
  });
  assert.deepEqual(failures, ["the retention probe ran to completion"]);
  assert.equal(report.error, "Error", "the classification, never the message");
});
