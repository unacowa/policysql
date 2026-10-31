// The result and response budget (ADR 0027 pull request 6), end to end on both TransactionOwner
// adapters: every result-side limit at its cap and one over with the right code, the raw values
// of a result (companion cells and column descriptors included) counted, the read cap core hands
// the transport (the compiled raw bound, enforced while the reply streams, before anything is
// parsed), the response measured before COMMIT (413, rollback, no idempotency record, a retry
// runs again), replay of a committed request after the limits shrank, a stored response that
// doubles twice, a row written before the bounds existed, and the `streamedReadCap` capability.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runtimeLimits } from "../src/limits.ts";
import { validateDatabaseProvider } from "../src/database.ts";
import { PolicySqlRuntime } from "../pkg/policysql_wasm.js";
import { RUNTIME_LIMITS } from "../wrapper/limits.ts";
import { harness, OWNER_ADAPTERS, RawJson } from "./helpers/routing.mjs";

const read = (name) => readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url), "utf8");
const fixture = {
  catalog: read("bytes/catalog.yaml"), policy: read("bytes/policy.yaml"),
  schema: read("bytes/schema.sql"), physicalSchema: read("bytes/physical-schema.json"),
  seed(db, tenant) {
    db.prepare("INSERT INTO projects(id,tenant_id,name,state,seed) VALUES(?,?,?,?,?)")
      .run("seed", `tenant_${tenant}`, "visible", Buffer.from([0, 1, 2, 255]), Buffer.alloc(0));
  },
};
const EXECUTE = "/v1/transactions:execute";
const BASE = { maxRows: 100, maxResultBytes: 64_000, timeoutMs: 1_000, maxStatements: 8 };
const LOOKUP_BYTES = 2 * 589_824 + 4_096;
// The protected statement the engine sends for `SELECT id FROM projects` (never a cost EXPLAIN).
const isSelectId = (sql) => /^SELECT "__policysql_t0"\."id" AS "id" FROM "projects"/u.test(sql);
let serial = 0;
const uid = () => `r${String((serial += 1)).padStart(6, "0")}`;
const bodyBytes = (value) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;

