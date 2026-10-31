// How the Turso transport reads the Hrana error object of a statement request (ADR 0027): a
// refusal for complexity needs `code === "SQLITE_ERROR"` and a message that starts with an
// allowlist entry; nothing else is classified, a COMMIT is never classified, and the message is
// never kept, logged, or returned.
import assert from "node:assert/strict";
import test from "node:test";
import { COMPLEXITY_ALLOWLIST, COMPLEXITY_CODES, DatabaseStatementError, SqlComplexityError, complexityCause, statementFailure } from "../src/database-complexity.ts";
import { TursoHttpTransport } from "../src/turso-http.ts";
import { COMPLEXITY_PROBES, sqlComplexitySmoke } from "../scripts/smoke-complexity.mjs";
import { CommitNotSentError } from "../src/errors.ts";
import { directCommitFailureClass, directFailureClass, executeFailedEvent, failureClass } from "../src/step-effects.ts";

// The messages of SQLite 3.4x for each allowlist entry (the real server's text is checked by
// the release smoke for the entries marked `smokeVerified`).
const MESSAGES = new Map([
  ["too many columns in ", ["too many columns in result set", "too many columns in ORDER BY clause", "too many columns in set list", "too many columns in index"]],
  ["too many SQL variables", ["too many SQL variables"]],
  ["too many arguments on function", ["too many arguments on function lower"]],
  ["too many terms in compound SELECT", ["too many terms in compound SELECT"]],
  ["at most 64 tables in a join", ["at most 64 tables in a join"]],
  ["LIKE or GLOB pattern too complex", ["LIKE or GLOB pattern too complex"]],
  ["Expression tree is too large", ["Expression tree is too large (maximum depth 1000)"]],
]);

// SQLite's text as each server sends it: SQLite itself and a Hrana server forwarding the primary
// code send it bare with `SQLITE_ERROR`; Turso wraps it (observed on the real database by the
// release smoke): `SQLITE_UNKNOWN` with "SQLite error: ", and `SQL_INPUT_ERROR` with "SQLite input
// error: " and an " (at offset n)" suffix for a refusal found while the statement is parsed.
const SERVERS = {
  SQLITE_ERROR: (text) => text,
  SQLITE_UNKNOWN: (text) => `SQLite error: ${text}`,
  SQL_INPUT_ERROR: (text) => `SQLite input error: ${text} (at offset 7)`,
};

test("every allowlist entry matches its SQLite message with each server's code and wrapper and names a fixed cause", () => {
  assert.deepEqual(Object.keys(SERVERS).sort(), Object.keys(COMPLEXITY_CODES).sort());
  assert.deepEqual([...MESSAGES.keys()].sort(), COMPLEXITY_ALLOWLIST.map((entry) => entry.prefix).sort(), "every entry has a message here");
  const causes = new Set();
  for (const { prefix, cause } of COMPLEXITY_ALLOWLIST) {
    assert.match(cause, /^[a-z_]+$/u);
    causes.add(cause);
    for (const text of MESSAGES.get(prefix)) {
      for (const [code, wrap] of Object.entries(SERVERS)) {
        const message = wrap(text);
        assert.equal(complexityCause({ code, message }), cause, `${code}: ${message}`);
        const failure = statementFailure({ code, message }, 3);
        assert.ok(failure instanceof SqlComplexityError);
        assert.equal(failure.statement, 3);
        assert.equal(failure.complexityCause, cause);
        assert.equal(JSON.stringify(failure).includes("too many"), false, "the message is not kept");
        assert.equal(String(failure.message).includes(text), false);
      }
    }
  }
  assert.equal(causes.size, COMPLEXITY_ALLOWLIST.length, "one cause per entry");
});

test("a match needs code SQLITE_ERROR and a message prefix: other codes, near misses, and non-strings are not complexity", () => {
  const message = "too many columns in result set";
  for (const code of ["SQLITE_BUSY", "SQLITE_CONSTRAINT", "SQLITE_CONSTRAINT_UNIQUE", "SQLITE_FULL", "SQLITE_ERROR_X", "sqlite_error", "SQL_PARSE_ERROR", undefined, null, 1, ""]) {
    for (const wrapper of ["", "SQLite error: ", "SQLite input error: "]) {
      assert.equal(complexityCause({ code, message: `${wrapper}${message}` }), null, `${code} ${wrapper}`);
    }
  }
  // A code and a wrapper never mix: each server's code carries only its own wrapper.
  assert.equal(complexityCause({ code: "SQLITE_UNKNOWN", message }), null);
  assert.equal(complexityCause({ code: "SQLITE_UNKNOWN", message: `SQLite input error: ${message}` }), null);
  assert.equal(complexityCause({ code: "SQLITE_ERROR", message: `SQLite error: ${message}` }), null);
  assert.equal(complexityCause({ code: "SQL_INPUT_ERROR", message: `SQLite error: ${message}` }), null);
  assert.equal(complexityCause({ code: "SQL_INPUT_ERROR", message }), null);
  for (const text of ["", " too many columns in result set", "prefix too many columns in result set", "TOO MANY COLUMNS IN RESULT SET",
    "too many columns", "too many SQL variable", "Expression tree", "LIKE pattern too complex", 1, null, undefined, {}]) {
    assert.equal(complexityCause({ code: "SQLITE_ERROR", message: text }), null, String(text));
    assert.equal(complexityCause({ code: "SQLITE_UNKNOWN", message: typeof text === "string" ? `SQLite error: ${text}` : text }), null, String(text));
  }
  for (const error of [null, undefined, "error", 1, [], {}]) assert.equal(complexityCause(error), null);
});

