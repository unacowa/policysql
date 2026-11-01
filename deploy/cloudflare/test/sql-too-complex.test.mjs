// ADR 0027 pull request 4: the input-side limits are configurable, and a statement that the
// policy makes too complex for the downstream (the parser's height and recursion caps, the
// database's column, parameter, and LIKE limits, the column-metadata guard) is answered with
// one fixed error, `POLICYSQL_SQL_TOO_COMPLEX` (400), detected before COMMIT, whether PolicySQL
// measured it (emit time) or the database refused it (the Hrana error object, classified by
// `SQLITE_ERROR` and a message allowlist). Everything runs on both TransactionOwner adapters
// against a real SQLite behind the real HTTP transport.
import assert from "node:assert/strict";
import test from "node:test";
import { harness, OWNER_ADAPTERS, RawJson } from "./helpers/routing.mjs";
import { PolicySqlClient, PolicySqlError, PolicySqlOutcomeUnknownError, createHttpTransport } from "../../../packages/client/index.js";

// 64 resources with one shape: `projects` and `t1` ... `t63` (a join or an EXISTS nesting needs a
// distinct resource per level, and SQLite allows 64 tables in a join).
const TABLES = ["projects", ...Array.from({ length: 63 }, (_, i) => `t${i + 1}`)];
const columns = { id: "string", tenant_id: "string", name: "string", note: "string?", secret: "string" };
const fixture = {
  catalog: `version: 1\nresources:\n${TABLES.map((table) => `  ${table}:\n    source: { table: ${table} }\n    columns:\n${Object.entries(columns).map(([name, type]) => `      ${name}: { type: string${type.endsWith("?") ? ", nullable: true" : ""} }`).join("\n")}`).join("\n")}\n`,
  policy: `version: 1\nresources:\n${TABLES.map((table) => `  ${table}:
    roles:
      member:
        select:
          columns:
            - id
            - name
            - note
            - name: secret
              visible_if: { name: { eq: visible } }
              on_deny: null
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
        insert:
          columns: [id, name, note]
          presets:
            tenant_id: { session: tenant_id }
            secret: { literal: s }
          check: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id, name] }`).join("\n")}\n`,
  schema: TABLES.map((table) => `CREATE TABLE ${table} (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL, note TEXT, secret TEXT NOT NULL DEFAULT 's');`).join("\n"),
  physicalSchema: JSON.stringify({ tables: Object.fromEntries(TABLES.map((table) => [table, { columns: {
    id: { declaredType: "TEXT", nullable: false }, tenant_id: { declaredType: "TEXT", nullable: false }, name: { declaredType: "TEXT", nullable: false },
    note: { declaredType: "TEXT", nullable: true }, secret: { declaredType: "TEXT", nullable: false },
  } }])) }),
  seed(db, tenant) {
    for (const table of TABLES) db.prepare(`INSERT INTO ${table}(id,tenant_id,name,note) VALUES(?,?,?,?)`).run("seed", `tenant_${tenant}`, "visible", "n");
  },
};
const REQUIRED = { maxRows: 1_000, maxResultBytes: 64_000, timeoutMs: 1_000, maxStatements: 8 };
const EXECUTE = "/v1/transactions:execute";
const FIXED_MESSAGE = "The statement is too complex to run under the active policy.";
// Text of the emitted SQL, the policy, the schema, the parser, and SQLite that no response or log
// line of a mapped failure may contain.
const INTERNAL_TEXT = [
  "secret", "visibility", "__policysql", "tenant_id", "SELECT", "projects", "Expression tree", "too many columns",
  "LIKE or GLOB", "maximum depth", "ParseError", "sqlite", "SQLITE_ERROR", "pattern too complex",
];

