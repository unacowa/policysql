import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { harness } from "./helpers/routing.mjs";
import { MAX_BYTES_PER_VALUE, decodeBlob, encodeBlob } from "../src/binary.ts";
import { driverArgs, rawDriverValue, rowValues } from "../src/driver-values.ts";

const read = name => readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url), "utf8");
const cases = JSON.parse(read("bytes-contract.json"));
const fixture = {
  catalog: read("bytes/catalog.yaml"), policy: read("bytes/policy.yaml"),
  schema: read("bytes/schema.sql"), physicalSchema: read("bytes/physical-schema.json"),
  seed(db, tenant) {
    const insert = db.prepare("INSERT INTO projects(id,tenant_id,name,state,seed) VALUES(?,?,?,?,?)");
    insert.run("seed", `tenant_${tenant}`, "visible", Buffer.from([0, 1, 2, 255]), Buffer.alloc(0));
    insert.run("hidden", "another_tenant", "hidden", Buffer.from([0, 1, 2, 255]), Buffer.alloc(0));
  },
  callbackQuery: { sql: "SELECT id,state,seed FROM projects WHERE state=:state", params: { state: "AAEC/w==" } },
};
const insert = (id, state, returning = " RETURNING id,name,state,seed,metadata") => ({
  sql: `INSERT INTO projects(id,name,state,metadata) VALUES(:id,:name,:state,:metadata)${returning}`,
  params: { id, name: "AAEC/w==", state, metadata: [0, 1, 2, 255] },
});
const execute = (h, statements, key = null) => h.request("a", "/v1/transactions:execute", { statements }, key);
const hash = value => createHash("sha256").update(value).digest("hex");
const physical = (h, id) => h.databases.get("a").database.prepare("SELECT *,typeof(state) AS storage,typeof(seed) AS preset_storage FROM projects WHERE id=?").get(id);

test("private binary adapters share strict vectors and preserve physical value identity", () => {
  for (const { base64, bytes } of cases.valid) {
    assert.deepEqual([...decodeBlob(base64)], bytes);
    assert.equal(encodeBlob(Uint8Array.from(bytes)), base64);
    const args = driverArgs({ clientParameters: { data: { type: "blob", base64 }, text: base64 }, serverParameters: { preset: { type: "blob", base64 } } });
    assert.deepEqual([...args.data], bytes);
    assert.deepEqual([...args.preset], bytes);
    assert.equal(args.text, base64);
    assert.deepEqual(rawDriverValue(args.data), { type: "blob", base64 });
  }
  for (const value of [...cases.invalid, ...cases.wrongTypes]) assert.throws(() => decodeBlob(value));
  for (const value of [{ type: "blob", base64: "AA==" }, [0], {}, new ArrayBuffer(1), NaN, Infinity, undefined]) {
    assert.throws(() => rawDriverValue(value), { code: "POLICYSQL_SCHEMA_MISMATCH" });
  }
  assert.throws(() => driverArgs({ clientParameters: { x: "AA==" }, serverParameters: { x: "AA==" } }), { code: "POLICYSQL_INTERNAL" });
  assert.throws(() => decodeBlob(Buffer.alloc(MAX_BYTES_PER_VALUE + 1).toString("base64")));
  for (const row of [[], new Array(1), {}, { unrelated: null }, [null, null]]) {
    assert.throws(() => rowValues(["state"], row), { code: "POLICYSQL_SCHEMA_MISMATCH" });
  }
  assert.deepEqual(rowValues(["state"], { 0: null, state: "must not replace NULL" }), [null]);
});