for (const ownerAdapter of OWNER_ADAPTERS) {
  const setup = (t, limits = {}, options = {}) => {
    t.mock.method(console, "log", () => {});
    return harness(t, {
      ownerAdapter, fixture, hooks: false, runtimeLimits: { ...BASE, ...limits }, ...options,
    });
  };
  const post = (h, statements, key = null) => h.request("a", EXECUTE, new RawJson(JSON.stringify({ statements })), key);
  const db = (h) => h.databases.get("a").database;
  const fill = (h, count, column = "id") => {
    const insert = db(h).prepare("INSERT INTO projects(id,tenant_id,name,state,seed) VALUES(?,?,?,?,?)");
    for (let index = 0; index < count; index++) insert.run(`${column}${String(index).padStart(6, "0")}`, "tenant_a", "n", null, Buffer.alloc(0));
  };
  const count = (h, id) => db(h).prepare("SELECT count(*) AS n FROM projects WHERE id = ?").get(id).n;
  const idempotencyRows = (h) => db(h).prepare("SELECT count(*) AS n FROM policysql_idempotency").get().n;
  const SELECT_ID = [{ sql: "SELECT id FROM projects", params: {} }];

  test(`${ownerAdapter}: the hard maxima are construction errors one over, and Capabilities advertises the response limit`, async (t) => {
    t.mock.method(console, "log", () => {});
    for (const [limits, field] of [
      [{ maxStatements: 65 }, "max_statements"], [{ maxRows: 100_001 }, "max_rows"], [{ maxResultBytes: 524_289 }, "max_result_bytes"],
    ]) {
      await assert.rejects(harness(t, { ownerAdapter, fixture, hooks: false, runtimeLimits: { ...BASE, ...limits } }),
        (error) => String(error).includes(`\`${field}\` must be an integer from 1 to`), field);
    }
    for (const limits of [
      { maxStatements: 64 }, { maxRows: 100_000 }, { maxResultBytes: 524_288 },
      { maxResultBytes: 1_000, maxResponseBytes: 4_072 }, { maxResponseBytes: 589_824 },
    ]) await harness(t, { ownerAdapter, fixture, hooks: false, runtimeLimits: { ...BASE, ...limits } });
    // maxResponseBytes: from maxResultBytes + 3,072 to 589,824.
    for (const [limits, ok] of [
      [{ maxResultBytes: 1_000, maxResponseBytes: 4_071 }, false], [{ maxResultBytes: 1_000, maxResponseBytes: 4_072 }, true],
      [{ maxResponseBytes: 589_825 }, false], [{ maxResponseBytes: 64_000 + 3_071 }, false], [{ maxResponseBytes: 64_000 + 3_072 }, true],
    ]) {
      const attempt = harness(t, { ownerAdapter, fixture, hooks: false, runtimeLimits: { ...BASE, ...limits } });
      if (ok) await attempt;
      else await assert.rejects(attempt, (error) => String(error).includes("`max_response_bytes` must be an integer from `max_result_bytes` + 3072"));
    }
    const h = await setup(t, { maxResponseBytes: 100_000 });
    const capabilities = await h.request("a", "/v1/capabilities", undefined, null);
    assert.equal(capabilities.body.limits.maxResponseBytes, 100_000);
    assert.equal(runtimeLimits(h.runtime).maxResponseBytes, 100_000);
    assert.equal(capabilities.body.limits.maxJsonValues, 65_536);
    const defaults = await setup(t);
    assert.equal((await defaults.request("a", "/v1/capabilities", undefined, null)).body.limits.maxResponseBytes, 64_000 + 65_536);
  });

  test(`${ownerAdapter}: maxStatements, maxRows, and maxResultBytes are served at the cap and 413 one over`, async (t) => {
    // Statements: 64 are served, 65 are not.
    const many = await setup(t, { maxStatements: 64 });
    const statement = (index) => ({ sql: "SELECT id FROM projects WHERE id = :id", params: { id: `s${index}` } });
    const served = await post(many, Array.from({ length: 64 }, (_, index) => statement(index)));
    assert.equal(served.status, 200, JSON.stringify(served.body).slice(0, 200));
    assert.equal(served.body.results.length, 64);
    const over = await post(many, Array.from({ length: 65 }, (_, index) => statement(index)));
    assert.equal(over.status, 413);
    assert.equal(over.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
    // Rows: the seed row and two more are three visible rows.
    const rows = await setup(t, { maxRows: 3 });
    fill(rows, 2);
    assert.equal((await post(rows, SELECT_ID)).status, 200);
    fill(rows, 1, "z");
    const rowsOver = await post(rows, SELECT_ID);
    assert.equal(rowsOver.status, 413);
    assert.equal(rowsOver.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
    // Result bytes: the public encoding of the rows, exactly at the limit and one under it.
    const probe = await setup(t);
    fill(probe, 5);
    const probed = await post(probe, SELECT_ID);
    assert.equal(probed.status, 200);
    const bytes = bodyBytes(probed.body.results[0].rows);
    for (const [limit, status] of [[bytes, 200], [bytes - 1, 413]]) {
      const h = await setup(t, { maxResultBytes: limit });
      fill(h, 5);
      const response = await post(h, SELECT_ID);
      assert.equal(response.status, status, `limit=${limit}`);
      if (status === 413) assert.equal(response.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
    }
  });

  test(`${ownerAdapter}: the raw values of a result are counted at the limit and one over, companions and descriptors included`, async (t) => {
    // The fixture's policy returns at most 100 rows per statement and per envelope, so a result
    // reaches 1,024 values by width: a statement of `columns` emitted columns and `rows` rows has
    // columns x (1 + rows) values (the descriptors, then every cell, companions included).
    const limits = { maxJsonValues: 1_024, maxRows: 100 };
    const ids = (h, rows) => {
      const insert = db(h).prepare("INSERT INTO projects(id,tenant_id,name,state,seed) VALUES(?,?,?,?,?)");
      for (let index = 0; index < rows; index++) insert.run(`v${String(index).padStart(6, "0")}`, "tenant_a", "n", null, Buffer.alloc(0));
    };
    const id = (index) => `v${String(index).padStart(6, "0")}`;
    const range = (projections, from, to) => ({
      sql: `SELECT ${projections} FROM projects WHERE id >= :from AND id < :to`, params: { from: id(from), to: id(to) },
    });
    const columns = (count, expression) => Array.from({ length: count }, (_, index) => `${expression} AS a${index}`).join(", ");
    // 20 plain columns x (1 + 50 rows) = 1,020 values; then one column of `last` rows adds 1 + last:
    // 3 rows are 1,024 (served), 4 rows are 1,025 (one over).
    for (const [last, status] of [[3, 200], [4, 413]]) {
      const h = await setup(t, limits);
      ids(h, 50 + last);
      const response = await post(h, [range(columns(20, "id"), 0, 50), range("id", 50, 50 + last)]);
      assert.equal(response.status, status, `${last} rows: ${JSON.stringify(response.body).slice(0, 160)}`);
      if (status === 413) {
        assert.equal(response.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
        await h.flush();
        assert.equal(h.events.some((event) => event.sql === "COMMIT"), false, "rolled back, never committed");
      }
    }
    // Ten conditional columns are twenty emitted ones (each with a visibility companion cell and
    // descriptor): the same counts, so the companions are counted (ten plain columns would be 510).
    for (const [last, status] of [[3, 200], [4, 413]]) {
      const h = await setup(t, limits);
      ids(h, 50 + last);
      const response = await post(h, [range(columns(10, "private_state"), 0, 50), range("id", 50, 50 + last)]);
      assert.equal(response.status, status, `${last} rows: ${JSON.stringify(response.body).slice(0, 160)}`);
    }
    // The same two statements, one at a time, are far from the limit: the count is cumulative.
    const alone = await setup(t, limits);
    ids(alone, 54);
    assert.equal((await post(alone, [range(columns(20, "id"), 0, 50)])).status, 200);
    assert.equal((await post(alone, [range("id", 50, 54)])).status, 200);
    // Values inside a JSON cell count, with the descriptor and the cell: [0..n) is n + 1 values,
    // so the statement is n + 3.
    for (const [numbers, status] of [[1_021, 200], [1_022, 413]]) {
      const h = await setup(t, limits);
      db(h).prepare("UPDATE projects SET metadata = ? WHERE id = 'seed'").run(JSON.stringify([...Array(numbers).keys()]));
      const response = await post(h, [{ sql: "SELECT metadata FROM projects", params: {} }]);
      assert.equal(response.status, status, `${numbers}: ${JSON.stringify(response.body).slice(0, 120)}`);
      if (status === 413) assert.equal(response.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
    }
  });

  test(`${ownerAdapter}: the engine hands the transport core's compiled raw bound as its read cap`, async (t) => {
    const caps = [];
    const h = await setup(t, {}, {
      customizeProvider: (provider) => ({
        ...provider,
        async connect(...args) {
          const transport = await provider.connect(...args);
          return { begin: async (...begin) => {
            const transaction = await transport.begin(...begin);
            return new Proxy(transaction, { get(target, property) {
              if (property === "execute") return (statements, options) => { caps.push({ sql: statements[0].sql, ...options }); return target.execute(statements, options); };
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            } });
          } };
        },
      }),
    });
    // 2 x 64,000 result bytes, 64 bytes for each of at most 100 cells (maxRows x one column), 512
    // for the statement, the column metadata (2 x 2 + 2 x 4 for `TEXT` + 32), and the 1,024 reply.
    const bound = 128_000 + 64 * 100 + 512 + (4 + 8 + 32) + 1_024;
    assert.equal((await post(h, SELECT_ID)).status, 200);
    await h.flush();
    const run = () => caps.filter((cap) => !cap.sql.startsWith("EXPLAIN"));
    assert.deepEqual(run().map((cap) => cap.maxResponseBytes), [bound]);
    // The cost observation, after the response, reads its EXPLAIN reply under the same bound.
    assert.deepEqual(caps.filter((cap) => cap.sql.startsWith("EXPLAIN")).map((cap) => cap.maxResponseBytes), [bound]);
    // A keyed write: the lookup's cap derives from the hard maximum of maxResponseBytes, the
    // envelope's from the compiled statement, the idempotency INSERT has a small fixed one.
    caps.length = 0;
    const written = await post(h, [{ sql: "INSERT INTO projects(id,name) VALUES(:id,:name) RETURNING id", params: { id: uid(), name: "n" } }], "result-budget-key-0001");
    assert.equal(written.status, 200, JSON.stringify(written.body));
    await h.flush();
    const [lookup, envelope, insert, ...rest] = run();
    assert.equal(rest.length, 0, "lookup, envelope, idempotency insert");
    assert.equal(lookup.maxResponseBytes, LOOKUP_BYTES);
    // RETURNING id and the check column: two cells per row, and the two descriptors' metadata.
    assert.equal(envelope.maxResponseBytes, 128_000 + 64 * 100 * 2 + 512 + (4 + 8 + 32) + (2 * "__policysql_check".length + 32) + 1_024);
    assert.equal(insert.maxResponseBytes, 65_536);
  });

  test(`${ownerAdapter}: a reply over the read cap is 413 while it streams, and a reply of exactly the cap is served`, async (t) => {
    const h = await setup(t);
    let cap = 0;
    let mode = "exact";
    h.replaceDatabaseResponse(async ({ sqls, results, baton, requestBaton }) => {
      if (!sqls.some(isSelectId)) return null;
      const text = JSON.stringify({ baton, results });
      // Pad with JSON whitespace to exactly the cap, or one byte over it.
      const total = mode === "exact" ? cap : cap + 1;
      void requestBaton;
      return new Response(text + " ".repeat(total - new TextEncoder().encode(text).byteLength), { headers: { "content-type": "application/json" } });
    });
    // Learn the cap from the engine through a probing provider-free request: it is the bound of
    // `SELECT id` under these limits.
    cap = 128_000 + 64 * 100 + 512 + (4 + 8 + 32) + 1_024;
    const served = await post(h, SELECT_ID);
    assert.equal(served.status, 200, JSON.stringify(served.body).slice(0, 200));
    mode = "over";
    const over = await post(h, SELECT_ID);
    assert.equal(over.status, 413);
    assert.equal(over.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
    assert.equal(count(h, "seed"), 1);
  });

  test(`${ownerAdapter}: a response over maxResponseBytes is 413 before COMMIT: rolled back, no row, no idempotency record, and a retry runs again`, async (t) => {
    // Wide aliases make the response large (each statement's public column descriptors) while
    // the rows stay few and the result limit is far from reached.
    const alias = (statement, column) => `"${"c".repeat(40)}_${statement}_${column}"`;
    const wide = (statement) => ({
      sql: `SELECT ${Array.from({ length: 24 }, (_, column) => `id AS ${alias(statement, column)}`).join(", ")} FROM projects`, params: {},
    });
    const envelope = (id) => [
      { sql: "INSERT INTO projects(id,name) VALUES(:id,:name) RETURNING id", params: { id, name: "n" } },
      ...Array.from({ length: 7 }, (_, statement) => wide(statement)),
    ];
    // The response's size, from a run under a roomy limit (ids of equal length).
    const roomy = await setup(t, { maxResponseBytes: 589_824 });
    const probe = await post(roomy, envelope(uid()), "result-budget-key-0002");
    assert.equal(probe.status, 200, JSON.stringify(probe.body).slice(0, 300));
    const length = bodyBytes(probe.body);
    assert.ok(length > 40_000, `${length}`);
    // The limit is the response plus the 1,024-byte reserve, which must be at least maxResultBytes + 3,072.
    const at = length + 1_024;
    const resultBytes = 30_000;
    assert.ok(at >= resultBytes + 3_072);
    for (const [limit, status] of [[at, 200], [at - 1, 413]]) {
      const h = await setup(t, { maxResultBytes: resultBytes, maxResponseBytes: limit });
      const id = uid().replace(/^r/u, "q");
      const key = "result-budget-key-0003";
      const response = await post(h, envelope(id), key);
      assert.equal(response.status, status, `limit=${limit}: ${JSON.stringify(response.body).slice(0, 200)}`);
      if (status === 200) {
        assert.equal(count(h, id), 1);
        assert.equal(idempotencyRows(h), 1);
        continue;
      }
      assert.equal(response.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
      assert.equal(count(h, id), 0, "the insert was rolled back");
      assert.equal(idempotencyRows(h), 0, "no idempotency record survives");
      await h.flush();
      const inserts = () => h.events.filter((event) => event.sql.startsWith('INSERT INTO "projects"')).length;
      assert.equal(inserts(), 1);
      assert.equal(h.events.some((event) => event.sql === "COMMIT"), false, "no COMMIT was ever sent");
      // The retry is a new attempt: it looks up, finds nothing, runs the envelope again, and is refused the same way.
      const again = await post(h, envelope(id), key);
      assert.equal(again.status, 413);
      assert.equal(inserts(), 2, "the retry ran again");
      assert.equal(count(h, id), 0);
      assert.equal(idempotencyRows(h), 0);
    }
  });

  test(`${ownerAdapter}: a committed request replays after maxResponseBytes and maxResultBytes were lowered`, async (t) => {
    const limits = { ...BASE };
    const h = await harness(t, { ownerAdapter, fixture, hooks: false, runtimeLimits: limits });
    t.mock.method(console, "log", () => {});
    const id = uid();
    const insert = [{ sql: "INSERT INTO projects(id,name) VALUES(:id,:name) RETURNING id, name", params: { id, name: "n".repeat(500) } }];
    const key = "result-budget-key-0004";
    const first = await post(h, insert, key);
    assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 200));
    // The deployment lowers its limits: the stored response no longer fits either of them.
    limits.maxResultBytes = 100;
    limits.maxResponseBytes = 3_172;
    h.redeploy({ policyVersion: "policy_routing_lowered" });
    assert.equal(runtimeLimits(h.runtime).maxResponseBytes, 3_172);
    await h.flush();
    const before = h.events.length;
    const replay = await post(h, insert, key);
    assert.equal(replay.status, 200, JSON.stringify(replay.body).slice(0, 200));
    assert.deepEqual(replay.body.results, first.body.results);
    assert.equal(replay.body.transactionId, first.body.transactionId);
    assert.equal(h.events.slice(before).filter((event) => event.sql.startsWith('INSERT INTO "projects"')).length, 0, "nothing ran again");
    assert.equal(count(h, id), 1);
    // A new request under the lowered limits is judged by them.
    const refused = await post(h, [{ sql: "INSERT INTO projects(id,name) VALUES(:id,:name) RETURNING id, name", params: { id: uid(), name: "n".repeat(500) } }], "result-budget-key-0005");
    assert.equal(refused.status, 413);
  });

  test(`${ownerAdapter}: a stored response whose escapes double twice replays within the lookup bound`, async (t) => {
    // Quotes are escaped in the public JSON and again when the stored text is a Hrana string, so
    // a response near maxResponseBytes is nearly four times its characters in the lookup reply.
    const h = await setup(t, { maxResultBytes: 524_288, maxRequestBytes: 2_097_152 });
    const name = '"'.repeat(250_000);
    const insert = [{ sql: "INSERT INTO projects(id,name) VALUES(:id,:name) RETURNING id, name", params: { id: uid(), name } }];
    const key = "result-budget-key-0006";
    const first = await post(h, insert, key);
    assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 200));
    const stored = db(h).prepare("SELECT length(response_json) AS n FROM policysql_idempotency").get().n;
    assert.ok(stored > 500_000 && stored < 589_824, `${stored}`);
    const replay = await post(h, insert, key);
    assert.equal(replay.status, 200, JSON.stringify(replay.body).slice(0, 200));
    assert.equal(replay.body.results[0].rows[0].name, name);
  });

  test(`${ownerAdapter}: a row stored before the bounds existed is 413 before the fingerprint is compared, and nothing runs`, async (t) => {
    const h = await setup(t);
    const id = uid();
    const insert = [{ sql: "INSERT INTO projects(id,name) VALUES(:id,:name) RETURNING id", params: { id, name: "n" } }];
    const key = "result-budget-key-0007";
    assert.equal((await post(h, insert, key)).status, 200);
    // The stored response is larger than the lookup bound allows (the row of an earlier release).
    const huge = JSON.stringify({ padding: "x".repeat(LOOKUP_BYTES) });
    db(h).prepare("UPDATE policysql_idempotency SET response_json = ?").run(huge);
    await h.flush();
    const before = h.events.length;
    const retry = await post(h, insert, key);
    assert.equal(retry.status, 413);
    assert.equal(retry.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
    // Another body under the same key would be a conflict by fingerprint: the cap answers first.
    const other = await post(h, [{ sql: "INSERT INTO projects(id,name) VALUES(:id,:name) RETURNING id", params: { id: uid(), name: "another" } }], key);
    assert.equal(other.status, 413);
    await h.flush();
    assert.equal(h.events.slice(before).filter((event) => event.sql.startsWith('INSERT INTO "projects"')).length, 0, "nothing executed");
    assert.equal(count(h, id), 1);
  });

  test(`${ownerAdapter}: an interactive statement is bounded by its own compiled raw bound and by the 64 KiB transaction result limit`, async (t) => {
    const h = await setup(t);
    const begun = await h.request("a", "/v1/transactions", { mode: "read" }, null);
    assert.equal(begun.status, 201, JSON.stringify(begun.body));
    const path = `/v1/transactions/${begun.body.transactionId}/statements`;
    let cap = 0;
    h.replaceDatabaseResponse(async ({ sqls, results, baton }) => {
      if (!sqls.some(isSelectId)) return null;
      const text = JSON.stringify({ baton, results });
      return new Response(text + " ".repeat(cap + 1 - text.length), { headers: { "content-type": "application/json" } });
    });
    cap = 128_000 + 64 * 100 + 512 + (4 + 8 + 32) + 1_024;
    const refused = await h.request("a", path, { sequence: 1, ...SELECT_ID[0] }, null);
    assert.equal(refused.status, 413, JSON.stringify(refused.body).slice(0, 200));
    assert.equal(refused.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
  });
}

test("a database provider must declare streamedReadCap, and one that buffers is logged once above 64,000 result bytes", async (t) => {
  const provider = (extra = {}) => ({ check: () => true, connect: () => ({ begin: async () => {} }), ...extra });
  for (const bad of [undefined, "true", 1, null]) {
    assert.throws(() => validateDatabaseProvider(provider({ streamedReadCap: bad })), /streamedReadCap is required and must be a boolean/u);
  }
  validateDatabaseProvider(provider({ streamedReadCap: true }));
  validateDatabaseProvider(provider({ streamedReadCap: false }));
  // The engine logs `database_read_cap_unenforced` once per provider that buffers, when
  // maxResultBytes exceeds the reference wrapper's 64,000.
  const logged = [];
  for (const [streamed, maxResultBytes, expected] of [[false, 100_000, 1], [false, 64_000, 0], [true, 100_000, 0]]) {
    logged.length = 0;
    t.mock.method(console, "log", (line) => { logged.push(String(line)); });
    const h = await harness(t, {
      fixture, hooks: false, runtimeLimits: { ...BASE, maxResultBytes },
      customizeProvider: (base) => ({ ...base, streamedReadCap: streamed }),
    });
    for (let index = 0; index < 3; index++) {
      assert.equal((await h.request("a", EXECUTE, new RawJson(JSON.stringify({ statements: [{ sql: "SELECT id FROM projects", params: {} }] })), null)).status, 200);
    }
    const notices = logged.filter((line) => line.includes("database_read_cap_unenforced"));
    assert.equal(notices.length, expected, `${streamed} ${maxResultBytes}`);
    if (expected) assert.deepEqual(JSON.parse(notices[0]), { event: "database_read_cap_unenforced", maxResultBytes });
    t.mock.restoreAll();
  }
});

test("the reference wrapper sets the response limit explicitly, and the runtime reports it", () => {
  assert.equal(RUNTIME_LIMITS.maxResponseBytes, RUNTIME_LIMITS.maxResultBytes + 65_536);
  const runtime = new PolicySqlRuntime(
    read("bytes/catalog.yaml"), read("bytes/policy.yaml"), "s", "p",
    JSON.stringify({ max_rows: 1, max_result_bytes: 1, timeout_ms: 1, max_statements: 1 }),
  );
  try { assert.equal(runtimeLimits(runtime).maxResponseBytes, 1 + 65_536); } finally { runtime.free(); }
});

test("the Turso transport fails closed, before any request, without a valid read cap", async () => {
  const { TursoHttpTransport } = await import("../src/turso-http.ts");
  const sent = [];
  const transport = new TursoHttpTransport({ url: "https://db.test", authToken: "fixture" }, "cap", async (_url, init) => {
    const { requests } = JSON.parse(init.body);
    sent.push(requests[0].stmt?.sql ?? requests[0].type);
    const empty = { type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: 0, rows_read: 0, rows_written: 0, query_duration_ms: 0 } } };
    return Response.json({ baton: "b", results: requests.map(() => empty) });
  });
  const transaction = await transport.begin("read", 1_000, undefined, { maxBytesPerValue: 262_144 });
  for (const bad of [undefined, {}, { maxResponseBytes: 0 }, { maxResponseBytes: -1 }, { maxResponseBytes: 1.5 }, { maxResponseBytes: "100" }, { maxResponseBytes: Number.POSITIVE_INFINITY }]) {
    await assert.rejects(transaction.execute([{ sql: "SELECT 1" }], bad), (error) => error.code === "POLICYSQL_DATABASE_UNAVAILABLE", JSON.stringify(bad));
  }
  assert.deepEqual(sent, ["BEGIN DEFERRED"], "nothing was sent for an unbounded read");
  assert.equal(transaction.open, true, "the stream is still usable");
  await transaction.execute([{ sql: "SELECT 1" }], { maxResponseBytes: 4_096 });
  assert.deepEqual(sent, ["BEGIN DEFERRED", "SELECT 1"]);
  // A reply of one byte over the cap is a limit, and one of exactly the cap is read.
  const text = JSON.stringify({ baton: "b", results: [{ type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: 0, rows_read: 0, rows_written: 0, query_duration_ms: 0 } } }] });
  const exact = new TextEncoder().encode(text).byteLength;
  for (const [cap, outcome] of [[exact, "served"], [exact - 1, "limit"]]) {
    const t = new TursoHttpTransport({ url: "https://db.test", authToken: "fixture" }, "cap", async (_url, init) => {
      const { requests } = JSON.parse(init.body);
      return requests[0].stmt?.sql.startsWith("BEGIN")
        ? Response.json({ baton: "b", results: [{ type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: 0, rows_read: 0, rows_written: 0, query_duration_ms: 0 } } }] })
        : new Response(text);
    });
    const open = await t.begin("read", 1_000, undefined, { maxBytesPerValue: 262_144 });
    const run = open.execute([{ sql: "SELECT 1" }], { maxResponseBytes: cap });
    if (outcome === "served") await run;
    else await assert.rejects(run, (error) => error.code === "POLICYSQL_LIMIT_EXCEEDED");
  }
});