const select = (sql, params = {}) => ({ statements: [{ sql, params }] });
const wide = (n) => `SELECT ${Array.from({ length: n }, (_, i) => `secret AS c${i}`).join(", ")} FROM projects`;
const orChain = (n) => `SELECT id FROM projects WHERE ${Array.from({ length: n }, () => "name = :p").join(" OR ")}`;
const notChain = (n) => `SELECT id FROM projects WHERE ${"NOT (".repeat(n)}name = :p${")".repeat(n)}`;
// The measured worst shapes nest in the WHEN condition (ADR 0027): `CASE WHEN <inner> IS NOT NULL
// THEN name END`, where each level adds the 4 of `IS NOT NULL` (or `NOT LIKE`) plus 1 for the CASE.
const caseNest = (n, wrap) => {
  let expression = "name";
  for (let i = 0; i < n; i += 1) expression = wrap(expression);
  return expression;
};
const isNotNull = (inner) => `CASE WHEN ${inner} IS NOT NULL THEN name END`;
const notLike = (inner) => `CASE WHEN ${inner} NOT LIKE :q THEN name END`;
const caseIsNotNull = (n) => `SELECT id FROM projects WHERE ${caseNest(n, isNotNull)} = :p`;
const caseNotLike = (n) => `SELECT id FROM projects WHERE ${caseNest(n, notLike)} = :p`;
const deepestOrLeaf = (n) => `SELECT id FROM projects WHERE name = :p OR ${caseNest(n, isNotNull)} = :p`;
const existsChain = (n) => {
  let predicate = "p0.name = :p";
  for (let i = 1; i <= n; i += 1) predicate = `EXISTS (SELECT 1 FROM t${i} p${i} WHERE p${i}.id = p0.id AND ${predicate})`;
  return `SELECT p0.id FROM projects p0 WHERE ${predicate}`;
};
const joins = (n) => `SELECT p0.id FROM projects p0 ${Array.from({ length: n }, (_, i) => `JOIN t${i + 1} p${i + 1} ON p${i + 1}.id = p0.id`).join(" ")} WHERE p0.name = :p`;

const parameters = { p: "visible" };

