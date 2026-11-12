// #144: an envelope's statements reach the database as one conditional batch, so the statements
// after the first error never run. SQLite closes the transaction by itself on `ON CONFLICT
// ROLLBACK` and `RAISE(ROLLBACK)`; before this, the statements after that error ran in autocommit
// and stayed committed behind a failed request. Everything runs on a real SQLite behind the real
// HTTP transport, on both TransactionOwner adapters and both placements (direct, owner).
import assert from "node:assert/strict";
import test from "node:test";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";

const EXECUTE = "/v1/transactions:execute";
const TABLE = "id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL";
const ABORT_SCHEMA = `CREATE TABLE projects (${TABLE});`;
const CONFLICT_ROLLBACK_SCHEMA = "CREATE TABLE projects (id TEXT PRIMARY KEY ON CONFLICT ROLLBACK NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL);";
const RAISE_ROLLBACK_SCHEMA = `${ABORT_SCHEMA}
CREATE TRIGGER projects_guard BEFORE INSERT ON projects WHEN NEW.name = 'bad' BEGIN SELECT RAISE(ROLLBACK, 'guard'); END;`;

const insert = (id, name = id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name } });
/**
 * Each scenario: its schema and an envelope whose second statement fails and whose third must not run.
 * `open`: the transaction is still open after the error, so the reply keeps its baton and the refusal
 * is a definite 409 constraint violation (ADR 0030). Where SQLite closed the transaction itself
 * (`ROLLBACK`), Turso ends the stream and the refusal is a 500 `POLICYSQL_DATABASE_ERROR`, never a
 * 409: nothing proves the statements ran inside a transaction (#144, #146, #145 pull request E).
 */
const SCENARIOS = {
  "ON CONFLICT ROLLBACK": { schema: CONFLICT_ROLLBACK_SCHEMA, open: false, statements: [insert("first"), insert("seed"), insert("third")] },
  "RAISE(ROLLBACK)": { schema: RAISE_ROLLBACK_SCHEMA, open: false, statements: [insert("first"), insert("middle", "bad"), insert("third")] },
  "the default ABORT": { schema: ABORT_SCHEMA, open: true, statements: [insert("first"), insert("seed"), insert("third")] },
};
const PLACEMENTS = [["direct", false], ["owner", true]];

const logged = (t) => {
  const lines = [];
  t.mock.method(console, "log", (line) => { lines.push(String(line)); });
  return lines;
};
const events = (lines, name) => lines.flatMap((line) => { try { const record = JSON.parse(line); return record.event === name ? [record] : []; } catch { return []; } });
/** Whether any statement the database ran carried the id as its `id` argument. */
const ran = (h, id) => h.events.some((event) => (event.args ?? []).some((arg) => arg.name === "id" && arg.value.value === id));
const databaseIds = (h) => h.databases.get("a").database.prepare("SELECT id FROM projects WHERE tenant_id = 'tenant_a' ORDER BY id").all().map((row) => row.id);
const outcome = (response) => ({
  status: response.status, code: response.body?.error?.code, path: response.body?.error?.path ?? null, detail: response.body?.error?.detail ?? null,
});