for (const hooks of [false, true]) test(`bytes round-trip with JWT, real WASM, HTTP transport, SQLite, presets and replay (hooks=${hooks})`, async t => {
  const h = await harness(t, { hooks, fixture });
  const values = [...cases.valid.map(c => c.base64), null];
  const statements = values.map((value, i) => insert(`bytes_${i}`, value));
  const first = await execute(h, statements, "bytes-roundtrip-123456");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  for (const [i, value] of values.entries()) {
    const row = first.body.results[i].rows[0];
    assert.equal(row.state, value);
    assert.equal(row.seed, "AAEC/w==");
    assert.equal(row.name, "AAEC/w==", "ordinary TEXT remains TEXT");
    assert.deepEqual(row.metadata, [0, 1, 2, 255], "JSON arrays remain JSON");
    const descriptor = first.body.results[i].meta.result.columns.find(c => c.name === "state");
    assert.deepEqual({ type: descriptor.type, representation: descriptor.representation, format: descriptor.format, nullable: descriptor.nullable }, { type: "bytes", representation: "string", format: "base64", nullable: true });
    const stored = physical(h, `bytes_${i}`);
    assert.equal(stored.storage, value === null ? "null" : "blob");
    assert.equal(stored.preset_storage, "blob");
    if (value !== null) assert.equal(hash(stored.state), hash(Buffer.from(value, "base64")));
    assert.equal(hash(stored.seed), hash(Buffer.from("AAEC/w==", "base64")));
  }
  const writes = () => h.events.filter(e => /^INSERT INTO "projects"/.test(e.sql)).length;
  const before = writes();
  const replay = await execute(h, statements, "bytes-roundtrip-123456");
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.results, first.body.results);
  assert.equal(writes(), before);
  assert.equal((await execute(h, [insert("changed", "AA==")], "bytes-roundtrip-123456")).status, 409);

  const updated = await execute(h, [{ sql: "UPDATE projects SET state=:state WHERE id=:id RETURNING state,seed", params: { state: "/wA=", id: "bytes_0" } }]);
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body.results[0].rows, [{ state: "/wA=", seed: "/wA=" }]);
  const selected = await execute(h, [{ sql: "SELECT id,state FROM projects WHERE state=:state ORDER BY id", params: { state: "AAEC/w==" } }]);
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  const reference = h.databases.get("a").database.prepare("SELECT id,state FROM projects WHERE tenant_id=? AND state=? ORDER BY id")
    .all("tenant_a", Buffer.from([0, 1, 2, 255])).map(row => ({ id: row.id, state: Buffer.from(row.state).toString("base64") }));
  assert.deepEqual(selected.body.results[0].rows, reference, "independent SQLite oracle agrees with protected query");
  assert.ok(!selected.body.results[0].rows.some(r => r.id === "hidden"));
  const hidden = await execute(h, [{ sql: "UPDATE projects SET state=:state WHERE id=:id RETURNING state", params: { state: "", id: "hidden" } }]);
  assert.equal(hidden.body.results[0].affectedRows, 0);
  assert.equal(Buffer.from(physical(h, "hidden").state).toString("base64"), "AAEC/w==");
  if (hooks) assert.ok(h.hooksSeen.some(c => c.status === 200 && c.result.rows.some(r => r.state === "AAEC/w==")));
  await h.flush();
  assert.ok(h.events.some(e => e.sql.startsWith("EXPLAIN QUERY PLAN") && e.args.some(a => a.value.type === "blob")), "cost path uses the same typed driver binding");
});

test("malformed bytes, namespace spoofing, forbidden columns and mixed parameter types deny before database egress", async t => {
  const h = await harness(t, { hooks: false, fixture });
  const denied = [...cases.invalid, ...cases.wrongTypes].map(value => insert("invalid", value));
  denied.push(
    { sql: "INSERT INTO projects(id,name,state,seed) VALUES(:id,:name,:state,:seed)", params: { id: "x", name: "x", state: "", seed: "AA==" } },
    { sql: "UPDATE projects SET seed=:seed WHERE id=:id", params: { seed: "AA==", id: "seed" } },
    { sql: "SELECT forbidden FROM projects", params: {} },
    { sql: "SELECT id FROM projects WHERE forbidden=:state", params: { state: "AA==" } },
    { sql: "SELECT id FROM projects ORDER BY forbidden", params: {} },
    insert("x", "", " RETURNING forbidden"),
    { sql: "SELECT id FROM projects WHERE private_state=:state", params: { state: "/w==" } },
    { sql: "SELECT id FROM projects WHERE state=:value AND name=:value", params: { value: "AA==" } },
    { sql: "SELECT id FROM projects WHERE state=:__policysql_literal_0", params: { __policysql_literal_0: "AA==" } },
    { sql: "SELECT CAST(state AS BLOB) AS state FROM projects", params: {} },
    { ...insert("x", ""), params: { ...insert("x", "").params, __policysql_literal_0: "AA==" } },
  );
  for (const statement of denied) {
    const result = await execute(h, [statement]);
    assert.ok([400, 403].includes(result.status), JSON.stringify(result));
    assert.equal(h.events.length, 0);
    assert.equal(h.counts().connects, 0);
  }
  const oversized = await execute(h, [insert("too-large", Buffer.alloc(MAX_BYTES_PER_VALUE + 1).toString("base64"))]);
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
  assert.equal(h.counts().connects, 0);
});

