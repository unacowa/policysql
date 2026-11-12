// Release-smoke section for database constraint violations (#145, ADR 0030). Like the sections
// of smoke-sections.mjs it returns `{ failures, report }`; neither contains a token, a SQL text,
// or a database message. Each probe sends a statement the real Turso database refuses for one
// kind of constraint, through the library's own transport, after a statement that succeeds. The
// transport classifies the refusal only because the reply kept its baton (the transaction is
// still open), so a probe that stops being classified shows that Turso changed how it answers.
import { unique } from "./smoke-sections.mjs";

// The read cap this smoke gives the transport, as core gives one with each execute (ADR 0027).
const READ_CAP = 1_048_576;
const LIMIT = { maxBytesPerValue: 262_144 };

/** Development-only tables of the section (not in the catalog); provisioning creates them and empties them on every release. */
export const CONSTRAINT_TABLES = Object.freeze([
  "CREATE TABLE IF NOT EXISTS smoke_constraint_parent (id TEXT PRIMARY KEY NOT NULL, code TEXT NOT NULL UNIQUE, v TEXT NOT NULL, CONSTRAINT smoke_constraint_v CHECK (v <> 'bad')) STRICT",
  "CREATE TABLE IF NOT EXISTS smoke_constraint_child (id TEXT PRIMARY KEY NOT NULL, parent_id TEXT NOT NULL REFERENCES smoke_constraint_parent (id)) STRICT",
  "CREATE TABLE IF NOT EXISTS smoke_constraint_deferred (id TEXT PRIMARY KEY NOT NULL, parent_id TEXT NOT NULL REFERENCES smoke_constraint_parent (id) DEFERRABLE INITIALLY DEFERRED) STRICT",
  "CREATE TRIGGER IF NOT EXISTS smoke_constraint_guard BEFORE INSERT ON smoke_constraint_parent WHEN NEW.v = 'raise' BEGIN SELECT RAISE(ABORT, 'smoke guard'); END",
  "DELETE FROM smoke_constraint_deferred",
  "DELETE FROM smoke_constraint_child",
  "DELETE FROM smoke_constraint_parent",
]);

const PARENT = "smoke_constraint_parent";
const insertParent = (id, code, v = "ok") => ({
  sql: `INSERT INTO ${PARENT} (id, code, v) VALUES (:id, :code, :v)`, args: { id, code, v },
});

/**
 * One probe per kind of refusal. `seed` commits the rows the violating statement collides with
 * (`ids` are unique per run); `violate` is that statement; `expected` is the kind the transport
 * must name. The section fails unless the probes cover every `smokeVerified` prefix of
 * `CONSTRAINT_PREFIXES` and every kind.
 */
export const CONSTRAINT_PROBES = Object.freeze([
  { name: "unique", expected: "unique",
    seed: (ids) => [insertParent(ids.p, ids.c)],
    violate: (ids) => insertParent(ids.b, ids.c) },
  { name: "primary_key", expected: "unique",
    seed: (ids) => [insertParent(ids.p, ids.c)],
    violate: (ids) => insertParent(ids.p, ids.c2) },
  { name: "not_null", expected: "not_null",
    seed: () => [],
    violate: (ids) => ({ sql: `INSERT INTO ${PARENT} (id, code) VALUES (:id, :code)`, args: { id: ids.b, code: ids.c } }) },
  { name: "check", expected: "check",
    seed: () => [],
    violate: (ids) => insertParent(ids.b, ids.c, "bad") },
  { name: "foreign_key_insert", expected: "foreign_key",
    seed: () => [],
    violate: (ids) => ({ sql: "INSERT INTO smoke_constraint_child (id, parent_id) VALUES (:id, :parent)", args: { id: ids.k, parent: ids.missing } }) },
  { name: "foreign_key_delete", expected: "foreign_key",
    seed: (ids) => [insertParent(ids.p, ids.c), { sql: "INSERT INTO smoke_constraint_child (id, parent_id) VALUES (:id, :parent)", args: { id: ids.k, parent: ids.p } }],
    violate: (ids) => ({ sql: `DELETE FROM ${PARENT} WHERE id = :id`, args: { id: ids.p } }) },
  { name: "trigger_abort", expected: "other",
    seed: () => [],
    violate: (ids) => insertParent(ids.b, ids.c, "raise") },
]);

