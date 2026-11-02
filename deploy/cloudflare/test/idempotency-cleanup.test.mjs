// The idempotency cleanup procedure (ADR 0028), which is published library code, against real
// SQLite: the batch DELETE deletes by age only, a fresh row survives the same run, batches are
// bounded, an absent table and a table without `created_at` are skips (not failures) so a
// deployment that never used keys needs no table, an unrecognized PRAGMA reply is a failure
// rather than a guess, and a database error is reported as a classified failure that never
// throws. The procedure knows no driver: every statement goes through the injected runner, which
// is what lets this file run it over `node:sqlite` without Turso or Cloudflare.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  IDEMPOTENCY_CLEANUP_BATCH_SIZE, IDEMPOTENCY_CLEANUP_MAX_BATCHES, IDEMPOTENCY_CLEANUP_SQL,
  IDEMPOTENCY_RETENTION_SECONDS, cleanupIdempotency,
} from "../src/idempotency-cleanup.ts";
import {
  IDEMPOTENCY_TABLE, cleanupRunnerFor, idempotencyKeys as keys, insertIdempotencyRow as insert,
} from "./helpers/idempotency.mjs";

const CANONICAL = IDEMPOTENCY_TABLE;

const run = (database, overrides = {}) => {
  const events = [];
  const options = {
    retentionSeconds: IDEMPOTENCY_RETENTION_SECONDS, batchSize: IDEMPOTENCY_CLEANUP_BATCH_SIZE,
    maxBatches: IDEMPOTENCY_CLEANUP_MAX_BATCHES, log: (event) => events.push(event), ...overrides,
  };
  return cleanupIdempotency(cleanupRunnerFor(database), options).then((result) => ({ result, events }));
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

test("nothing inside the window is deleted", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(CANONICAL);
  insert(database, "fresh");
  database.prepare("UPDATE policysql_idempotency SET created_at = datetime('now', ?)").run(`-${IDEMPOTENCY_RETENTION_SECONDS - 60} seconds`);
  const { result } = await run(database);
  assert.deepEqual(keys(database), ["fresh"]);
  assert.equal(result.outcome, "nothing_to_delete");
  assert.equal(result.batches, 1);
});

test("the window is the caller's argument: a shorter one deletes the same row", async () => {
  // The procedure takes the window; the reference wrapper is what fixes it at 30 days. This pins
  // the seam: the same row is kept or deleted depending only on the argument.
  const database = new DatabaseSync(":memory:");
  database.exec(CANONICAL);
  insert(database, "recent");
  database.prepare("UPDATE policysql_idempotency SET created_at = datetime('now', ?)").run("-120 seconds");
  const kept = await run(database);
  assert.equal(kept.result.outcome, "nothing_to_delete");
  const deleted = await run(database, { retentionSeconds: 60 });
  assert.equal(deleted.result.outcome, "deleted");
  assert.deepEqual(keys(database), []);
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

test("the reference window is a fixed 30 days and nothing advertises it", () => {
  // ADR 0028: the reference wrapper deletes by this constant, and Capabilities is unchanged, so
  // no client is promised a duration. A change here is a contract decision, not a tuning value.
  // The procedure takes the window as an argument (the seam test above), so another deployment
  // may choose its own without touching the library.
  assert.equal(IDEMPOTENCY_RETENTION_SECONDS, 30 * 24 * 60 * 60);
});

test("the procedure is published; the wrapper's transport, credentials and schedule are not", () => {
  // ADR 0019: the fixed procedure is library code; the Turso runner, the env names and the Cron
  // Trigger are the deployment's. The package manifest decides which, so a later move cannot
  // silently publish the wrapper half or hide the library half.
  const repository = new URL("../../../", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("package.json", repository), "utf8"));
  assert.ok(manifest.files.includes("deploy/cloudflare/src/"), "the engine (and the procedure) is published");
  assert.equal(manifest.files.includes("deploy/cloudflare/wrapper/"), false, "the wrapper is not published");
  assert.ok(manifest.files.includes("deploy/cloudflare/pkg/"), "the WASM runtime is published with it");
  // The published entrypoint re-exports the procedure (a text check: importing package.ts pulls in
  // the WASM module, which this Node test cannot load).
  const entrypoint = readFileSync(new URL("../src/package.ts", import.meta.url), "utf8");
  assert.match(entrypoint, /export \{\n(?:[^}]*,\n)*[^}]*\bcleanupIdempotency\b[^}]*\} from "\.\/idempotency-cleanup\.ts"/u);
  assert.match(entrypoint, /\bCleanupRunner\b/u);
});

test("the wrapper half names no driver the procedure depends on", () => {
  // The split is real only if the procedure never reaches for the transport: no Turso import, no
  // `env`, no Cloudflare type. The platform and env guards (platform-boundary, library-env-guard)
  // scan this file too; this test states the reason.
  const source = readFileSync(new URL("../src/idempotency-cleanup.ts", import.meta.url), "utf8");
  assert.equal(/from "\.\.?\/(?:.*)"|from "[a-z@]/u.test(source.replace(/\/\/[^\n]*/gu, "")), false,
    "the procedure imports nothing");
});