test("physical TEXT never satisfies a bytes result; conditional bytes redact without leakage", async t => {
  const h = await harness(t, { hooks: false, fixture });
  const masked = await execute(h, [{ sql: "SELECT id,private_state AS private FROM projects ORDER BY id", params: {} }]);
  assert.deepEqual(masked.body.results[0].rows, [{ id: "seed", private: "/w==" }]);
  h.databases.get("a").database.prepare("UPDATE projects SET name=? WHERE id='seed'").run("denied");
  const redacted = await execute(h, [{ sql: "SELECT private_state AS private FROM projects", params: {} }]);
  assert.deepEqual(redacted.body.results[0].rows, [{ private: null }]);
  assert.deepEqual(redacted.body.results[0].meta.result.redactions, [{ row: 0, column: "private", code: "POLICY_REDACTED" }]);
  for (const value of ["AAEC/w==", "", "[0,1,2,255]"]) {
    h.databases.get("a").database.prepare("UPDATE projects SET state=? WHERE id='seed'").run(value);
    const output = await execute(h, [{ sql: "SELECT state FROM projects", params: {} }]);
    assert.equal(output.status, 422);
    assert.equal(output.body.error.code, "POLICYSQL_SCHEMA_MISMATCH");
    assert.equal(output.body.results, undefined);
  }
});

for (const hooks of [false, true]) test(`later failures roll back binary writes and publish no partial results (hooks=${hooks})`, async t => {
  const h = await harness(t, { hooks, fixture });
  for (const later of [insert("rollback", ""), { sql: "SELECT id FROM projects WHERE id=:id", params: { id: "rollback" }, expect: { rowCount: 0 } }]) {
    const result = await execute(h, [insert("rollback", "AAEC/w=="), later], "bytes-rollback-key-123");
    assert.ok(result.status >= 400);
    assert.equal(result.body.results, undefined);
    assert.equal(physical(h, "rollback"), undefined);
  }
  if (hooks) {
    h.setValidator(async () => false);
    assert.equal((await execute(h, [insert("denied", "AAEC/w==")])).status, 409);
    assert.equal(physical(h, "denied"), undefined);
  }
});

for (const hooks of [false, true]) test(`encoded result limits apply per envelope before commit (hooks=${hooks})`, async t => {
  const h = await harness(t, { hooks, fixture });
  for (const statements of [[insert("large", Buffer.alloc(48_000).toString("base64"))], [insert("large", Buffer.alloc(25_000).toString("base64")), insert("large2", Buffer.alloc(25_000).toString("base64"))]]) {
    const result = await execute(h, statements);
    assert.equal(result.status, 413, JSON.stringify(result.body));
    assert.equal(result.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
    assert.equal(result.body.results, undefined);
    assert.equal(physical(h, "large"), undefined);
  }
  const accepted = await execute(h, [insert("fits", Buffer.alloc(47_000, 255).toString("base64"))]);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body.error));
});