for (const ownerAdapter of OWNER_ADAPTERS) {
  const setup = async (t, hooks, schema) => {
    const lines = logged(t);
    const h = await harness(t, { ownerAdapter, hooks, fixture: { schema } });
    return Object.assign(h, { lines });
  };

  for (const [placement, hooks] of PLACEMENTS) {
    for (const [name, { schema, statements, open }] of Object.entries(SCENARIOS)) {
      test(`${ownerAdapter}/${placement}: ${name} - the statements after the first error do not run and leave no row`, async (t) => {
        const h = await setup(t, hooks, schema);
        const response = await h.request("a", EXECUTE, { statements }, null);
        if (open) {
          assert.equal(response.status, 409, JSON.stringify(response.body));
          assert.equal(response.body.error.code, "POLICYSQL_CONSTRAINT_VIOLATION");
          assert.equal(response.body.error.path, "/statements/1");
          assert.deepEqual(response.body.error.detail, { constraint: "unique" });
        } else {
          assert.equal(response.status, 500, JSON.stringify(response.body));
          assert.equal(response.body.error.code, "POLICYSQL_DATABASE_ERROR");
          assert.equal(response.body.error.path, null);
          assert.equal(response.body.error.detail, undefined);
        }
        await h.flush();
        assert.deepEqual(databaseIds(h), ["seed"], "neither the statement before nor the one after the error is kept");
        assert.equal(ran(h, "first"), true, "the statement before the error did reach the database (so `ran` can see arguments)");
        assert.equal(ran(h, "third"), false, "the statement after the error never reached the database");
        assert.deepEqual(events(h.lines, "database_error_unclassified").map((record) => record.code), open ? [] : ["SQLITE_CONSTRAINT"]);
        assert.equal(events(h.lines, "database_constraint_violation").length, open ? 1 : 0);
      });
    }

    // The schemas where SQLite closes the transaction itself are a 500 database error for a keyed
    // envelope and an interactive statement too, and the same on a retry (ADR 0030).
    for (const [name, { schema, statements }] of Object.entries(SCENARIOS).filter(([, scenario]) => !scenario.open)) {
      test(`${ownerAdapter}/${placement}: ${name} - a keyed envelope that fails leaves no idempotency row, and a retry keeps nothing`, async (t) => {
        const h = await setup(t, hooks, schema);
        const key = "stop-after-error-key-1";
        for (const attempt of [1, 2]) {
          const response = await h.request("a", EXECUTE, { statements }, key);
          assert.equal(response.status, 500, `attempt ${attempt}: ${JSON.stringify(response.body)}`);
          assert.equal(response.body.error.code, "POLICYSQL_DATABASE_ERROR");
          await h.flush();
          assert.deepEqual(databaseIds(h), ["seed"], `attempt ${attempt}`);
          assert.equal(h.databases.get("a").database.prepare("SELECT count(*) AS n FROM policysql_idempotency").get().n, 0, `attempt ${attempt}`);
          assert.equal(ran(h, "third"), false, `attempt ${attempt}`);
        }
      });

      test(`${ownerAdapter}/${placement}: ${name} - an interactive statement that fails closes the transaction and commits nothing`, async (t) => {
        const h = await setup(t, hooks, schema);
        const started = await h.request("a", "/v1/transactions", { mode: "write" }, null);
        assert.equal(started.status, 201, JSON.stringify(started.body));
        const base = `/v1/transactions/${started.body.transactionId}`;
        const failing = statements[1];
        const failed = await h.request("a", `${base}/statements`, { sequence: 1, ...failing }, null);
        assert.equal(failed.status, 500, JSON.stringify(failed.body));
        assert.equal(failed.body.error.code, "POLICYSQL_DATABASE_ERROR");
        const next = await h.request("a", `${base}/statements`, { sequence: 2, ...insert("after") }, null);
        assert.equal(next.status, 409, JSON.stringify(next.body));
        assert.equal(next.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
        await h.flush();
        assert.deepEqual(databaseIds(h), ["seed"]);
        assert.equal(ran(h, "after"), false);
      });
    }
  }

  // D1: the two placements answer and end the same. A differential test only: it does not catch the
  // regression by itself (without the condition both placements break in the same way); the
  // scenario tests above do.
  test(`${ownerAdapter}: both placements answer alike and leave the same rows for every scenario`, async (t) => {
    const seen = new Map();
    for (const [placement, hooks] of PLACEMENTS) {
      for (const [name, { schema, statements }] of Object.entries(SCENARIOS)) {
        const h = await setup(t, hooks, schema);
        const response = await h.request("a", EXECUTE, { statements }, null);
        await h.flush();
        const result = JSON.stringify({ ...outcome(response), rows: databaseIds(h) });
        if (seen.has(name)) assert.equal(result, seen.get(name), `${name}: ${placement} differs`);
        else seen.set(name, result);
      }
    }
    assert.equal(seen.size, Object.keys(SCENARIOS).length);
  });
}
