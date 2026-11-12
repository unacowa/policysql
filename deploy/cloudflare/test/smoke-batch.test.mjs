// The statement-batch release-smoke section (#144) against real SQLite behind the simulated Turso
// server. It is a smoke, not library code, but a wrong expectation here fails a release, so the
// section runs with its expectations checked: it passes with the library's transport, and names a
// failure for a transport that runs the statements after the first error.
import assert from "node:assert/strict";
import test from "node:test";
import { STATEMENT_BATCH_TABLES, statementBatchSmoke } from "../scripts/smoke-batch.mjs";
import { DatabaseStatementError, SqlComplexityError } from "../src/database-complexity.ts";
import { SqlConstraintError } from "../src/database-constraint.ts";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";

const classify = {
  databaseCode: (error) => (error instanceof DatabaseStatementError || error instanceof SqlConstraintError ? error.databaseCode : null),
  constraint: (error) => (error instanceof SqlConstraintError ? error.constraint : null),
  complexityCause: (error) => (error instanceof SqlComplexityError ? error.complexityCause : null),
  refused: (error) => (error instanceof DatabaseStatementError ? error.code : null),
};

/**
 * A transport whose batches lose their conditions on the way to the server, so the server runs every
 * step as an unconditional pipeline did before #144 (the statements after the first error run).
 */
const withoutConditions = (transport) => {
  const forward = transport.fetchImpl;
  transport.fetchImpl = (url, init) => {
    const body = JSON.parse(init.body);
    for (const request of body.requests) {
      if (request.type === "batch") for (const step of request.batch.steps) delete step.condition;
    }
    return forward(url, { ...init, body: JSON.stringify(body) });
  };
  return transport;
};

/**
 * A transport whose batch replies report a refused step as a failure of the whole request (a
 * top-level `type: "error"` result), which is a 503 and never a database refusal.
 */
const withTopLevelErrors = (transport) => {
  const forward = transport.fetchImpl;
  transport.fetchImpl = async (url, init) => {
    const response = await forward(url, init);
    const body = await response.json();
    for (const [index, entry] of (body.results ?? []).entries()) {
      const stepErrors = entry?.response?.result?.step_errors;
      if (entry?.response?.type === "batch" && Array.isArray(stepErrors) && stepErrors.some((error) => error)) {
        body.results[index] = { type: "error", error: { code: "SQLITE_UNKNOWN", message: "x" } };
      }
    }
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
  };
  return transport;
};

for (const ownerAdapter of OWNER_ADAPTERS) {
  test(`${ownerAdapter}: the section passes with the library's transport and reports each table`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { ownerAdapter });
    h.databases.get("a").database.exec(STATEMENT_BATCH_TABLES.join(";"));
    const transport = h.database.connect(h.binding("a"), "smoke");
    const { failures, report } = await statementBatchSmoke({ transport, ...classify });
    assert.deepEqual(failures, []);
    assert.deepEqual(Object.keys(report.tables).sort(), ["smoke_conflict_abort", "smoke_conflict_rollback", "smoke_raise_rollback"]);
    const expected = { smoke_conflict_abort: "unique", smoke_conflict_rollback: null, smoke_raise_rollback: null };
    for (const [table, entry] of Object.entries(report.tables)) {
      assert.deepEqual({ code: entry.code, rowsAfter: entry.rowsAfter, constraint: entry.constraint }, { code: "SQLITE_CONSTRAINT", rowsAfter: 0, constraint: expected[table] });
    }
    assert.equal(report.tables.smoke_conflict_abort.rollback, "ok");
    assert.deepEqual(report.complexity, { cause: "columns", expected: "columns" });
    assert.deepEqual(report.success, { results: 2 });
    // The refusal of a statement the database cannot run is a database refusal; only codes are reported.
    assert.equal(report.refused.code, "POLICYSQL_DATABASE_ERROR");
    assert.match(report.refused.databaseCode, /^[A-Z0-9_]+$/u);
    // Nothing secret or textual in what a release prints.
    assert.equal(JSON.stringify(report).includes("SELECT"), false);
  });

  test(`${ownerAdapter}: a transport that runs the statements after the first error is named as a failure`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { ownerAdapter });
    h.databases.get("a").database.exec(STATEMENT_BATCH_TABLES.join(";"));
    const transport = withoutConditions(h.database.connect(h.binding("a"), "smoke"));
    const { failures } = await statementBatchSmoke({ transport, ...classify });
    // Where SQLite closed the transaction itself, the later statements stayed committed. After an
    // ordinary ABORT the transaction is still open and the rollback takes them back, so that table
    // is only named for the reply that broke the contract.
    for (const table of ["smoke_conflict_rollback", "smoke_raise_rollback"]) {
      assert.ok(failures.includes(`${table}: no statement of the failed envelope left a row`), `${table}: ${JSON.stringify(failures)}`);
    }
    assert.equal(failures.includes("smoke_conflict_abort: no statement of the failed envelope left a row"), false);
    for (const failure of failures) assert.equal(/INSERT|SELECT|UNIQUE/u.test(failure), false, failure);
  });

  test(`${ownerAdapter}: a refusal reported as a failed request is named, not taken for a database refusal`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { ownerAdapter });
    h.databases.get("a").database.exec(STATEMENT_BATCH_TABLES.join(";"));
    const transport = withTopLevelErrors(h.database.connect(h.binding("a"), "smoke"));
    const { failures, report } = await statementBatchSmoke({ transport, ...classify });
    assert.equal(report.refused.code, null);
    for (const name of [
      "a statement the database cannot run is a database refusal",
      "smoke_conflict_rollback: a refusal in a reply that ended the stream is a database refusal",
    ]) {
      assert.ok(failures.includes(name), `${name}: ${JSON.stringify(failures)}`);
    }
    for (const failure of failures) assert.equal(/INSERT|SELECT|UNIQUE/u.test(failure), false, failure);
  });
}
