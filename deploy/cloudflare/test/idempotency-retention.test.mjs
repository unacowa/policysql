// The idempotency cleanup (ADR 0028) against real SQLite: the batch DELETE deletes by age only,
// a fresh row survives the same run, batches are bounded, an absent table and a table without
// `created_at` are skips (not failures) so a deployment that never used keys needs no table, an
// unrecognized PRAGMA reply is a failure rather than a guess, and a database error is reported
// as a classified failure that never throws. The scheduled handler's wiring is here too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseJsonc } from "../scripts/lib/jsonc.mjs";
import {
  IDEMPOTENCY_CLEANUP_BATCH_SIZE, IDEMPOTENCY_CLEANUP_MAX_BATCHES, IDEMPOTENCY_CLEANUP_SQL,
  IDEMPOTENCY_RETENTION_SECONDS, cleanupFromEnv, cleanupIdempotency,
} from "../wrapper/idempotency-retention.ts";

const CANONICAL = `
  CREATE TABLE policysql_idempotency (
    key_hash TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL,
    response_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX policysql_idempotency_created_at ON policysql_idempotency (created_at);`;

/**
 * The wrapper's runner, over a synchronous SQLite the test can inspect directly. A `PRAGMA` and a
 * `SELECT` are read; the `DELETE` is a write and reports its affected rows. (Calling `all()` on a
 * DELETE would run it once and report nothing, which is why the two are separated here too.)
 */
const runnerFor = (database) => async (sql, args) => {
  const statement = database.prepare(sql);
  if (/^\s*(?:SELECT|PRAGMA)\b/iu.test(sql)) {
    const rows = statement.all(args);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { columns, rows: rows.map((row) => columns.map((name) => row[name])), rowsAffected: 0 };
  }
  const result = statement.run(args);
  return { columns: [], rows: [], rowsAffected: Number(result.changes ?? 0) };
};

const insert = (database, key, createdAt = null) => createdAt === null
  ? database.prepare("INSERT INTO policysql_idempotency (key_hash, fingerprint, response_json) VALUES (?, 'f', '{}')").run(key)
  : database.prepare("INSERT INTO policysql_idempotency (key_hash, fingerprint, response_json, created_at) VALUES (?, 'f', '{}', ?)").run(key, createdAt);

const keys = (database) => database.prepare("SELECT key_hash FROM policysql_idempotency ORDER BY key_hash").all().map((row) => row.key_hash);

const run = (database, overrides = {}) => {
  const events = [];
  const options = {
    retentionSeconds: IDEMPOTENCY_RETENTION_SECONDS, batchSize: IDEMPOTENCY_CLEANUP_BATCH_SIZE,
    maxBatches: IDEMPOTENCY_CLEANUP_MAX_BATCHES, log: (event) => events.push(event), ...overrides,
  };
  return cleanupIdempotency(runnerFor(database), options).then((result) => ({ result, events }));
};

test("deletes by age only, in one run: a stale row goes and a fresh row stays", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(CANONICAL);
  insert(database, "stale", "2000-01-01 00:00:00");
  insert(database, "fresh");
  const { result, events } = await run(database);
  assert.deepEqual(keys(database), ["fresh"]);
  assert.equal(result.outcome, "deleted");
  assert.equal(result.deleted, 1);
  assert.equal(result.batches, 1);
  assert.deepEqual(events.map(({ event, outcome, deleted }) => ({ event, outcome, deleted })),
    [{ event: "idempotency_cleanup", outcome: "deleted", deleted: 1 }]);
});

test("the window is the wrapper's constant and nothing inside it is deleted", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(CANONICAL);
  insert(database, "fresh");
  database.prepare("UPDATE policysql_idempotency SET created_at = datetime('now', ?)").run(`-${IDEMPOTENCY_RETENTION_SECONDS - 60} seconds`);
  const { result } = await run(database);
  assert.deepEqual(keys(database), ["fresh"]);
  assert.equal(result.outcome, "nothing_to_delete");
  assert.equal(result.batches, 1);
});

test("a backlog is deleted in bounded batches, and the batch size caps one DELETE", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(CANONICAL);
  for (let index = 0; index < 7; index += 1) insert(database, `stale_${index}`, "2000-01-01 00:00:00");
  const { result } = await run(database, { batchSize: 3 });
  // 3 + 3 + 1: the last batch is short, so the run ends rather than looping.
  assert.equal(result.deleted, 7);
  assert.equal(result.batches, 3);
  assert.deepEqual(keys(database), []);
});

test("a backlog larger than the run's budget stops at the cap and the next run continues", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(CANONICAL);
  for (let index = 0; index < 5; index += 1) insert(database, `stale_${index}`, "2000-01-01 00:00:00");
  const first = await run(database, { batchSize: 2, maxBatches: 2 });
  assert.equal(first.result.deleted, 4);
  assert.equal(first.result.reason, "batch_budget_exhausted");
  assert.equal(keys(database).length, 1);
  const second = await run(database, { batchSize: 2, maxBatches: 2 });
  assert.equal(second.result.outcome, "deleted");
  assert.deepEqual(keys(database), []);
});

