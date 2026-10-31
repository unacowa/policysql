// Release-smoke section for SQL complexity (ADR 0027 pull request 4). Like the sections of
// smoke-sections.mjs it returns `{ failures, report }`; neither contains a token or a secret.
import { client, errorCode, summary, unique } from "./smoke-sections.mjs";

// The read cap this smoke gives the transport, as core gives one with each execute (ADR 0027).
const READ_CAP = 1_048_576;

const columnList = (count) => Array.from({ length: count }, (_, index) => `${index} AS c${index}`).join(",");

/**
 * One statement per allowlist entry that the real database refuses for exactly that reason,
 * cheaply and without touching any table. The keys are the entries' message prefixes
 * (`COMPLEXITY_ALLOWLIST`); the section fails unless this table covers exactly the entries marked
 * `smokeVerified`. Each statement is sent to the real Turso database as it is, and the smoke fails
 * if the transport's classification does not name the entry's cause.
 */
export const COMPLEXITY_PROBES = Object.freeze({
  "too many columns in ": `SELECT ${columnList(2_001)}`,
  "too many SQL variables": `SELECT ${Array(32_800).fill("?").join(",")}`,
  "too many arguments on function": `SELECT max(${Array(130).fill("1").join(",")})`,
  "too many terms in compound SELECT": `SELECT 1 ${"UNION SELECT 1 ".repeat(600)}`,
  "at most 64 tables in a join": `SELECT 1 FROM ${Array.from({ length: 65 }, (_, index) => `sqlite_master m${index}`).join(" JOIN ")}`,
  "LIKE or GLOB pattern too complex": "SELECT 1 WHERE 'x' LIKE replace(hex(zeroblob(30000)),'0','a')",
  "Expression tree is too large": `SELECT ${Array(1_100).fill("1").join("+")}`,
});

// What the real database must still accept: the allowlist is not wider than the limits it names.
const COMPLEXITY_CONTROLS = Object.freeze({
  "2,000 columns": `SELECT ${columnList(2_000)}`,
  "a LIKE pattern of 50,000 bytes": "SELECT 1 WHERE 'x' LIKE replace(hex(zeroblob(25000)),'0','a')",
});

// Nothing of the emitted SQL, the policy, or the database's own text may reach a response.
const INTERNAL_TEXT = ["SQLite", "SQLITE", "too many", "LIKE or GLOB", "pattern", "SELECT", "projects", "smoke_values", "__policysql"];
const FIXED_MESSAGE = "The statement is too complex to run under the active policy.";

/**
 * The database complexity errors against real Turso (ADR 0027): every allowlist entry the smoke
 * can produce is sent to the database directly and must be classified by the transport, and a
 * statement the database refuses for complexity through the deployed Worker must be 400
 * `POLICYSQL_SQL_TOO_COMPLEX` with nothing of the database's text, in an atomic envelope (rolled
 * back) and in an interactive transaction (closed as failed). It fails if an allowlist entry stops
 * matching what the server sends, so a server-side change cannot silently turn the refusal back
 * into a 503.
 *
 * `database` is `{ transport }` (a `TursoHttpTransport` to the real database), `allowlist` the
 * library's `COMPLEXITY_ALLOWLIST`, and `classify` its `complexityCause` applied to the failure
 * the transport raised (null when the failure is not a complexity refusal).
 */