/**
 * `transport` is a `TursoHttpTransport` to the real database. `classify` reads the library's
 * `SqlConstraintError` from a failure as `{ constraint, statement }` (null when it is anything
 * else), and `isCommitNotSent` reads `CommitNotSentError`, so the smoke imports nothing from `src/`.
 */
export const constraintSmoke = async ({ transport, classify, isCommitNotSent }) => {
  const failures = [];
  const expect = (condition, name) => { if (!condition) failures.push(name); };
  const report = { probes: {}, deferred: null };

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
  const commit = async (statements) => {
    if (statements.length === 0) return true;
    let connection;
    try { connection = await transport.begin("write", 10_000, undefined, LIMIT); } catch { return false; }
    try {
      await connection.execute(statements, { maxResponseBytes: READ_CAP });
      await connection.commit();
      return true;
    } catch {
      try { await connection.rollback(); } catch { /* nothing more to do */ }
      return false;
    }
  };
  const countRows = async (table, id) => {
    const read = await attempt("read", async (connection) => {
      const [result] = await connection.execute([{ sql: `SELECT id FROM ${table} WHERE id = :id`, args: { id } }], { maxResponseBytes: READ_CAP });
      return result.rows.length;
    });
    return read.error ? null : read.value;
  };

  for (const probe of CONSTRAINT_PROBES) {
    const base = unique(`c_${probe.name}`);
    const ids = { p: `${base}_p`, a: `${base}_a`, b: `${base}_b`, k: `${base}_k`, c: `${base}_c`, c2: `${base}_c2`, ca: `${base}_ca`, missing: `${base}_missing` };
    const entry = { constraint: null, statement: null, rollback: null, rowsAfter: null };
    report.probes[probe.name] = entry;
    expect(await commit(probe.seed(ids)), `${probe.name}: the rows to collide with were committed`);
    const run = await attempt("write", (connection) => connection.execute([
      insertParent(ids.a, ids.ca),
      probe.violate(ids),
    ], { maxResponseBytes: READ_CAP }));
    const classified = run.error ? classify(run.error) : null;
    entry.constraint = classified?.constraint ?? null;
    entry.statement = classified?.statement ?? null;
    entry.rollback = run.rollback ?? null;
    expect(classified !== null && classified.constraint === probe.expected && classified.statement === 1,
      `${probe.name}: the refusal is classified as ${probe.expected} at statement 1`);
    expect(entry.rollback === "ok", `${probe.name}: the rollback resolved`);
    entry.rowsAfter = await countRows(PARENT, ids.a);
    expect(entry.rowsAfter === 0, `${probe.name}: the statement before the refusal left no row`);
  }

  // A deferred foreign key is checked at COMMIT: the statement succeeds and the COMMIT fails.
  // That is never classified, and the transport had sent the COMMIT, so the outcome stays unknown.
  const base = unique("c_deferred");
  const id = `${base}_d`;
  const deferred = { classified: null, commitNotSent: null, rowsAfter: null };
  report.deferred = deferred;
  let connection;
  try { connection = await transport.begin("write", 10_000, undefined, LIMIT); } catch { connection = undefined; }
  expect(connection !== undefined, "deferred: the transaction began");
  if (connection !== undefined) {
    let executed = true;
    try {
      await connection.execute([{
        sql: "INSERT INTO smoke_constraint_deferred (id, parent_id) VALUES (:id, :parent)", args: { id, parent: `${base}_missing` },
      }], { maxResponseBytes: READ_CAP });
    } catch { executed = false; }
    expect(executed, "deferred: the statement succeeds, the check waits for COMMIT");
    let commitError;
    try { await connection.commit(); } catch (error) { commitError = error; }
    expect(commitError !== undefined, "deferred: the COMMIT fails");
    deferred.classified = commitError === undefined ? null : classify(commitError) !== null;
    deferred.commitNotSent = commitError === undefined ? null : isCommitNotSent(commitError);
    expect(deferred.classified === false, "deferred: the COMMIT failure is not classified");
    expect(deferred.commitNotSent === false, "deferred: the COMMIT failure is not 'not sent'");
    try { await connection.rollback(); } catch { /* the failed COMMIT may have ended the transaction */ }
    deferred.rowsAfter = await countRows("smoke_constraint_deferred", id);
    expect(deferred.rowsAfter === 0, "deferred: the failed COMMIT left no row");
  }

  return { failures, report };
};