test("Explain and Catalog expose bytes descriptors independently of runtime values", async t => {
  const h = await harness(t, { hooks: false, fixture });
  const sql = "UPDATE projects SET state=:state WHERE id=:id RETURNING state";
  for (const params of [{}, { state: null, id: "seed" }, { state: "AA==", id: "seed" }]) {
    const result = await h.request("a", "/v1/transactions:explain", { statements: [{ sql, params }] }, null);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.statements[0].parameters.find(p => p.name === "state"), { name: "state", type: "bytes", representation: "string", format: "base64", nullable: true });
  }
  const catalog = await h.request("a", "/v1/catalog", undefined, null);
  const state = catalog.body.resources.find(r => r.name === "projects").operations.select.columns.find(c => c.name === "state");
  assert.equal(state.type, "bytes"); assert.equal(state.format, "base64"); assert.equal(state.representation, "string");
  assert.equal(h.counts().connects, 0);
});

test("bytes containing SQL text stay bound data and non-nullable byte assignments reject NULL", async t => {
  const h = await harness(t, { hooks: false, fixture });
  const payload = Buffer.from("'); DROP TABLE projects; --\u0000\u00ff").toString("base64");
  const result = await execute(h, [insert("injection", payload)]);
  assert.equal(result.status, 200);
  assert.equal(result.body.results[0].rows[0].state, payload);
  assert.equal(hash(physical(h, "injection").state), hash(Buffer.from(payload, "base64")));
  assert.ok(h.events.every(event => !event.sql.includes("DROP TABLE")));
  const required = { ...fixture, catalog: fixture.catalog.replace("type: bytes, nullable: true", "type: bytes, nullable: false"), physicalSchema: fixture.physicalSchema.replace('"state": { "declaredType": "BLOB", "nullable": true }', '"state": { "declaredType": "BLOB", "nullable": false }'), schema: fixture.schema.replace("state BLOB,", "state BLOB NOT NULL,") };
  const nonnull = await harness(t, { hooks: false, fixture: required });
  assert.equal((await execute(nonnull, [insert("null", null)])).status, 400);
  assert.equal(nonnull.counts().connects, 0);
});

test("decoded maximum is accepted independently of hosting defaults and advertised in Capabilities", async t => {
  const h = await harness(t, { hooks: false, fixture, runtimeLimits: { maxRows: 100, maxResultBytes: 800_000, timeoutMs: 1_000, maxStatements: 8 } });
  assert.equal(h.runtime.max_bytes_per_value, MAX_BYTES_PER_VALUE);
  const capabilities = await h.request("a", "/v1/capabilities", undefined, null);
  assert.equal(capabilities.body.limits.maxBytesPerValue, MAX_BYTES_PER_VALUE);
  const value = Buffer.alloc(MAX_BYTES_PER_VALUE, 255).toString("base64");
  const result = await execute(h, [insert("max", value)]);
  assert.equal(result.status, 200, JSON.stringify(result.body.error));
  assert.equal(result.body.results[0].rows[0].state, value);
  assert.equal(hash(physical(h, "max").state), hash(Buffer.from(value, "base64")));
});

test("interactive statements, command replay, commit callbacks and rollback preserve bytes", async t => {
  const h = await harness(t, { hooks: true, fixture });
  const begun = await h.request("a", "/v1/transactions", { mode: "write" }, null);
  assert.equal(begun.status, 201, JSON.stringify(begun.body));
  const path = `/v1/transactions/${begun.body.transactionId}`;
  const command = { sequence: 1, ...insert("interactive", "AAEC/w==") };
  const first = await h.request("a", `${path}/statements`, command, null);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.result.rows[0].state, "AAEC/w==");
  assert.deepEqual((await h.request("a", `${path}/statements`, command, null)).body, first.body);
  assert.equal((await h.request("a", `${path}/commit`, { sequence: 2 }, null)).status, 200);
  assert.equal(physical(h, "interactive").storage, "blob");
  assert.ok(h.hooksSeen.some(c => c.result.rows.some(r => r.id === "interactive" && r.state === "AAEC/w==")));
  const next = await h.request("a", "/v1/transactions", { mode: "write" }, null);
  const nextPath = `/v1/transactions/${next.body.transactionId}`;
  await h.request("a", `${nextPath}/statements`, { sequence: 1, ...insert("undo", "") }, null);
  assert.equal((await h.request("a", `${nextPath}/rollback`, { sequence: 2 }, null)).status, 200);
  assert.equal(physical(h, "undo"), undefined);
});
