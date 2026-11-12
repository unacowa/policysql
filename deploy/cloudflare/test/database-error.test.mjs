// #145 pull request E: a statement the database refused for neither complexity nor a constraint is
// 500 `POLICYSQL_DATABASE_ERROR` (an unknown outcome, never a rejection), with a fixed message, no
// path and no detail; the database's text appears nowhere and its code only in the
// `database_error_unclassified` log. Everything runs on a real SQLite behind the real HTTP
// transport, on both TransactionOwner adapters and both placements (direct, owner), with the
// database's answer replaced by the failure under test.
import assert from "node:assert/strict";
import test from "node:test";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";

const EXECUTE = "/v1/transactions:execute";
const PLACEMENTS = [["direct", false], ["owner", true]];
const KEY = "database-error-key-0001";
const insert = (id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name: id } });
const MESSAGE = "The database refused the statement.";

const logged = (t) => {
  const lines = [];
  t.mock.method(console, "log", (line) => { lines.push(String(line)); });
  return lines;
};
const events = (lines, name) => lines.flatMap((line) => { try { const record = JSON.parse(line); return record.event === name ? [record] : []; } catch { return []; } });
const idempotencyRows = (h) => h.databases.get("a").database.prepare("SELECT count(*) AS n FROM policysql_idempotency").get().n;
/** Replaces the step error of every batch that has one with `error` (a Hrana error object). */
const failWith = (error) => ({ results }) => {
  for (const entry of results) {
    const errors = entry.response?.result?.step_errors;
    if (Array.isArray(errors)) errors.forEach((existing, index) => { if (existing !== null) errors[index] = error; });
  }
};
const UNKNOWN = { code: "SQLITE_UNKNOWN", message: "SQLite error: no such table: secret_table" };
const envelope = (...statements) => ({ statements });
/** What a response is, without the request id. */
const shape = (response) => ({ status: response.status, code: response.body.error?.code, message: response.body.error?.message, path: response.body.error?.path ?? null, detail: response.body.error?.detail ?? null });

