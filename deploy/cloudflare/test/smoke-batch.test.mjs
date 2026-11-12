// The statement-batch release-smoke section (#144) against real SQLite behind the simulated Turso
// server. It is a smoke, not library code, but a wrong expectation here fails a release, so the
// section runs with its expectations checked: it passes with the library's transport, and names a
// failure for a transport that runs the statements after the first error.
import assert from "node:assert/strict";
import test from "node:test";
import { STATEMENT_BATCH_TABLES, statementBatchSmoke } from "../scripts/smoke-batch.mjs";
import { DatabaseStatementError, SqlComplexityError } from "../src/database-complexity.ts";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";

const classify = {
  databaseCode: (error) => (error instanceof DatabaseStatementError ? error.databaseCode : null),
  complexityCause: (error) => (error instanceof SqlComplexityError ? error.complexityCause : null),
};

/**
 * A transport that sends each statement as its own request and carries on after an error, as the
 * pipeline did before #144; it fails with the first error once every statement ran.
 */
const carriesOn = (transport) => ({
  async begin(...args) {
    const transaction = await transport.begin(...args);
    return {
      ...transaction,
      get open() { return transaction.open; },
      async execute(statements, options) {
        const results = [];
        let first;
        for (const statement of statements) {
          try { results.push(...await transaction.execute([statement], options)); } catch (error) { first ??= error; }
        }
        if (first) throw first;
        return results;
      },
      commit: () => transaction.commit(),
      rollback: () => transaction.rollback(),
    };
  },
});

for (const ownerAdapter of OWNER_ADAPTERS) {
  test(`${ownerAdapter}: the section passes with the library's transport and reports each table`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { ownerAdapter });
    h.databases.get("a").database.exec(STATEMENT_BATCH_TABLES.join(";"));
    const transport = h.database.connect(h.binding("a"), "smoke");
    const { failures, report } = await statementBatchSmoke({ transport, ...classify });
    assert.deepEqual(failures, []);
    assert.deepEqual(Object.keys(report.tables).sort(), ["smoke_conflict_abort", "smoke_conflict_rollback", "smoke_raise_rollback"]);
    for (const entry of Object.values(report.tables)) assert.deepEqual({ code: entry.code, rowsAfter: entry.rowsAfter }, { code: "SQLITE_CONSTRAINT", rowsAfter: 0 });
    assert.equal(report.tables.smoke_conflict_abort.rollback, "ok");
    assert.deepEqual(report.complexity, { cause: "columns", expected: "columns" });
    assert.deepEqual(report.success, { results: 2 });
    // Nothing secret or textual in what a release prints.
    assert.equal(JSON.stringify(report).includes("SELECT"), false);
  });

  test(`${ownerAdapter}: a transport that runs the statements after the first error is named as a failure`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { ownerAdapter });
    h.databases.get("a").database.exec(STATEMENT_BATCH_TABLES.join(";"));
    const transport = carriesOn(h.database.connect(h.binding("a"), "smoke"));
    const { failures } = await statementBatchSmoke({ transport, ...classify });
    // Where SQLite closed the transaction itself, the later statements stayed committed. After an
    // ordinary ABORT the transaction is still open and the rollback takes them back, so that table
    // cannot tell the two transports apart.
    for (const table of ["smoke_conflict_rollback", "smoke_raise_rollback"]) {
      assert.ok(failures.includes(`${table}: no statement of the failed envelope left a row`), `${table}: ${JSON.stringify(failures)}`);
    }
    assert.equal(failures.some((failure) => failure.startsWith("smoke_conflict_abort")), false);
    for (const failure of failures) assert.equal(/INSERT|SELECT|UNIQUE/u.test(failure), false, failure);
  });
}
