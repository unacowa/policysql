import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { harness } from "./helpers/routing.mjs";

// NULL named parameters in direct nullable assignments (#20), through the trusted session,
// real WASM, the HTTP transport and SQLite. The same cases run natively in
// crates/policysql-wasm/src/nullable_tests.rs.
const read = name => readFileSync(new URL(`../../../tests/fixtures/nullable/${name}`, import.meta.url), "utf8");
const cases = JSON.parse(read("cases.json"));
const fixture = {
  catalog: read("catalog.yaml"), policy: read("policy.yaml"),
  schema: read("schema.sql"), physicalSchema: read("physical-schema.json"),
  seed(db, tenant) {
    const insert = db.prepare("INSERT INTO nullabletexts(id,tenant_id,label,state,note,amount,count,flag,meta,payload,due,secret,owner) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    insert.run("target", `tenant_${tenant}`, "visible", "keep", "keep note", 12.5, 7, 1, '{"a":1}', Buffer.from([0, 255]), "2026-10-29", "secret", `tenant_${tenant}`);
    insert.run("hidden", "another_tenant", "hidden", "keep", "keep note", 12.5, 7, 1, '{"a":1}', Buffer.from([0, 255]), "2026-10-29", "secret", "another_tenant");
  },
  callbackQuery: { sql: "SELECT id,state FROM nullabletexts WHERE state IS NULL", params: {} },
};
const CHECK = "check: { tenant_id: { eq: { session: tenant_id } } }";
const execute = (h, statements, key = null) => h.request("a", "/v1/transactions:execute", { statements }, key);
const explain = (h, statements) => h.request("a", "/v1/transactions:explain", { statements }, null);
// The issue's example, verbatim apart from the role name.
const issueUpdate = (id = "target") => ({
  sql: "UPDATE nullabletexts SET state=:value WHERE id=:id RETURNING state",
  params: { id, value: null },
  expect: { affectedRows: 1 },
});
const issueInsert = id => ({ sql: "INSERT INTO nullabletexts(id,state) VALUES(:id,:value) RETURNING id,state,owner", params: { id, value: null } });
const TYPED = ["state", "note", "amount", "count", "flag", "meta", "payload", "due"];
const clearAll = (id = "target") => ({
  sql: "UPDATE nullabletexts SET state=:text,note=:text,amount=:number,count=:integer,flag=:boolean,meta=:json,payload=:bytes,due=:date WHERE id=:id RETURNING state,note,amount,count,flag,meta,payload,due",
  params: { id, text: null, number: null, integer: null, boolean: null, json: null, bytes: null, date: null },
  expect: { affectedRows: 1 },
});
const physical = (h, id) => h.databases.get("a").database.prepare(
  `SELECT ${TYPED.join(",")},label,owner,${TYPED.map(c => `typeof(${c}) AS ${c}_storage`).join(",")} FROM nullabletexts WHERE id=?`,
).get(id);
const allNull = Object.fromEntries(TYPED.map(c => [c, null]));

for (const hooks of [false, true]) test(`nullable writes round-trip through the trusted session, WASM, HTTP and SQLite (hooks=${hooks})`, async t => {
  const h = await harness(t, { hooks, fixture });
  const statements = [issueInsert("inserted"), issueUpdate(), clearAll()];
  const first = await execute(h, statements, "nullable-roundtrip-123");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.results[0].rows, [{ id: "inserted", state: null, owner: "tenant_a" }], "server preset still applies");
  assert.deepEqual(first.body.results[1].rows, [{ state: null }]);
  assert.deepEqual(first.body.results[2].rows, [allNull]);
  for (const result of first.body.results) {
    assert.deepEqual(result.meta.result.redactions, []);
    for (const column of result.meta.result.columns.filter(c => TYPED.includes(c.name))) assert.equal(column.nullable, true);
  }
  assert.equal(physical(h, "inserted").state_storage, "null");
  const stored = physical(h, "target");
  for (const column of TYPED) assert.equal(stored[`${column}_storage`], "null", column);
  assert.equal(stored.owner, "tenant_a");

  const writes = () => h.events.filter(e => /^(INSERT INTO|UPDATE) "nullabletexts"/.test(e.sql)).length;
  const before = writes();
  const replay = await execute(h, statements, "nullable-roundtrip-123");
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body.results, first.body.results, "NULL results replay with their identity");
  assert.equal(writes(), before, "replay must not execute writes again");
  assert.equal((await execute(h, [issueInsert("different")], "nullable-roundtrip-123")).status, 409);

  const selected = await execute(h, [{ sql: "SELECT id,state,amount FROM nullabletexts WHERE state IS NULL ORDER BY id", params: {} }]);
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  const oracle = new DatabaseSync(":memory:");
  t.after(() => oracle.close());
  oracle.exec(fixture.schema);
  fixture.seed(oracle, "a");
  oracle.prepare("INSERT INTO nullabletexts(id,tenant_id,state,owner) VALUES(?,?,?,?)").run("inserted", "tenant_a", null, "tenant_a");
  oracle.prepare(`UPDATE nullabletexts SET ${TYPED.map(c => `${c}=NULL`).join(",")} WHERE id=? AND tenant_id=?`).run("target", "tenant_a");
  const expected = oracle.prepare("SELECT id,state,amount FROM nullabletexts WHERE state IS NULL AND tenant_id=? ORDER BY id")
    .all("tenant_a").map(row => ({ ...row }));
  assert.deepEqual(selected.body.results[0].rows, expected, "protected execution agrees with independent SQLite writes and SELECT");

  // NULL, empty string, 0 and false stay distinct, and NULL can be replaced again.
  const restore = await execute(h, [{
    sql: "UPDATE nullabletexts SET state=:text,count=:integer,flag=:boolean,payload=:bytes WHERE id=:id RETURNING state,count,flag,payload",
    params: { id: "target", text: "", integer: 0, boolean: false, bytes: "" },
  }]);
  assert.equal(restore.status, 200, JSON.stringify(restore.body));
  assert.deepEqual(restore.body.results[0].rows, [{ state: "", count: 0, flag: false, payload: "" }]);
  const restored = physical(h, "target");
  assert.deepEqual([restored.state_storage, restored.count_storage, restored.flag_storage, restored.payload_storage], ["text", "integer", "integer", "blob"]);
  assert.equal((await execute(h, [clearAll()])).status, 200);

  const deniedTenant = await execute(h, [{ ...issueUpdate("hidden"), expect: { affectedRows: 0 } }]);
  assert.equal(deniedTenant.status, 200, JSON.stringify(deniedTenant.body));
  assert.equal(deniedTenant.body.results[0].affectedRows, 0);
  assert.equal(h.databases.get("a").database.prepare("SELECT state FROM nullabletexts WHERE id='hidden'").get().state, "keep");
  if (hooks) assert.ok(h.hooksSeen.some(c => c.status === 200 && c.result.rows.some(r => r.id === "inserted" && r.state === null)));
});