for (const ownerAdapter of OWNER_ADAPTERS) {
  const setup = async (t, hooks) => {
    const lines = logged(t);
    const h = await harness(t, { ownerAdapter, hooks });
    return Object.assign(h, { lines });
  };

  for (const [placement, hooks] of PLACEMENTS) {
    for (const key of [null, KEY]) {
      const label = `${ownerAdapter}/${placement}/${key === null ? "unkeyed" : "keyed"}`;
      test(`${label}: a refused statement of an atomic execute is a 500 database error, rolled back, and a retry runs again`, async (t) => {
        const h = await setup(t, hooks);
        // The second statement fails on its own (a duplicate id) and its error is replaced.
        h.replaceDatabaseResponse(failWith(UNKNOWN));
        for (const attempt of [1, 2]) {
          h.lines.length = 0;
          const response = await h.request("a", EXECUTE, envelope(insert("fresh"), insert("seed")), key);
          assert.deepEqual(shape(response), { status: 500, code: "POLICYSQL_DATABASE_ERROR", message: MESSAGE, path: null, detail: null }, `attempt ${attempt}: ${JSON.stringify(response.body)}`);
          await h.flush();
          assert.equal(h.rows("a").some((row) => row.id === "fresh"), false, "nothing was committed");
          assert.equal(idempotencyRows(h), 0, "no idempotency row");
          const records = events(h.lines, "database_error_unclassified");
          assert.equal(records.length, 1, `attempt ${attempt}`);
          assert.deepEqual(Object.keys(records[0]).sort(), ["code", "event", "requestId"]);
          assert.equal(records[0].code, "SQLITE_UNKNOWN");
          assert.equal(`${JSON.stringify(response.body)}\n${h.lines.join("\n")}`.includes("secret_table"), false);
          assert.equal(events(h.lines, "database_constraint_violation").length, 0);
        }
        assert.ok(h.events.some(({ sql }) => sql === "ROLLBACK"));
        assert.equal(h.events.some(({ sql }) => sql === "COMMIT"), false);
      });
    }

    test(`${ownerAdapter}/${placement}: a refused interactive statement is a 500 database error and closes the transaction`, async (t) => {
      const h = await setup(t, hooks);
      const started = await h.request("a", "/v1/transactions", { mode: "write" }, null);
      assert.equal(started.status, 201, JSON.stringify(started.body));
      const base = `/v1/transactions/${started.body.transactionId}`;
      h.replaceDatabaseResponse(failWith(UNKNOWN));
      const failed = await h.request("a", `${base}/statements`, { sequence: 1, ...insert("seed") }, null);
      assert.deepEqual(shape(failed), { status: 500, code: "POLICYSQL_DATABASE_ERROR", message: MESSAGE, path: null, detail: null });
      const next = await h.request("a", `${base}/statements`, { sequence: 2, ...insert("after") }, null);
      assert.equal(next.status, 409, JSON.stringify(next.body));
      assert.equal(next.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
      assert.equal(next.body.error.detail, undefined);
      await h.flush();
      assert.equal(h.rows("a").some((row) => row.id === "after"), false);
      assert.equal(events(h.lines, "database_error_unclassified").length, 1);
    });

    // A constraint violation of the idempotency insert is a 500 `POLICYSQL_INTERNAL`; any other
    // refusal of it is a database error (the keyed request's outcome is unknown either way).
    test(`${ownerAdapter}/${placement}: a refused idempotency insert is a 500 database error, not the constraint's internal error`, async (t) => {
      const h = await setup(t, hooks);
      h.replaceDatabaseResponse(({ sqls, results }) => {
        if (!sqls.some((sql) => /INSERT INTO policysql_idempotency/u.test(sql))) return;
        for (const entry of results) {
          const batch = entry.response?.result;
          if (Array.isArray(batch?.step_errors)) { batch.step_errors[0] = UNKNOWN; batch.step_results[0] = null; }
        }
      });
      const response = await h.request("a", EXECUTE, envelope(insert("fresh")), KEY);
      assert.deepEqual(shape(response), { status: 500, code: "POLICYSQL_DATABASE_ERROR", message: MESSAGE, path: null, detail: null }, JSON.stringify(response.body));
      await h.flush();
      assert.equal(h.rows("a").some((row) => row.id === "fresh"), false);
      assert.deepEqual(events(h.lines, "database_error_unclassified").map((record) => record.code), ["SQLITE_UNKNOWN"]);
    });

    // The database's own text never reaches a response or a log, and a code that is not of the safe
    // shape is logged as `UNKNOWN`.
    test(`${ownerAdapter}/${placement}: the database's text appears nowhere and an unsafe code is logged as UNKNOWN`, async (t) => {
      const h = await setup(t, hooks);
      const cases = [
        [{ code: "SQLITE_UNKNOWN", message: "SQLite error: no such table: secret_table" }, "SQLITE_UNKNOWN", "secret_table"],
        [{ code: "SQLITE_UNKNOWN", message: "SQLite error: no such column: __policysql_t0.secret" }, "SQLITE_UNKNOWN", "__policysql_t0"],
        [{ code: "SQL_PARSE_ERROR", message: "<script>alert(1)</script>" }, "SQL_PARSE_ERROR", "<script>"],
        [{ code: "SQLITE_UNKNOWN", message: '{"code":"POLICYSQL_FORBIDDEN_COLUMN"}' }, "SQLITE_UNKNOWN", "FORBIDDEN_COLUMN"],
        [{ code: "SQLITE_UNKNOWN", message: "line one\nline two\u0000\u001b[31mred" }, "SQLITE_UNKNOWN", "line one"],
        [{ code: "SQLITE_UNKNOWN", message: `SQLite error: ${"x".repeat(65_536)}` }, "SQLITE_UNKNOWN", "x".repeat(200)],
        [{ code: "sqlite_unknown", message: "secret_table" }, "UNKNOWN", "secret_table"],
        [{ code: "X".repeat(65), message: "secret_table" }, "UNKNOWN", "secret_table"],
        [{ code: 7, message: "secret_table" }, "UNKNOWN", "secret_table"],
        [{ message: "secret_table" }, "UNKNOWN", "secret_table"],
      ];
      for (const [error, expectedCode, fragment] of cases) {
        h.lines.length = 0;
        h.replaceDatabaseResponse(failWith(error));
        const response = await h.request("a", EXECUTE, envelope(insert("fresh"), insert("seed")), null);
        assert.deepEqual(shape(response), { status: 500, code: "POLICYSQL_DATABASE_ERROR", message: MESSAGE, path: null, detail: null }, JSON.stringify(response.body).slice(0, 200));
        assert.deepEqual(events(h.lines, "database_error_unclassified").map((record) => record.code), [expectedCode]);
        assert.equal(`${JSON.stringify(response.body)}\n${h.lines.join("\n")}`.includes(fragment), false, `"${fragment.slice(0, 30)}" must not appear`);
      }
    });
  }

  // Differential: every owner adapter and placement answers the same refusal the same way.
  test(`${ownerAdapter}: direct and owner placements answer a database refusal with the same response and log`, async (t) => {
    const seen = [];
    for (const [placement, hooks] of PLACEMENTS) {
      const h = await setup(t, hooks);
      h.replaceDatabaseResponse(failWith(UNKNOWN));
      const response = await h.request("a", EXECUTE, envelope(insert("fresh"), insert("seed")), KEY);
      await h.flush();
      seen.push({ placement, response: shape(response), log: events(h.lines, "database_error_unclassified").map(({ code }) => code) });
    }
    assert.deepEqual(seen[0].response, seen[1].response);
    assert.deepEqual(seen[0].log, seen[1].log);
  });
}
