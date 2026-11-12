// `error.detail.limit` of the three limit codes (#145 pull request F), end to end on both
// TransactionOwner adapters: each limit crossed names its Capabilities key, and the key resolves to
// the number that was configured; the answer holds the name and no number; a client's own words
// never choose the name; the name is the same for two databases that differ only in rows the role
// cannot see; and a bound without a Capabilities key carries none.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bodyTooLarge } from "../src/request-body.ts";
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
const SELECT_ID = { sql: "SELECT id FROM projects", params: {} };

test("the request body's own refusal names maxRequestBytes and is frozen", () => {
  const error = bodyTooLarge();
  assert.equal(error.code, "POLICYSQL_REQUEST_TOO_LARGE");
  assert.deepEqual(error.detail, { limit: "maxRequestBytes" });
  assert.ok(Object.isFrozen(error.detail));
});

for (const ownerAdapter of OWNER_ADAPTERS) {
  const setup = (t, limits = {}) => {
    t.mock.method(console, "log", () => {});
    return harness(t, { ownerAdapter, fixture, hooks: false, runtimeLimits: { ...BASE, ...limits } });
  };
  const post = (h, statements, extra = {}) => h.request("a", EXECUTE, new RawJson(JSON.stringify({ statements, ...extra })), null);
  const capabilities = async (h) => (await h.request("a", "/v1/capabilities", undefined, null)).body;
  const db = (h) => h.databases.get("a").database;
  const insertRows = (h, count, { tenant = "tenant_a", name = "n", prefix = "x", state = null, privateState = Buffer.from([255]) } = {}) => {
    const insert = db(h).prepare("INSERT INTO projects(id,tenant_id,name,state,seed,private_state) VALUES(?,?,?,?,?,?)");
    for (let index = 0; index < count; index++) insert.run(`${prefix}${String(index).padStart(6, "0")}`, tenant, name, state, Buffer.alloc(0), privateState);
  };
  const refusal = (response, status, code, detail, path = null) => {
    assert.equal(response.status, status, JSON.stringify(response.body).slice(0, 300));
    assert.equal(response.body.error.code, code);
    assert.equal(response.body.error.path, path);
    assert.deepEqual(response.body.error.detail, detail);
  };

  test(`${ownerAdapter}: each limit a request crosses names its Capabilities key, and the key holds the configured number`, async (t) => {
    const cases = [
      ["maxStatements", { maxStatements: 1 }, [SELECT_ID, SELECT_ID], {}, "POLICYSQL_LIMIT_EXCEEDED", null],
      ["maxProjections", { maxProjections: 1 }, [{ sql: "SELECT id, name FROM projects", params: {} }], {}, "POLICYSQL_LIMIT_EXCEEDED", "/statements/0"],
      ["maxParameters", { maxParameters: 1 }, [{ sql: "SELECT id FROM projects WHERE id = :a OR id = :b", params: { a: "x", b: "y" } }], {}, "POLICYSQL_LIMIT_EXCEEDED", "/statements/0"],
      ["maxSqlBytes", { maxSqlBytes: 1_024 }, [{ sql: `SELECT id FROM projects WHERE name = '${"a".repeat(1_100)}'`, params: {} }], {}, "POLICYSQL_REQUEST_TOO_LARGE", "/statements/0/sql"],
      ["maxRequestBytes", { maxRequestBytes: 65_536 }, [SELECT_ID], { pad: "x".repeat(70_000) }, "POLICYSQL_REQUEST_TOO_LARGE", null],
      ["maxJsonValues", { maxJsonValues: 1_024 }, [SELECT_ID], { pad: Array.from({ length: 1_100 }, () => 0) }, "POLICYSQL_REQUEST_TOO_LARGE", null],
      ["maxBytesPerValue", { maxBytesPerValue: 4 }, [{
        sql: "INSERT INTO projects(id,name,state) VALUES(:id,:name,:state) RETURNING id",
        params: { id: "p", name: "n", state: Buffer.alloc(5).toString("base64") },
      }], {}, "POLICYSQL_LIMIT_EXCEEDED", "/statements/0"],
    ];
    for (const [name, limits, statements, extra, code, path] of cases) {
      const h = await setup(t, limits);
      const response = await post(h, statements, extra);
      // A statement's refusal carries its pointer; the request's carries none.
      refusal(response, 413, code, { limit: name }, path);
      // The name resolves to the number that was configured.
      assert.equal((await capabilities(h)).limits[name], limits[name], name);
    }
  });

  test(`${ownerAdapter}: a result limit names its key, whichever of the rows and the bytes was crossed`, async (t) => {
    const rows = await setup(t, { maxRows: 3 });
    insertRows(rows, 3);
    refusal(await post(rows, [SELECT_ID]), 413, "POLICYSQL_LIMIT_EXCEEDED", { limit: "maxRows" }, "/statements/0");
    assert.equal((await capabilities(rows)).limits.maxRows, 3);
    const probe = await setup(t);
    insertRows(probe, 5);
    const probed = await post(probe, [SELECT_ID]);
    assert.equal(probed.status, 200);
    const bytes = new TextEncoder().encode(JSON.stringify(probed.body.results[0].rows)).byteLength;
    const tight = await setup(t, { maxResultBytes: bytes - 1 });
    insertRows(tight, 5);
    refusal(await post(tight, [SELECT_ID]), 413, "POLICYSQL_LIMIT_EXCEEDED", { limit: "maxResultBytes" });
    assert.equal((await capabilities(tight)).limits.maxResultBytes, bytes - 1);
  });

  test(`${ownerAdapter}: the answer holds the name and none of the configured numbers`, async (t) => {
    const h = await setup(t, { maxRows: 7, maxSqlBytes: 1_777, maxResultBytes: 7_777 });
    insertRows(h, 7);
    for (const [response, limit] of [
      [await post(h, [SELECT_ID]), "maxRows"],
      [await post(h, [{ sql: `SELECT id FROM projects WHERE name = '${"a".repeat(1_800)}'`, params: {} }]), "maxSqlBytes"],
    ]) {
      assert.equal(response.status, 413);
      assert.deepEqual(Object.keys(response.body.error.detail), ["limit"]);
      assert.equal(response.body.error.detail.limit, limit);
      const { requestId: _requestId, ...rest } = response.body.error;
      const text = JSON.stringify(rest);
      for (const needle of ["7777", "1777", "limits", "transactions"]) assert.equal(text.includes(needle), false, `${needle}: ${text}`);
    }
  });

  test(`${ownerAdapter}: a client's own words never choose the name`, async (t) => {
    const h = await setup(t, { maxParameters: 1 });
    const response = await post(h, [{
      sql: "SELECT id FROM projects /* maxSqlBytes */ WHERE id = :max_rows OR id = :max_joins",
      params: { max_rows: "x", max_joins: "y" },
    }]);
    refusal(response, 413, "POLICYSQL_LIMIT_EXCEEDED", { limit: "maxParameters" }, "/statements/0");
  });

  // What a client can read of a statement: the status, the error (name and path included) and the
  // rows. Two databases that differ only in what the role cannot see must give the same.
  const outcome = (response) => ({
    status: response.status, error: response.body.error ? { ...response.body.error, requestId: undefined } : undefined,
    rows: response.body.results?.map((result) => result.rows),
    redactions: response.body.results?.map((result) => result.meta?.result?.redactions),
  });
  const BIG = 200_000;

  test(`${ownerAdapter}: rows the role cannot see never change the name or the outcome`, async (t) => {
    // Two databases that differ only in rows of another tenant: none, and many large ones, with a
    // large name and a large BLOB in the columns the statement projects.
    const make = async (hidden, limits) => {
      const h = await setup(t, limits);
      if (hidden) insertRows(h, 40, { tenant: "another_tenant", name: "h".repeat(2_000), prefix: "h", state: Buffer.alloc(BIG, 9) });
      return h;
    };
    // The visible rows: the seed and `visible` more.
    for (const [label, sql, limits, visible, expected] of [
      ["within the limits", "SELECT id FROM projects", { maxRows: 3 }, 2, { status: 200 }],
      ["over maxRows", "SELECT id FROM projects", { maxRows: 3 }, 3, { status: 413, detail: { limit: "maxRows" } }],
      ["over maxResultBytes only", "SELECT id FROM projects", { maxResultBytes: 40 }, 2, { status: 413, detail: { limit: "maxResultBytes" } }],
      ["name and BLOB projected, within the limits", "SELECT id, name, state FROM projects", {}, 2, { status: 200 }],
      ["name and BLOB projected, over maxRows", "SELECT id, name, state FROM projects", { maxRows: 3 }, 3, { status: 413, detail: { limit: "maxRows" } }],
      ["name and BLOB projected, over maxResultBytes", "SELECT id, name, state FROM projects", { maxResultBytes: 100 }, 2, { status: 413, detail: { limit: "maxResultBytes" } }],
    ]) {
      const answers = [];
      for (const hidden of [false, true]) {
        const h = await make(hidden, limits);
        insertRows(h, visible);
        answers.push(outcome(await post(h, [{ sql, params: {} }])));
      }
      assert.deepEqual(answers[0], answers[1], label);
      assert.equal(answers[0].status, expected.status, label);
      assert.deepEqual(answers[0].error?.detail, expected.detail, label);
    }
  });

  // A conditional column's value is NULL on the rows where its condition is false, so the cell a
  // client reads (and the limits that count it) is the same whatever the hidden value was.
  test(`${ownerAdapter}: the hidden cell of a conditional column never changes the name or the outcome`, async (t) => {
    const sql = "SELECT id, private_state FROM projects";
    // The visible rows are named `n`, so `private_state` is hidden on them (the seed row is named
    // `visible` and shows its value in both databases).
    for (const [label, limits, visible, expected] of [
      ["within the limits", {}, 2, { status: 200 }],
      ["a small value limit", { maxBytesPerValue: 8 }, 2, { status: 200 }],
      ["over maxRows", { maxRows: 2 }, 3, { status: 413, detail: { limit: "maxRows" } }],
      ["over maxResultBytes", { maxResultBytes: 60 }, 2, { status: 413, detail: { limit: "maxResultBytes" } }],
    ]) {
      const answers = [];
      for (const big of [false, true]) {
        const h = await setup(t, limits);
        insertRows(h, visible, { privateState: big ? Buffer.alloc(BIG, 7) : Buffer.from([1]) });
        answers.push(outcome(await post(h, [{ sql, params: {} }])));
      }
      assert.deepEqual(answers[0], answers[1], label);
      assert.equal(answers[0].status, expected.status, `${label}: ${JSON.stringify(answers[0]).slice(0, 300)}`);
      assert.deepEqual(answers[0].error?.detail, expected.detail, label);
    }
  });
}