test("an unmatched statement error is a 503 carrying only a safe database code", () => {
  for (const [code, expected] of [["SQLITE_CONSTRAINT", "SQLITE_CONSTRAINT"], ["SQLITE_BUSY", "SQLITE_BUSY"], ["has space", "UNKNOWN"],
    ["lower", "UNKNOWN"], ["X".repeat(65), "UNKNOWN"], [undefined, "UNKNOWN"], [7, "UNKNOWN"], ["SQLITE_ERROR\n", "UNKNOWN"]]) {
    const failure = statementFailure({ code, message: "UNIQUE constraint failed: projects.id" }, 0);
    assert.ok(failure instanceof DatabaseStatementError);
    assert.equal(failure.code, "POLICYSQL_DATABASE_UNAVAILABLE");
    assert.equal(failure.databaseCode, expected);
    assert.equal(JSON.stringify(failure).includes("projects"), false);
    assert.equal(failure.message.includes("projects"), false);
  }
  // SQLITE_ERROR with a message off the allowlist is unclassified, not complexity.
  assert.ok(statementFailure({ code: "SQLITE_ERROR", message: 'no such table: "secret_table"' }, 0) instanceof DatabaseStatementError);
});

test("the executeFailed event: complex carries the index and cause, an unclassified failure only the code, and a commit is never complex", () => {
  const complex = new SqlComplexityError(2, "columns");
  for (const classify of [failureClass, directFailureClass]) {
    assert.deepEqual(executeFailedEvent(7, complex, classify), { type: "executeFailed", id: 7, class: "complex", statement: 2, cause: "columns" });
  }
  const unclassified = new DatabaseStatementError("SQLITE_CONSTRAINT");
  assert.deepEqual(executeFailedEvent(8, unclassified, failureClass), { type: "executeFailed", id: 8, class: "unavailable", databaseCode: "SQLITE_CONSTRAINT" });
  assert.deepEqual(executeFailedEvent(9, new Error("boom"), directFailureClass), { type: "executeFailed", id: 9, class: "unavailable" });
  // Never produced for a commit, even if a complexity error reached the commit mapping.
  assert.equal(directCommitFailureClass(complex), "unavailable");
  assert.equal(directCommitFailureClass(new CommitNotSentError(complex)), "not_committed");
});

const ok = (columns = [], rows = []) => ({
  type: "ok",
  response: { type: "execute", result: {
    cols: columns.map((name) => ({ name, decltype: "TEXT" })), rows: rows.map((row) => row.map((value) => ({ type: "text", value }))),
    affected_row_count: 0, rows_read: 0, rows_written: 0, query_duration_ms: 1,
  } },
});

// Every reply carries a new baton, as a real server's does; `batons` records the one each request used.
const transport = (reply, batons = []) => {
  let serial = 0;
  return new TursoHttpTransport({ url: "https://db.test", authToken: "fixture" }, "complexity", async (_url, init) => {
    const { baton, requests } = JSON.parse(init.body);
    batons.push(baton ?? null);
    serial += 1;
    return Response.json({ baton: `complexity-baton-${serial}`, results: requests.map((request, index) => reply(request, index)) });
  });
};

const refusal = (message, code = "SQLITE_ERROR") => ({ type: "error", error: { message, code } });
const limit = { maxBytesPerValue: 262_144 };

