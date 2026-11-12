// Release-smoke section for the conditional statement batch (#144). Like the sections of
// smoke-sections.mjs it returns `{ failures, report }`; neither contains a token, a SQL text, or a
// database message. Statements are sent to the real Turso database through the library's own
// transport, which sends an envelope as one batch whose steps each depend on the step before: when
// SQLite closes the transaction by itself on an error (`ON CONFLICT ROLLBACK`, `RAISE(ROLLBACK)`),
// no later statement may run in autocommit and stay committed.
import { COMPLEXITY_PROBES } from "./smoke-complexity.mjs";
import { unique } from "./smoke-sections.mjs";

// The read cap this smoke gives the transport, as core gives one with each execute (ADR 0027).
const READ_CAP = 1_048_576;
const LIMIT = { maxBytesPerValue: 262_144 };

/** Development-only tables of the section (not in the catalog); provisioning creates them and empties them on every release. */
export const STATEMENT_BATCH_TABLES = Object.freeze([
  "CREATE TABLE IF NOT EXISTS smoke_conflict_rollback (id TEXT PRIMARY KEY ON CONFLICT ROLLBACK NOT NULL) STRICT",
  "CREATE TABLE IF NOT EXISTS smoke_conflict_abort (id TEXT PRIMARY KEY NOT NULL) STRICT",
  "CREATE TABLE IF NOT EXISTS smoke_raise_rollback (id TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL) STRICT",
  "CREATE TRIGGER IF NOT EXISTS smoke_raise_rollback_guard BEFORE INSERT ON smoke_raise_rollback WHEN NEW.v = 'bad' BEGIN SELECT RAISE(ROLLBACK, 'smoke guard'); END",
  "DELETE FROM smoke_conflict_rollback",
  "DELETE FROM smoke_conflict_abort",
  "DELETE FROM smoke_raise_rollback",
]);

// The three ways a statement fails inside a write transaction. `seeded`: a row committed first
// that the second statement then duplicates; otherwise the second statement trips the trigger.
const FAILURES = Object.freeze([
  { table: "smoke_conflict_rollback", seeded: true, closesTransaction: true },
  { table: "smoke_conflict_abort", seeded: true, closesTransaction: false },
  { table: "smoke_raise_rollback", seeded: false, closesTransaction: true },
]);

/**
 * `transport` is a `TursoHttpTransport` to the real database. `databaseCode` and `complexityCause`
 * read the library's `DatabaseStatementError.databaseCode` and `SqlComplexityError.complexityCause`
 * from a failure (null when it is neither), so the smoke imports nothing from `src/`.
 */
export const statementBatchSmoke = async ({ transport, databaseCode, complexityCause }) => {
  const failures = [];
  const expect = (condition, name) => { if (!condition) failures.push(name); };
  const report = { tables: {}, complexity: null, success: null };

  // A step that cannot begin is a failed probe, not an exception that aborts the section.
  const attempt = async (mode, work) => {
    let connection;
    try { connection = await transport.begin(mode, 10_000, undefined, LIMIT); } catch (error) { return { error }; }
    let outcome;
    try { outcome = { value: await work(connection) }; } catch (error) { outcome = { error }; }
    let rollback = "ok";
    try { await connection.rollback(); } catch { rollback = "failed"; }
    return { ...outcome, rollback };
  };
  const commit = async (table, id, v = "ok") => {
    let connection;
    try { connection = await transport.begin("write", 10_000, undefined, LIMIT); } catch { return false; }
    try {
      await connection.execute([insert(table, id, v)], { maxResponseBytes: READ_CAP });
      await connection.commit();
      return true;
    } catch {
      try { await connection.rollback(); } catch { /* nothing more to do */ }
      return false;
    }
  };
  const insert = (table, id, v) => (table === "smoke_raise_rollback"
    ? { sql: `INSERT INTO ${table} (id, v) VALUES (:id, :v)`, args: { id, v } }
    : { sql: `INSERT INTO ${table} (id) VALUES (:id)`, args: { id } });
  const countRows = async (table, ids) => {
    const read = await attempt("read", async (connection) => {
      const [result] = await connection.execute([{
        sql: `SELECT id FROM ${table} WHERE id IN (${ids.map((_id, index) => `:i${index}`).join(", ")})`,
        args: Object.fromEntries(ids.map((id, index) => [`i${index}`, id])),
      }], { maxResponseBytes: READ_CAP });
      return result.rows.length;
    });
    return read.error ? null : read.value;
  };

  for (const { table, seeded, closesTransaction } of FAILURES) {
    const base = unique(table);
    const [first, second, third] = [`${base}_a`, `${base}_dup`, `${base}_b`];
    const entry = { code: null, rowsAfter: null, rollback: null };
    report.tables[table] = entry;
    if (seeded) expect(await commit(table, second), `${table}: the row to duplicate was committed`);
    const run = await attempt("write", (connection) => connection.execute([
      insert(table, first, "ok"),
      insert(table, second, seeded ? "ok" : "bad"),
      insert(table, third, "ok"),
    ], { maxResponseBytes: READ_CAP }));
    entry.rollback = run.rollback ?? null;
    entry.code = run.error ? databaseCode(run.error) : null;
    expect(run.error !== undefined && entry.code === "SQLITE_CONSTRAINT", `${table}: the envelope is refused as a constraint failure`);
    // The ROLLBACK that follows may fail where SQLite closed the transaction itself; that is expected.
    if (!closesTransaction) expect(entry.rollback === "ok", `${table}: the rollback succeeded`);
    entry.rowsAfter = await countRows(table, [first, third]);
    expect(entry.rowsAfter === 0, `${table}: no statement of the failed envelope left a row`);
  }

  // The conditions are honoured by the server, and the reply keeps its shape: a refusal in the
  // middle is classified, which the transport does only for a reply that shows nothing ran after it.
  const complexity = await attempt("read", (connection) => connection.execute([
    { sql: "SELECT 1" },
    { sql: COMPLEXITY_PROBES["too many columns in "] },
    { sql: "SELECT 2" },
  ], { maxResponseBytes: READ_CAP }));
  const cause = complexity.error ? complexityCause(complexity.error) : null;
  report.complexity = { cause: cause ?? (complexity.error ? "unmatched" : "accepted"), expected: "columns" };
  expect(cause === "columns", "a refusal in the middle of a batch is classified by its own step");

  const ok = await attempt("read", (connection) => connection.execute([
    { sql: "SELECT 1 AS a" },
    { sql: "SELECT 2 AS b" },
  ], { maxResponseBytes: READ_CAP }));
  const rows = ok.error ? null : ok.value.map((result) => result.rows);
  report.success = { results: rows === null ? null : rows.length };
  expect(rows !== null && rows.length === 2 && rows[0][0][0] === 1 && rows[1][0][0] === 2,
    "a batch of two statements returns both results in order");
  expect(ok.rollback === "ok" && complexity.rollback === "ok", "the read transactions rolled back");

  return { failures, report };
};