test("NULL outside proven nullable assignments is denied before database egress", async t => {
  const h = await harness(t, { hooks: false, fixture });
  for (const { accepted, nullable, ...statement } of cases) {
    if (accepted) continue;
    const result = await execute(h, [statement]);
    assert.ok([400, 403].includes(result.status), `${statement.sql}: ${JSON.stringify(result)}`);
    if (nullable) assert.equal(result.body.error.code, "POLICYSQL_INVALID_PARAMETER", statement.sql);
    assert.equal(h.events.length, 0, statement.sql);
    assert.equal(h.counts().connects, 0, statement.sql);
  }
});

test("all positive NULL fixtures execute, including one parameter across rows and columns", async t => {
  const h = await harness(t, { hooks: false, fixture });
  for (const { accepted, nullable: _nullable, ...statement } of cases) {
    if (!accepted) continue;
    const result = await execute(h, [statement]);
    assert.equal(result.status, 200, `${statement.sql}: ${JSON.stringify(result.body)}`);
  }
  for (const id of ["row1", "row2"]) {
    assert.equal(physical(h, id).state_storage, "null");
    assert.equal(physical(h, id).note_storage, "null");
  }
});

test("Explain nullable metadata matches what Execute accepts, for every type and sample", async t => {
  const h = await harness(t, { hooks: false, fixture });
  for (const { accepted, nullable, sql, params } of cases) {
    if (!nullable) continue;
    const samples = accepted ? [{}, params] : [{}];
    for (const sample of samples) {
      const result = await explain(h, [{ sql, params: sample }]);
      assert.equal(result.status, 200, `${sql}: ${JSON.stringify(result.body)}`);
      const advertised = Object.fromEntries(result.body.statements[0].parameters.map(p => [p.name, p.nullable]));
      assert.deepEqual(advertised, nullable, sql);
    }
    if (!accepted) {
      // A NULL sample that Execute rejects is rejected by Explain the same way.
      const rejected = await explain(h, [{ sql, params }]);
      assert.equal(rejected.status, 400, sql);
      assert.equal(rejected.body.error.code, "POLICYSQL_INVALID_PARAMETER", sql);
    }
  }
  const typed = await explain(h, [{ ...clearAll(), expect: undefined }]);
  assert.equal(typed.status, 200, JSON.stringify(typed.body));
  const byName = Object.fromEntries(typed.body.statements[0].parameters.map(p => [p.name, p]));
  assert.deepEqual(byName.bytes, { name: "bytes", type: "bytes", representation: "string", format: "base64", nullable: true });
  assert.deepEqual(byName.json, { name: "json", type: "json", representation: "object", nullable: true });
  assert.deepEqual(byName.integer, { name: "integer", type: "integer", representation: "number", nullable: true });
  assert.deepEqual(byName.date, { name: "date", type: "date", representation: "string", format: "iso-date", nullable: true });
  // A real date sample, or NULL, yields the same descriptor as type discovery.
  for (const date of ["2026-10-30", null]) {
    const sampled = await explain(h, [{ ...clearAll(), params: { ...clearAll().params, date }, expect: undefined }]);
    assert.equal(sampled.status, 200, JSON.stringify(sampled.body));
    assert.deepEqual(sampled.body.statements[0].parameters.find(p => p.name === "date"), byName.date);
  }
  assert.equal(byName.id.nullable, false);
  assert.equal(h.counts().connects, 0);
});