for (const ownerAdapter of OWNER_ADAPTERS) {
  const setup = (t, limits = {}) => {
    const logs = [];
    t.mock.method(console, "log", (line) => { logs.push(String(line)); });
    return harness(t, { ownerAdapter, fixture, hooks: false, runtimeLimits: { ...REQUIRED, ...limits } }).then((h) => Object.assign(h, { logs }));
  };
  const post = (h, body, path = EXECUTE, key = null) => h.request("a", path, body instanceof RawJson ? body : new RawJson(JSON.stringify(body)), key);
  const events = (h, name) => h.logs.flatMap((line) => { try { const record = JSON.parse(line); return record.event === name ? [record] : []; } catch { return []; } });
  const statementsRun = async (h) => { await h.flush(); return h.events.length; };

  /** The mapped failure, with nothing internal in the response or in any log line. */
  const assertTooComplex = (h, response, index = 0) => {
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, "POLICYSQL_SQL_TOO_COMPLEX");
    assert.equal(response.body.error.message, FIXED_MESSAGE);
    assert.equal(response.body.error.path, `/statements/${index}`);
    // The log lines of this request (a background cost observation of an earlier request can land
    // meanwhile, and it legitimately names the database it observed).
    const own = h.logs.filter((line) => line.includes(response.body.error.requestId));
    assert.ok(own.length >= 1, "the failure is logged");
    const everything = `${JSON.stringify(response.body)}\n${own.join("\n")}`;
    for (const text of INTERNAL_TEXT) assert.equal(everything.includes(text), false, `"${text}" must not appear: ${everything.slice(0, 400)}`);
  };

  // ------------------------------------------------------------------------------------------
  // The input-side limits are configurable, validated, and advertised exactly

  test(`${ownerAdapter}: maxParameters, maxExpressionDepth, maxProjections, and maxJoins are advertised exactly and enforced at the value and one over`, async (t) => {
    const configured = { maxParameters: 3, maxExpressionDepth: 4, maxProjections: 2, maxJoins: 2 };
    const h = await setup(t, configured);
    const { body: capabilities } = await h.request("a", "/v1/capabilities");
    for (const [key, value] of Object.entries(configured)) assert.equal(capabilities.limits[key], value, key);
    const over = (response) => {
      assert.equal(response.status, 413, JSON.stringify(response.body));
      assert.equal(response.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
    };
    // Parameters: distinct client names per statement.
    const named = (n) => ({ sql: `SELECT id FROM projects WHERE ${Array.from({ length: n }, (_, i) => `name = :p${i}`).join(" OR ")}`, params: Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, "visible"])) });
    assert.equal((await post(h, { statements: [named(3)] })).status, 200);
    over(await post(h, { statements: [named(4)] }));
    // Projections.
    assert.equal((await post(h, select("SELECT id, name FROM projects"))).status, 200);
    over(await post(h, select("SELECT id, name, note FROM projects")));
    // Joins.
    assert.equal((await post(h, select(joins(2), { p: "visible" }))).status, 200);
    over(await post(h, select(joins(3), { p: "visible" })));
    // Expression depth: the deepest chain the binder accepts, and the next one.
    let deepest = 0;
    for (let n = 1; n <= 8; n += 1) {
      const response = await post(h, select(notChain(n), { p: "visible" }));
      if (response.status === 200) deepest = n; else { over(response); break; }
    }
    assert.ok(deepest >= 1 && deepest < 8, `the binder stops a NOT chain of ${deepest + 1} at maxExpressionDepth 4`);
  });

  test(`${ownerAdapter}: the defaults are 1,024 parameters, depth 32, 128 projections, and 8 joins, and a 300-parameter bulk insert is served`, async (t) => {
    const h = await setup(t);
    const { body: capabilities } = await h.request("a", "/v1/capabilities");
    assert.deepEqual(
      ["maxParameters", "maxExpressionDepth", "maxProjections", "maxJoins"].map((key) => capabilities.limits[key]),
      [1_024, 32, 128, 8],
    );
    const bulk = (rows, prefix) => ({
      sql: `INSERT INTO projects(id,name,note) VALUES ${Array.from({ length: rows }, (_, i) => `(:id${i},:name${i},:note${i})`).join(",")}`,
      params: Object.fromEntries(Array.from({ length: rows }, (_, i) => [[`id${i}`, `${prefix}${i}`], [`name${i}`, "n"], [`note${i}`, "n"]]).flat()),
    });
    assert.equal((await post(h, { statements: [bulk(100, "a")] }, EXECUTE, "bulk-insert-key-000001")).status, 200);
    // 341 rows is 1,023 parameters; 342 rows is 1,026, over the default.
    assert.equal((await post(h, { statements: [bulk(341, "b")] }, EXECUTE, "bulk-insert-key-000002")).status, 200);
    const refused = await post(h, { statements: [bulk(342, "c")] }, EXECUTE, "bulk-insert-key-000003");
    assert.equal(refused.status, 413);
    assert.equal(refused.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
  });

  // ------------------------------------------------------------------------------------------
  // Emit-time exact counts

  test(`${ownerAdapter}: 2,000 emitted result columns are served and 2,002 are POLICYSQL_SQL_TOO_COMPLEX, with no database work`, async (t) => {
    const h = await setup(t, { maxProjections: 2_000, maxSqlBytes: 65_536 });
    // Every `secret` column is emitted with its visibility companion.
    const served = await post(h, select(wide(1_000)));
    assert.equal(served.status, 200, JSON.stringify(served.body).slice(0, 300));
    assert.equal(served.body.results[0].columns.length, 1_000);
    const before = await statementsRun(h);
    h.logs.length = 0;
    const refused = await post(h, select(wide(1_001)));
    assertTooComplex(h, refused);
    assert.equal(await statementsRun(h), before, "refused before any database work");
    const [record, ...rest] = events(h, "sql_too_complex");
    assert.equal(rest.length, 0);
    assert.equal(record.cause, "columns");
    assert.equal(record.statementIndex, 0);
    assert.equal(typeof record.requestId, "string");
    assert.equal(typeof record.schemaVersion, "string");
    assert.equal(typeof record.policyVersion, "string");
    assert.equal(record.abiVersion, 15);
    assert.deepEqual(Object.keys(record).sort(), ["abiVersion", "cause", "event", "policyVersion", "requestId", "schemaVersion", "statementIndex"]);
  });

  test(`${ownerAdapter}: the statement index of a too-complex statement is its index in the envelope, and none of the envelope runs`, async (t) => {
    const h = await setup(t, { maxProjections: 2_000 });
    const before = await statementsRun(h);
    const refused = await post(h, { statements: [{ sql: "SELECT id FROM projects", params: {} }, { sql: wide(1_001), params: {} }] });
    assertTooComplex(h, refused, 1);
    assert.equal(await statementsRun(h), before, "the first statement did not run either");
  });

  test(`${ownerAdapter}: a too-complex interactive statement closes the transaction as failed and rolls it back`, async (t) => {
    const h = await setup(t, { maxProjections: 2_000 });
    const started = await h.request("a", "/v1/transactions", { mode: "write" }, null);
    assert.equal(started.status, 201);
    const base = `/v1/transactions/${started.body.transactionId}`;
    const insert = (sequence, id) => ({ sequence, sql: "INSERT INTO projects(id,name,note) VALUES(:id,:name,:note) RETURNING id", params: { id, name: "n", note: "n" } });
    assert.equal((await h.request("a", `${base}/statements`, insert(1, "kept_until_rollback"), null)).status, 200);
    h.logs.length = 0;
    const refused = await h.request("a", `${base}/statements`, { sequence: 2, sql: wide(1_001), params: {} }, null);
    assertTooComplex(h, refused);
    // Later commands see an unavailable transaction (nothing to commit).
    const next = await h.request("a", `${base}/statements`, insert(3, "after"), null);
    assert.equal(next.status, 409);
    assert.equal(next.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
    const commit = await h.request("a", `${base}/commit`, { sequence: 3 }, null);
    assert.equal(commit.status, 409);
    assert.equal(commit.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
    const { database } = h.databases.get("a");
    assert.equal(database.prepare("SELECT count(*) AS n FROM projects WHERE id IN ('kept_until_rollback','after')").get().n, 0, "rolled back");
  });

  // ------------------------------------------------------------------------------------------
  // Height and recursion: at the limit they compile, re-parse, and run; one beyond is too complex

  /** The largest n up to `cap` whose statement is served, and the proof that n + 1 is too complex. */
  const boundary = async (h, build, cap, params = parameters) => {
    let low = 0;
    let high = cap + 1;
    const outcomes = new Map();
    const probe = async (n) => {
      if (!outcomes.has(n)) outcomes.set(n, await post(h, select(build(n), params)));
      return outcomes.get(n);
    };
    assert.equal((await probe(1)).status, 200, JSON.stringify((await probe(1)).body));
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if ((await probe(middle)).status === 200) low = middle; else high = middle;
    }
    return { largest: low, next: await probe(low + 1), cap };
  };
  const shapes = {
    "OR chain": [orChain, 63],
    "NOT chain": [notChain, 62],
    "CASE with IS NOT NULL nesting": [caseIsNotNull, 31],
    "CASE with NOT LIKE nesting": [caseNotLike, 31, { p: "visible", q: "x" }],
    "the IS NOT NULL nesting as the deepest OR leaf": [deepestOrLeaf, 31],
  };
  for (const [label, [build, cap, params = parameters]] of Object.entries(shapes)) {
    test(`${ownerAdapter}: ${label}: the largest accepted size runs, and one beyond is POLICYSQL_SQL_TOO_COMPLEX (never UNSUPPORTED_SQL or 500)`, async (t) => {
      const h = await setup(t, { maxExpressionDepth: 64 });
      const { largest, next } = await boundary(h, build, cap, params);
      assert.ok(largest >= 1, "some size is served");
      // The binder's own limit can come first (a NOT chain adds 1 per level, so depth 64 fits the
      // parser's cap of 100): then there is nothing downstream to refuse.
      if (largest === cap) return;
      if (next.status === 413) {
        assert.equal(next.body.error.code, "POLICYSQL_LIMIT_EXCEEDED", JSON.stringify(next.body));
        return;
      }
      h.logs.length = 0;
      const refused = await post(h, select(build(largest + 1), params));
      assert.deepEqual(refused.status, next.status);
      assertTooComplex(h, refused);
      const [record] = events(h, "sql_too_complex");
      assert.ok(["height", "recursion"].includes(record.cause), record.cause);
      assert.equal(events(h, "emitted_sql_reparse_failed").length, 0);
      // The served statement really ran on the database.
      const ran = await post(h, select(build(largest), params));
      assert.equal(ran.status, 200);
      assert.deepEqual(ran.body.results[0].rows, [{ id: "seed" }]);
    });
  }

  test(`${ownerAdapter}: an EXISTS nesting is served, then refused as client SQL the parser itself refuses (400 INVALID_SQL) or as too complex, never UNSUPPORTED_SQL or 500`, async (t) => {
    const h = await setup(t, { maxExpressionDepth: 64 });
    const { largest, next } = await boundary(h, existsChain, 63, { p: "visible" });
    assert.ok(largest >= 16, `a deep EXISTS nesting is served, got ${largest}`);
    if (largest === 63) return;
    // Client SQL beyond the parser's caps is the client's error (400 INVALID_SQL, ADR 0027); a
    // statement that only the policy made too complex is POLICYSQL_SQL_TOO_COMPLEX.
    assert.ok(["POLICYSQL_INVALID_SQL", "POLICYSQL_SQL_TOO_COMPLEX", "POLICYSQL_LIMIT_EXCEEDED"].includes(next.body.error.code), JSON.stringify(next.body));
    assert.ok(![500, 503].includes(next.status));
    assert.equal(events(h, "emitted_sql_reparse_failed").length, 0);
  });

  test(`${ownerAdapter}: many filtered inner joins are served up to the parser's height cap and POLICYSQL_SQL_TOO_COMPLEX beyond it`, async (t) => {
    const h = await setup(t, { maxJoins: 63, maxExpressionDepth: 64 });
    const { largest, next } = await boundary(h, joins, 63, { p: "visible" });
    assert.ok(largest >= 8, `at least the default 8 joins are served, got ${largest}`);
    assert.ok(largest < 63, "each filtered join adds to the emitted height, so the maximum is not reachable");
    h.logs.length = 0;
    assert.equal(next.status, 400);
    assertTooComplex(h, await post(h, select(joins(largest + 1), { p: "visible" })));
    assert.equal(events(h, "sql_too_complex")[0].cause, "height");
  });

  test(`${ownerAdapter}: the client reports a too-complex statement as a definite rejection, never as an unknown outcome`, async (t) => {
    const h = await setup(t, { maxProjections: 2_000 });
    const fetchImpl = (url, init) => h.app.fetch(new Request(url, init), { database: h.binding("a"), session: h.session("a") }, h.background);
    const client = new PolicySqlClient({ transport: createHttpTransport({ endpoint: "https://worker.test", fetchImpl }) });
    const before = await statementsRun(h);
    await assert.rejects(client.execute(wide(1_001)), (error) => {
      assert.ok(error instanceof PolicySqlError);
      assert.equal(error instanceof PolicySqlOutcomeUnknownError, false, "a definite rejection");
      assert.equal(error.code, "POLICYSQL_SQL_TOO_COMPLEX");
      assert.equal(error.status, 400);
      return true;
    });
    assert.equal(await statementsRun(h), before);
  });

  // ------------------------------------------------------------------------------------------
  // LIKE patterns

  test(`${ownerAdapter}: a bound LIKE pattern of 50,000 bytes is served and 50,001 is POLICYSQL_SQL_TOO_COMPLEX before the database`, async (t) => {
    const h = await setup(t, { maxSqlBytes: 65_536 });
    const like = (pattern) => select("SELECT id FROM projects WHERE name LIKE :q", { q: pattern });
    assert.equal((await post(h, like("é".repeat(25_000)))).status, 200, "50,000 bytes");
    const before = await statementsRun(h);
    h.logs.length = 0;
    assertTooComplex(h, await post(h, like("é".repeat(25_000) + "x")));
    assert.equal(await statementsRun(h), before);
    assert.equal(events(h, "sql_too_complex")[0].cause, "like_pattern");
    // A pattern that is a string literal of the SQL text is measured too.
    h.logs.length = 0;
    assertTooComplex(h, await post(h, select(`SELECT id FROM projects WHERE name GLOB '${"x".repeat(50_001)}'`)));
    assert.equal(events(h, "sql_too_complex")[0].cause, "like_pattern");
    assert.equal((await post(h, select(`SELECT id FROM projects WHERE name GLOB '${"x".repeat(50_000)}'`))).status, 200);
  });

  // ------------------------------------------------------------------------------------------
  // The database refuses for complexity: recognized by SQLITE_ERROR and the message allowlist

  const computedPattern = { sql: "SELECT id FROM projects WHERE name LIKE (:a || :b)", params: { a: "x".repeat(30_000), b: "y".repeat(30_000) } };

  test(`${ownerAdapter}: a LIKE pattern computed by an expression is refused by the database, and that is POLICYSQL_SQL_TOO_COMPLEX with the database's text nowhere`, async (t) => {
    const h = await setup(t, { maxSqlBytes: 65_536 });
    h.logs.length = 0;
    const refused = await post(h, { statements: [computedPattern] });
    assertTooComplex(h, refused);
    const [record] = events(h, "sql_too_complex");
    assert.equal(record.cause, "like_pattern");
    assert.equal(record.statementIndex, 0);
    assert.equal(events(h, "database_error_unclassified").length, 0);
  });

  test(`${ownerAdapter}: a database complexity refusal in an atomic envelope rolls it back, and in an interactive transaction closes it as failed`, async (t) => {
    const h = await setup(t, { maxSqlBytes: 65_536 });
    const insert = { sql: "INSERT INTO projects(id,name,note) VALUES(:id,:name,:note)", params: { id: "atomic_rolled_back", name: "n", note: "n" } };
    const refused = await post(h, { statements: [insert, computedPattern] }, EXECUTE, "complex-atomic-key-0001");
    assertTooComplex(h, refused, 1);
    const { database } = h.databases.get("a");
    assert.equal(database.prepare("SELECT count(*) AS n FROM projects WHERE id = 'atomic_rolled_back'").get().n, 0);
    // Interactive.
    const started = await h.request("a", "/v1/transactions", { mode: "write" }, null);
    const base = `/v1/transactions/${started.body.transactionId}`;
    h.logs.length = 0;
    const statement = await h.request("a", `${base}/statements`, { sequence: 1, ...computedPattern }, null);
    assertTooComplex(h, statement);
    const next = await h.request("a", `${base}/statements`, { sequence: 2, sql: "SELECT id FROM projects", params: {} }, null);
    assert.equal(next.status, 409);
    assert.equal(next.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  });

  test(`${ownerAdapter}: a database error the allowlist does not name stays 503 and is logged with its code only`, async (t) => {
    const h = await setup(t);
    const insert = (id) => ({ sql: "INSERT INTO projects(id,name,note) VALUES(:id,:name,:note)", params: { id, name: "n", note: "n" } });
    h.logs.length = 0;
    const duplicate = await post(h, { statements: [insert("seed")] }, EXECUTE, "unclassified-key-000001");
    assert.equal(duplicate.status, 503, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.error.code, "POLICYSQL_DATABASE_UNAVAILABLE");
    const [record] = events(h, "database_error_unclassified");
    assert.deepEqual(Object.keys(record).sort(), ["code", "event", "requestId"]);
    assert.equal(record.code, "SQLITE_CONSTRAINT");
    const everything = `${JSON.stringify(duplicate.body)}\n${h.logs.join("\n")}`;
    for (const text of ["UNIQUE", "projects.id", "constraint failed"]) assert.equal(everything.includes(text), false, text);
    assert.equal(events(h, "sql_too_complex").length, 0);
  });
}