test("a missing table is a skip, not a failure: a deployment without keys needs no table", async () => {
  const database = new DatabaseSync(":memory:");
  const { result, events } = await run(database);
  assert.equal(result.outcome, "skipped");
  assert.equal(result.reason, "no_table");
  assert.equal(events[0].reason, "no_table");
});

test("a table without created_at is skipped and nothing is deleted from it", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE policysql_idempotency (key_hash TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL)");
  insert(database, "legacy");
  const { result } = await run(database);
  assert.equal(result.outcome, "skipped");
  assert.equal(result.reason, "no_created_at");
  assert.deepEqual(keys(database), ["legacy"]);
});

test("a WITHOUT ROWID table fails a batch DELETE, is reported as failed, and its rows stay", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE policysql_idempotency (key_hash TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) WITHOUT ROWID`);
  insert(database, "stale", "2000-01-01 00:00:00");
  const { result } = await run(database);
  assert.equal(result.outcome, "failed");
  assert.equal(result.reason, "database_error");
  assert.deepEqual(keys(database), ["stale"]);
});

test("an unreadable PRAGMA reply is a failure, never a guess about what to delete", async () => {
  const events = [];
  const runner = async () => ({ columns: ["cid", "type"], rows: [[0, "TEXT"]], rowsAffected: 0 });
  const result = await cleanupIdempotency(runner, {
    retentionSeconds: IDEMPOTENCY_RETENTION_SECONDS, batchSize: 10, maxBatches: 1, log: (event) => events.push(event),
  });
  assert.equal(result.outcome, "failed");
  assert.equal(result.reason, "unreadable_columns");
});

test("a cleanup never throws: a database error is a classified failure", async () => {
  const events = [];
  const runner = async () => { throw new Error("no such table: policysql_idempotency"); };
  const result = await cleanupIdempotency(runner, {
    retentionSeconds: IDEMPOTENCY_RETENTION_SECONDS, batchSize: 10, maxBatches: 1, log: (event) => events.push(event),
  });
  assert.equal(result.outcome, "failed");
  assert.equal(result.reason, "database_error");
  // The log line carries counts and a classification, never the error text (it can name tables).
  assert.equal(events.length, 1);
  assert.equal(JSON.stringify(events).includes("no such table"), false);
});

test("the cleanup statement is ADR 0028's: age-only, rowid batch, parameterized", () => {
  assert.match(IDEMPOTENCY_CLEANUP_SQL, /^DELETE FROM policysql_idempotency WHERE rowid IN \(SELECT rowid FROM policysql_idempotency WHERE created_at < datetime\('now', '-' \|\| :retention_seconds \|\| ' seconds'\) LIMIT :batch_size\)$/u);
});

test("the batch cap fits the Worker's subrequest limit: three per batch plus the PRAGMA's three", () => {
  const config = parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const subrequests = config.limits?.subrequests;
  assert.ok(Number.isInteger(subrequests), "wrangler.jsonc limits.subrequests is an integer");
  // Each statement the runner sends is its own transaction: BEGIN, the statement, COMMIT (or
  // ROLLBACK for the read), so three subrequests per batch and three for the PRAGMA before the
  // loop. The whole run must fit in one invocation.
  const worst = 3 * (IDEMPOTENCY_CLEANUP_MAX_BATCHES + 1);
  assert.ok(worst <= subrequests, `one run sends at most ${worst} subrequests, limit ${subrequests}`);
});

test("the hourly window is a fixed 30 days and nothing advertises it", () => {
  // ADR 0028: the wrapper deletes by a constant, and Capabilities is unchanged, so no client is
  // promised a duration. A change here is a contract decision, not a tuning value.
  assert.equal(IDEMPOTENCY_RETENTION_SECONDS, 30 * 24 * 60 * 60);
});

test("the scheduled handler runs the cleanup with the deployment's own credentials", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(CANONICAL);
  insert(database, "stale", "2000-01-01 00:00:00");
  const events = [];
  const connections = [];
  const result = await cleanupFromEnv(
    { TURSO_DATABASE_URL: "https://db.example.test", TURSO_AUTH_TOKEN: "admin-token" },
    (event) => events.push(event),
    (connection) => { connections.push(connection); return runnerFor(database); },
  );
  assert.deepEqual(connections, [{ url: "https://db.example.test", authToken: "admin-token" }]);
  assert.equal(result.outcome, "deleted");
  assert.deepEqual(keys(database), []);
  assert.equal(events[0].event, "idempotency_cleanup");
});

test("a deployment without credentials deletes nothing and reports not_configured", async () => {
  const events = [];
  let created = false;
  for (const env of [{}, { TURSO_DATABASE_URL: "https://db.example.test" }, { TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: "" }]) {
    const result = await cleanupFromEnv(env, (event) => events.push(event), () => { created = true; throw new Error("must not run"); });
    assert.equal(result.outcome, "not_configured");
    assert.equal(result.deleted, 0);
  }
  assert.equal(created, false, "no runner is built without both credentials");
  assert.ok(events.every((event) => event.event === "idempotency_cleanup" && event.outcome === "not_configured"));
});