test("after a refused statement the rollback continues the stream with the baton of the refusal's reply", async () => {
  // Found by the release smoke against real Turso: a rollback sent with the previous baton leaves
  // the transaction (and its write lock) open until the stream expires, so every later BEGIN
  // timed out.
  const batons = [];
  const instance = transport((request) => {
    const sql = request.stmt?.sql ?? "";
    if (request.type === "close") return { type: "ok", response: { type: "close" } };
    if (/^BEGIN/u.test(sql) || sql === "ROLLBACK") return ok();
    return refusal("SQLite error: too many columns in result set", "SQLITE_UNKNOWN");
  }, batons);
  const transaction = await instance.begin("write", 1_000, undefined, limit);
  await assert.rejects(transaction.execute([{ sql: "SELECT refused" }]), (error) => error instanceof SqlComplexityError);
  await transaction.rollback();
  // BEGIN has no baton; the refused statement used the BEGIN reply's; the rollback the refusal's.
  assert.deepEqual(batons, [null, "complexity-baton-1", "complexity-baton-2"]);
  // The same holds for a failure that is not complexity.
  const other = [];
  const failing = await transport((request) => (request.stmt?.sql === "SELECT other" ? refusal("SQLite error: no such table: x", "SQLITE_UNKNOWN") : /^BEGIN|^ROLLBACK/u.test(request.stmt?.sql ?? "") ? ok() : { type: "ok", response: { type: "close" } }), other)
    .begin("write", 1_000, undefined, limit);
  await assert.rejects(failing.execute([{ sql: "SELECT other" }]), (error) => error instanceof DatabaseStatementError);
  await failing.rollback();
  assert.deepEqual(other, [null, "complexity-baton-1", "complexity-baton-2"]);
});

test("the transport classifies the first refused statement of a pipeline by its index, and BEGIN, COMMIT, and ROLLBACK never", async () => {
  const columns = refusal("too many columns in result set");
  const instance = transport((request, index) => {
    const sql = request.stmt?.sql ?? "";
    if (/^BEGIN/u.test(sql)) return ok();
    if (request.type === "close") return { type: "ok", response: { type: "close" } };
    if (sql === "COMMIT" || sql === "ROLLBACK") return columns;
    if (sql === "SELECT first") return ok(["a"], [["1"]]);
    return index === 1 ? columns : refusal("LIKE or GLOB pattern too complex");
  });
  const transaction = await instance.begin("write", 1_000, undefined, limit);
  await assert.rejects(transaction.execute([{ sql: "SELECT first" }, { sql: "SELECT second" }, { sql: "SELECT third" }]),
    (error) => error instanceof SqlComplexityError && error.statement === 1 && error.complexityCause === "columns");
  // A COMMIT whose reply is a complexity message is a transport failure, never a classification.
  await assert.rejects(transaction.commit(), (error) => !(error instanceof SqlComplexityError) && error.code === "POLICYSQL_DATABASE_UNAVAILABLE");
  const another = await transport((request) => (/^BEGIN/u.test(request.stmt?.sql ?? "") ? ok() : columns)).begin("write", 1_000, undefined, limit);
  await assert.rejects(another.rollback(), (error) => !(error instanceof SqlComplexityError) && error.code === "POLICYSQL_DATABASE_UNAVAILABLE");
  // BEGIN itself is not classified either.
  await assert.rejects(transport(() => columns).begin("write", 1_000, undefined, limit),
    (error) => !(error instanceof SqlComplexityError) && error.code === "POLICYSQL_DATABASE_UNAVAILABLE");
});

test("the release smoke sends a statement for exactly the allowlist entries marked smokeVerified, and fails when one stops matching", async () => {
  const verified = COMPLEXITY_ALLOWLIST.filter((entry) => entry.smokeVerified).map((entry) => entry.prefix);
  assert.deepEqual(Object.keys(COMPLEXITY_PROBES).sort(), verified.sort());
  // A stand-in database that refuses every probe with Turso's real wording, except for one entry
  // whose message changed: the section names that entry as a failure.
  const refusalFor = (sql) => {
    const entry = COMPLEXITY_ALLOWLIST.find((candidate) => COMPLEXITY_PROBES[candidate.prefix] === sql);
    if (!entry) return sql.includes("no_such_table") ? refusal("SQLite error: no such table: x", "SQLITE_UNKNOWN") : null;
    const reworded = entry.prefix === "too many SQL variables";
    return refusal(reworded ? "SQLite error: too many parameters" : `SQLite error: ${entry.prefix}`, "SQLITE_UNKNOWN");
  };
  const database = transport((request) => {
    const sql = request.stmt?.sql ?? "";
    if (request.type === "close") return { type: "ok", response: { type: "close" } };
    if (/^BEGIN/u.test(sql) || sql === "ROLLBACK") return ok();
    return refusalFor(sql) ?? ok();
  });
  const idle = async () => ({
    status: 400, text: async () => JSON.stringify({ error: { code: "POLICYSQL_SQL_TOO_COMPLEX", message: "The statement is too complex to run under the active policy.", path: "/statements/0" } }),
  });
  const context = { call: idle, baseUrl: "https://worker.test", headers: {}, expected: {} };
  const result = await sqlComplexitySmoke(context, {
    transport: database, allowlist: COMPLEXITY_ALLOWLIST,
    classify: (error) => (error instanceof SqlComplexityError ? error.complexityCause : null),
  });
  assert.ok(result.failures.includes('allowlist entry "too many SQL variables" no longer matches what real Turso sends'), JSON.stringify(result.failures));
  assert.equal(result.failures.filter((failure) => failure.startsWith("allowlist entry")).length, 1, "only the reworded entry fails");
});