export const sqlComplexitySmoke = async (context, { transport, allowlist, classify }) => {
  const api = client(context);
  const failures = [];
  const expect = (condition, name) => { if (!condition) failures.push(name); };
  const report = { allowlist: {}, controls: {} };

  const verified = allowlist.filter((entry) => entry.smokeVerified);
  expect(JSON.stringify(verified.map((entry) => entry.prefix).sort()) === JSON.stringify(Object.keys(COMPLEXITY_PROBES).sort()),
    "the smoke has a statement for exactly the allowlist entries marked smokeVerified");
  const run = async (sql) => {
    const connection = await transport.begin("read", 10_000, undefined, { maxBytesPerValue: 262_144 });
    try { await connection.execute([{ sql }], { maxResponseBytes: READ_CAP }); return null; } catch (error) { return error; } finally { await connection.rollback().catch(() => {}); }
  };
  for (const entry of verified) {
    const error = await run(COMPLEXITY_PROBES[entry.prefix]);
    const cause = error === null ? null : classify(error);
    report.allowlist[entry.prefix] = { cause: cause ?? (error === null ? "accepted" : "unmatched"), expected: entry.cause };
    expect(cause === entry.cause, `allowlist entry "${entry.prefix}" no longer matches what real Turso sends`);
  }
  for (const [name, sql] of Object.entries(COMPLEXITY_CONTROLS)) {
    const error = await run(sql);
    report.controls[name] = error === null ? "accepted" : "refused";
    expect(error === null, `real Turso still accepts ${name}`);
  }
  const unrelated = await run("SELECT * FROM no_such_table_for_the_smoke");
  expect(unrelated !== null && classify(unrelated) === null, "an unrelated database error is not classified as complexity");

  const noInternalText = (outcome) => INTERNAL_TEXT.every((text) => !JSON.stringify(outcome.body).includes(text));
  const tooComplex = (outcome, index = 0) => outcome.status === 400 && errorCode(outcome) === "POLICYSQL_SQL_TOO_COMPLEX"
    && outcome.body?.error?.message === FIXED_MESSAGE && outcome.body?.error?.path === `/statements/${index}` && noInternalText(outcome);

  // Emit time: a bound pattern over 50,000 bytes never reaches the database.
  const like = (pattern) => [{ sql: "SELECT id FROM projects WHERE name LIKE :q", params: { q: pattern } }];
  const served = await api.execute(like("a".repeat(50_000)));
  expect(served.status === 200, "a bound LIKE pattern of 50,000 bytes is served");
  const boundOver = await api.execute(like("a".repeat(50_001)));
  expect(tooComplex(boundOver), "a bound LIKE pattern of 50,001 bytes is POLICYSQL_SQL_TOO_COMPLEX");

  // The database refuses a computed pattern: the Hrana error is classified.
  const computed = { sql: "SELECT id FROM projects WHERE name LIKE (:a || :b)", params: { a: "x".repeat(30_000), b: "y".repeat(30_000) } };
  const databaseRefusal = await api.execute([computed]);
  expect(tooComplex(databaseRefusal), "a LIKE pattern the database refuses is POLICYSQL_SQL_TOO_COMPLEX");

  // Atomic: the failing statement's index, and the write before it rolled back.
  const probe = unique("scx");
  const insert = {
    sql: "INSERT INTO smoke_values (id, label, note, payload) VALUES (:id, :label, :note, :payload) RETURNING id",
    params: { id: probe, label: "rolled back", note: null, payload: null },
  };
  const atomic = await api.execute([insert, computed]);
  expect(tooComplex(atomic, 1), "a database complexity refusal in an atomic envelope names the failed statement");
  const after = await api.execute([{ sql: "SELECT id FROM smoke_values WHERE id = :id", params: { id: probe } }]);
  expect(after.status === 200 && (after.body?.results?.[0]?.rows ?? []).length === 0, "the atomic envelope was rolled back");

  // Interactive: the transaction closes as failed.
  const begin = await api.begin("write");
  const transactionId = begin.body?.transactionId;
  const empty = { status: 0, body: null, elapsedMs: 0 };
  const statement = begin.status === 201 ? await api.statement(transactionId, { sequence: 1, ...computed }) : empty;
  expect(begin.status === 201 && tooComplex(statement), "a database complexity refusal in an interactive statement is POLICYSQL_SQL_TOO_COMPLEX");
  const next = begin.status === 201 ? await api.statement(transactionId, { sequence: 2, sql: "SELECT id FROM projects", params: {} }) : empty;
  expect(next.status === 409 && errorCode(next) === "POLICYSQL_TRANSACTION_UNAVAILABLE", "the transaction is closed after the refusal");

  // #96: a statement reply the transport cannot read (over its read cap, 1 MiB here, against a 3 MB reply) leaves the stream
  // unusable; nothing is sent with a stale baton, so the server expires the stream and releases its
  // write lock, and a following BEGIN on the same database succeeds. The wait is recorded.
  const oversized = { refused: false, beginAfterMs: null };
  {
    const connection = await transport.begin("write", 10_000, undefined, { maxBytesPerValue: 262_144 });
    try { await connection.execute([{ sql: "SELECT replace(hex(zeroblob(1500000)),'0','a')" }], { maxResponseBytes: READ_CAP }); } catch (error) {
      oversized.refused = error?.code === "POLICYSQL_LIMIT_EXCEEDED";
    }
    await connection.rollback().catch(() => {});
    expect(oversized.refused, "a statement reply over the transport bound is refused as a limit");
    const started = Date.now();
    while (oversized.beginAfterMs === null && Date.now() - started < 60_000) {
      try {
        const next = await transport.begin("write", 2_000, undefined, { maxBytesPerValue: 262_144 });
        oversized.beginAfterMs = Date.now() - started;
        await next.rollback().catch(() => {});
      } catch { await new Promise((resolve) => setTimeout(resolve, 1_000)); }
    }
    expect(oversized.beginAfterMs !== null, "a BEGIN on the same database succeeds after an oversized statement reply");
  }
  report.oversizedReply = oversized;

  report.worker = {
    boundPatternServed: summary(served), boundPatternOver: summary(boundOver), databaseRefusal: summary(databaseRefusal),
    atomic: summary(atomic), interactive: { statement: summary(statement), next: summary(next) },
  };
  return { failures, report };
};
