// The reference wrapper's half of the idempotency cleanup (ADR 0028), which is not published
// library code: the Turso runner, the deployment's own credentials, and the fixed window. The
// procedure itself is tested in idempotency-cleanup.test.mjs over plain `node:sqlite`; here the
// subject is the wiring — that the `scheduled` body uses the deployment's credentials, that a
// missing credential deletes nothing, that the window the wrapper fixes is 30 days, and that the
// batch cap fits the Worker's subrequest limit.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseJsonc } from "../scripts/lib/jsonc.mjs";
import { IDEMPOTENCY_CLEANUP_MAX_BATCHES, IDEMPOTENCY_RETENTION_SECONDS } from "../src/idempotency-cleanup.ts";
import { cleanupFromEnv } from "../wrapper/idempotency-retention.ts";
import { IDEMPOTENCY_TABLE, cleanupRunnerFor, idempotencyKeys as keys, insertIdempotencyRow as insert } from "./helpers/idempotency.mjs";

const CANONICAL = IDEMPOTENCY_TABLE;

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

test("the scheduled handler runs the cleanup with the deployment's own credentials", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(CANONICAL);
  insert(database, "stale", "2000-01-01 00:00:00");
  const events = [];
  const connections = [];
  const result = await cleanupFromEnv(
    { TURSO_DATABASE_URL: "https://db.example.test", TURSO_AUTH_TOKEN: "admin-token" },
    (event) => events.push(event),
    (connection) => { connections.push(connection); return cleanupRunnerFor(database); },
  );
  assert.deepEqual(connections, [{ url: "https://db.example.test", authToken: "admin-token" }]);
  assert.equal(result.outcome, "deleted");
  assert.deepEqual(keys(database), []);
  assert.equal(events[0].event, "idempotency_cleanup");
  assert.equal(events[0].retentionSeconds, IDEMPOTENCY_RETENTION_SECONDS, "the wrapper's own fixed window");
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

test("the documented rebuild keeps every tombstone and gives each row a real created_at", () => {
  // ADR 0028's statements, run as one write transaction against a pre-column table. The failure
  // this guards against is a committed empty table: it would drop every tombstone, so a keyed
  // retry could execute a committed write a second time.
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE policysql_idempotency (key_hash TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL)");
  insert(database, "a");
  insert(database, "b");
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE policysql_idempotency_next (
      key_hash TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL,
      response_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO policysql_idempotency_next (key_hash, fingerprint, response_json)
      SELECT key_hash, fingerprint, response_json FROM policysql_idempotency;
    DROP TABLE policysql_idempotency;
    ALTER TABLE policysql_idempotency_next RENAME TO policysql_idempotency;
    CREATE INDEX policysql_idempotency_created_at ON policysql_idempotency (created_at);
    COMMIT;`);
  assert.deepEqual(keys(database), ["a", "b"]);
  const rows = database.prepare("SELECT created_at FROM policysql_idempotency").all();
  assert.ok(rows.every((row) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(row.created_at)));
  // And the rebuilt table is one the cleanup works on.
  return cleanupFromEnv(
    { TURSO_DATABASE_URL: "https://db.example.test", TURSO_AUTH_TOKEN: "admin-token" },
    () => {},
    () => cleanupRunnerFor(database),
  ).then((result) => assert.equal(result.outcome, "nothing_to_delete"));
});