for (const hooks of [false, true]) test(`post-state FALSE/UNKNOWN, physical constraints, triggers and later failures roll back NULL writes (hooks=${hooks})`, async t => {
  const outcomes = {};
  for (const failure of ["false", "unknown", "not_null", "trigger", "later"]) {
    const changed = { ...fixture };
    if (failure === "not_null") changed.schema = fixture.schema.replace("state TEXT,", "state TEXT NOT NULL,");
    if (failure === "trigger") changed.schema += "CREATE TRIGGER reject_null BEFORE UPDATE OF state ON nullabletexts WHEN NEW.state IS NULL BEGIN SELECT RAISE(ABORT, 'private trigger detail'); END;";
    const h = await harness(t, {
      hooks, fixture: changed,
      // UNKNOWN: `state <> 'blocked'` is neither TRUE nor FALSE for NULL and must fail.
      customizePolicy: policy => failure === "false"
        ? policy.replaceAll(CHECK, "check: { state: { is_null: false } }")
        : failure === "unknown" ? policy.replaceAll(CHECK, "check: { state: { neq: blocked } }") : policy,
    });
    const before = { ...physical(h, "target") };
    const prior = { sql: "UPDATE nullabletexts SET label=:label WHERE id=:id", params: { label: "changed", id: "target" }, expect: { affectedRows: 1 } };
    const statements = [prior, clearAll()];
    if (failure === "later") statements.push({ sql: "SELECT id FROM nullabletexts WHERE id=:id", params: { id: "target" }, expect: { rowCount: 0 } });
    const result = await execute(h, statements);
    assert.ok(result.status >= 400, `${failure}: ${JSON.stringify(result)}`);
    outcomes[failure] = { status: result.status, code: result.body.error?.code };
    assert.equal(result.body.results, undefined);
    assert.ok(!JSON.stringify(result.body).includes("private trigger detail"));
    assert.deepEqual({ ...physical(h, "target") }, before, failure);
    assert.equal(physical(h, "target").label, "visible", `${failure}: earlier write rolled back`);
    assert.ok(h.events.some(e => e.sql === "ROLLBACK"), failure);
  }
  // A NULL that makes the check UNKNOWN is indistinguishable from a FALSE check.
  assert.deepEqual(outcomes.unknown, outcomes.false);
  // Regression pin of the current public error classes (#27 review). A failed
  // post-state check is reported as a schema mismatch; physical NOT NULL and
  // trigger failures surface as the database error class without details.
  assert.deepEqual(outcomes, {
    false: { status: 422, code: "POLICYSQL_SCHEMA_MISMATCH" },
    unknown: { status: 422, code: "POLICYSQL_SCHEMA_MISMATCH" },
    not_null: { status: 503, code: "POLICYSQL_DATABASE_UNAVAILABLE" },
    trigger: { status: 503, code: "POLICYSQL_DATABASE_UNAVAILABLE" },
    later: { status: 422, code: "POLICYSQL_EXPECTATION_FAILED" },
  });
});

test("a post-state check that is TRUE for NULL still commits the NULL", async t => {
  const h = await harness(t, { hooks: false, fixture, customizePolicy: policy => policy.replaceAll(CHECK, "check: { state: { is_null: true } }") });
  const result = await execute(h, [issueUpdate()]);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.results[0].meta.mutation.operationCheck, "passed");
  assert.equal(physical(h, "target").state_storage, "null");
});

test("interactive NULL results replay and transaction rollback restores the original values", async t => {
  const h = await harness(t, { hooks: true, fixture });
  const begun = await h.request("a", "/v1/transactions", { mode: "write" }, null);
  assert.equal(begun.status, 201, JSON.stringify(begun.body));
  const path = `/v1/transactions/${begun.body.transactionId}`;
  const { expect: _expect, ...statement } = clearAll();
  const command = { sequence: 1, ...statement };
  const first = await h.request("a", `${path}/statements`, command, null);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.result.rows, [allNull]);
  assert.deepEqual((await h.request("a", `${path}/statements`, command, null)).body, first.body);
  assert.equal((await h.request("a", `${path}/rollback`, { sequence: 2 }, null)).status, 200);
  assert.equal(physical(h, "target").state, "keep");
  assert.equal(physical(h, "target").payload_storage, "blob");
});
