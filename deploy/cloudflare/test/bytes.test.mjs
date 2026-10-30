import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { MAX_BYTES_PER_VALUE, harness } from "./helpers/routing.mjs";
import { BinaryLimitError, bytesLimit, decodeBlob as decodeWithLimit, encodeBlob as encodeWithLimit, runtimeBytesLimit } from "../src/binary.ts";
import { capabilities } from "../src/presenters.ts";
import { driverArgs as driverArgsWithLimit, rawDriverValue as rawWithLimit, rowValues } from "../src/driver-values.ts";
import { limitsJson } from "./helpers/limits.mjs";

// Every codec call takes the runtime's limit; these bind the real WASM value.
const decodeBlob = value => decodeWithLimit(value, MAX_BYTES_PER_VALUE);
const encodeBlob = value => encodeWithLimit(value, MAX_BYTES_PER_VALUE);
const driverArgs = args => driverArgsWithLimit(args, MAX_BYTES_PER_VALUE);
const rawDriverValue = value => rawWithLimit(value, MAX_BYTES_PER_VALUE);

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
// state === null binds SQL NULL: `:state` is only a direct assignment to the
// nullable bytes column, so the compiler proves NULL is allowed (#20).
const insert = (id, state, returning = " RETURNING id,name,state,seed,metadata") => ({
  sql: `INSERT INTO projects(id,name,state,metadata) VALUES(:id,:name,:state,:metadata)${returning}`,
  params: { id, name: "AAEC/w==", state, metadata: [0, 1, 2, 255] },
});
const insertRaw = (id, state) => ({
  sql: "INSERT INTO projects(id,name,state) VALUES(:id,:name,:state) RETURNING state",
  params: { id, name: "n", state },
});
const execute = (h, statements, key = null) => h.request("a", "/v1/transactions:execute", { statements }, key);
const hash = value => createHash("sha256").update(value).digest("hex");
const physical = (h, id) => h.databases.get("a").database.prepare("SELECT *,typeof(state) AS storage,typeof(seed) AS preset_storage FROM projects WHERE id=?").get(id);

test("private binary adapters share strict vectors and preserve physical value identity", () => {
  for (const { base64, bytes } of cases.valid) {
    assert.deepEqual([...decodeBlob(base64)], bytes);
    assert.equal(encodeBlob(Uint8Array.from(bytes)), base64);
    const args = driverArgs({ data: { type: "blob", base64 }, text: base64, preset: { type: "blob", base64 } });
    assert.deepEqual([...args.data], bytes);
    assert.deepEqual([...args.preset], bytes);
    assert.equal(args.text, base64);
    assert.deepEqual(rawDriverValue(args.data), { type: "blob", base64 });
  }
  for (const value of [...cases.invalid, ...cases.wrongTypes]) assert.throws(() => decodeBlob(value));
  for (const value of [{ type: "blob", base64: "AA==" }, [0], {}, new ArrayBuffer(1), NaN, Infinity, undefined]) {
    assert.throws(() => rawDriverValue(value), { code: "POLICYSQL_SCHEMA_MISMATCH" });
  }
  // A collision of the client and server parameter namespaces is core's to reject, before any
  // `execute` effect (crates/policysql-transaction/tests/machine.rs).
  assert.throws(() => decodeBlob(Buffer.alloc(MAX_BYTES_PER_VALUE + 1).toString("base64")), BinaryLimitError);
  assert.throws(() => encodeBlob(new Uint8Array(MAX_BYTES_PER_VALUE + 1)), BinaryLimitError);
  assert.throws(() => rawDriverValue(new Uint8Array(MAX_BYTES_PER_VALUE + 1)), { code: "POLICYSQL_LIMIT_EXCEEDED" });
  for (const row of [[], new Array(1), {}, { unrelated: null }, [null, null]]) {
    assert.throws(() => rowValues(["state"], row), { code: "POLICYSQL_SCHEMA_MISMATCH" });
  }
  assert.deepEqual(rowValues(["state"], { 0: null, state: "must not replace NULL" }), [null]);
});

// Regression (#22): the adapter has no second copy of MAX_BYTES_PER_VALUE. Every
// codec and driver-value path honors the injected runtime limit, so a Rust-only
// change (raised or lowered) cannot turn valid WASM output into a 500.
test("binary codec honors the injected runtime limit instead of a host constant", () => {
  const raised = MAX_BYTES_PER_VALUE * 2;
  const above = Buffer.alloc(MAX_BYTES_PER_VALUE + 1, 7);
  const base64 = above.toString("base64");
  assert.deepEqual(Buffer.from(decodeWithLimit(base64, raised)), above);
  assert.equal(encodeWithLimit(above, raised), base64);
  assert.deepEqual(Buffer.from(driverArgsWithLimit({ v: { type: "blob", base64 } }, raised).v), above);
  assert.deepEqual(rawWithLimit(new Uint8Array(above), raised), { type: "blob", base64 });
  for (const lowered of [1, 3, 16]) {
    const fits = Buffer.alloc(lowered, 1);
    const over = Buffer.alloc(lowered + 1, 1);
    assert.deepEqual(Buffer.from(decodeWithLimit(fits.toString("base64"), lowered)), fits);
    assert.throws(() => decodeWithLimit(over.toString("base64"), lowered), BinaryLimitError);
    assert.throws(() => encodeWithLimit(over, lowered), BinaryLimitError);
    assert.throws(() => rawWithLimit(new Uint8Array(over), lowered), { code: "POLICYSQL_LIMIT_EXCEEDED" });
    assert.throws(() => driverArgsWithLimit({ v: { type: "blob", base64: over.toString("base64") } }, lowered), { code: "POLICYSQL_INTERNAL" });
    // Malformed input stays malformed (TypeError → 400/503/422) at any limit.
    assert.throws(() => decodeWithLimit("A===", lowered), TypeError);
  }
});

// Regression (PR #24 review): Infinity is not an "unbounded" escape hatch. The codec
// and every driver-value path reject it like any other malformed limit.
test("a missing or malformed injected limit fails closed instead of disabling the bound", () => {
  for (const limit of [undefined, null, 0, -1, 1.5, NaN, "262144", 2 ** 53, Infinity, -Infinity]) {
    assert.throws(() => decodeWithLimit("AA==", limit), TypeError, String(limit));
    assert.throws(() => encodeWithLimit(new Uint8Array(1), limit), TypeError, String(limit));
    assert.throws(() => driverArgsWithLimit({}, limit), TypeError, String(limit));
    assert.throws(() => rawWithLimit("text", limit), TypeError, String(limit));
    assert.throws(() => runtimeBytesLimit({ max_bytes_per_value: limit }), TypeError, String(limit));
    assert.throws(() => bytesLimit(limit), TypeError, String(limit));
  }
  for (const runtime of [undefined, null, {}, { max_bytes_per_value: Infinity }]) {
    assert.throws(() => runtimeBytesLimit(runtime), TypeError);
  }
  // An unbounded limit must not let an oversized value through any path.
  const huge = new Uint8Array(MAX_BYTES_PER_VALUE * 4);
  const hugeBase64 = Buffer.from(huge).toString("base64");
  assert.throws(() => encodeWithLimit(huge, Infinity), TypeError);
  assert.throws(() => decodeWithLimit(hugeBase64, Infinity), TypeError);
  assert.throws(() => rawWithLimit(huge, Infinity), TypeError);
  assert.throws(() => driverArgsWithLimit({ v: { type: "blob", base64: hugeBase64 } }, Infinity), TypeError);
  assert.equal(runtimeBytesLimit({ max_bytes_per_value: 512 * 1024 }), 512 * 1024);
});

test("Capabilities and the adapter take maxBytesPerValue from the same runtime value", () => {
  for (const advertised of [16, MAX_BYTES_PER_VALUE, MAX_BYTES_PER_VALUE * 2]) {
    const runtime = {
      snapshot: "s", profile: "p", abi_version: 2, commit_checks_enabled: false, max_bytes_per_value: advertised,
      limits_json: limitsJson(),
    };
    assert.equal(capabilities(runtime, { limits: { maxBytesPerValue: 1 } }).limits.maxBytesPerValue, advertised);
    assert.equal(runtimeBytesLimit(runtime), advertised);
  }
});

for (const hooks of [false, true]) test(`bytes round-trip with the trusted session, real WASM, HTTP transport, SQLite, presets and replay (hooks=${hooks})`, async t => {
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

  const fetched = await execute(h, values.map((_value, i) => ({
    sql: "SELECT state FROM projects WHERE id=:id", params: { id: `bytes_${i}` },
  })));
  assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
  const fetchedValues = fetched.body.results.map(result => result.rows[0].state);
  assert.deepEqual(fetchedValues, values, "unpadded DB responses produce canonical public bytes, empty bytes and NULL");
  const copied = await execute(h, fetchedValues.map((value, i) => insert(`copy_${i}`, value)));
  assert.equal(copied.status, 200, JSON.stringify(copied.body));
  assert.deepEqual(copied.body.results.map(result => result.rows[0].state), values, "public results can be resubmitted unchanged");
  for (const [i, value] of values.entries()) {
    const stored = physical(h, `copy_${i}`);
    assert.equal(stored.storage, value === null ? "null" : "blob");
    if (value !== null) assert.equal(hash(stored.state), hash(Buffer.from(value, "base64")));
  }

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

const nonNullableFixture = { ...fixture, catalog: fixture.catalog.replace("type: bytes, nullable: true", "type: bytes, nullable: false"), physicalSchema: fixture.physicalSchema.replace('"state": { "declaredType": "BLOB", "nullable": true }', '"state": { "declaredType": "BLOB", "nullable": false }'), schema: fixture.schema.replace("state BLOB,", "state BLOB NOT NULL,") };

test("Explain and Catalog expose bytes descriptors independently of runtime values", async t => {
  const h = await harness(t, { hooks: false, fixture });
  const nonnull = await harness(t, { hooks: false, fixture: nonNullableFixture });
  const sql = "UPDATE projects SET state=:state WHERE id=:id RETURNING state";
  const descriptor = nullable => ({ name: "state", type: "bytes", representation: "string", format: "base64", nullable });
  // The descriptor is the compiler's NULL proof (#20), never inferred from the sample.
  for (const [target, nullable] of [[h, true], [nonnull, false]]) {
    for (const params of [{}, { state: "AA==", id: "seed" }, ...(nullable ? [{ state: null, id: "seed" }] : [])]) {
      const result = await target.request("a", "/v1/transactions:explain", { statements: [{ sql, params }] }, null);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(result.body.statements[0].parameters.find(p => p.name === "state"), descriptor(nullable));
    }
  }
  const comparison = await h.request("a", "/v1/transactions:explain", { statements: [{ sql: "SELECT id FROM projects WHERE state=:state", params: {} }] }, null);
  assert.deepEqual(comparison.body.statements[0].parameters, [descriptor(false)]);
  // A NULL sample that Execute would reject is rejected by Explain with the same error.
  for (const [target, statement, params] of [
    [nonnull, sql, { state: null, id: "seed" }],
    [h, "SELECT id FROM projects WHERE state=:state", { state: null }],
  ]) {
    const nullSample = await target.request("a", "/v1/transactions:explain", { statements: [{ sql: statement, params }] }, null);
    assert.equal(nullSample.status, 400);
    assert.equal(nullSample.body.error.code, "POLICYSQL_INVALID_PARAMETER");
  }
  assert.equal(nonnull.counts().connects, 0);
  const catalog = await h.request("a", "/v1/catalog", undefined, null);
  const state = catalog.body.resources.find(r => r.name === "projects").operations.select.columns.find(c => c.name === "state");
  assert.equal(state.type, "bytes"); assert.equal(state.format, "base64"); assert.equal(state.representation, "string");
  assert.equal(h.counts().connects, 0);
});

test("bytes containing SQL text stay bound data and NULL bytes parameters follow the nullable-assignment proof", async t => {
  const h = await harness(t, { hooks: false, fixture });
  const payload = Buffer.from("'); DROP TABLE projects; --\u0000\u00ff").toString("base64");
  const result = await execute(h, [insert("injection", payload)]);
  assert.equal(result.status, 200);
  assert.equal(result.body.results[0].rows[0].state, payload);
  assert.equal(hash(physical(h, "injection").state), hash(Buffer.from(payload, "base64")));
  assert.ok(h.events.every(event => !event.sql.includes("DROP TABLE")));
  const nonnull = await harness(t, { hooks: false, fixture: nonNullableFixture });
  for (const [target, nullable] of [[h, true], [nonnull, false]]) {
    for (const [statement, proven] of [
      [insertRaw("null", null), nullable],
      [{ sql: "UPDATE projects SET state=:state WHERE id=:id RETURNING state", params: { state: null, id: "seed" } }, nullable],
      [{ sql: "SELECT id FROM projects WHERE state=:state", params: { state: null } }, false],
      [{ sql: "UPDATE projects SET state=:state WHERE state=:state", params: { state: null } }, false],
    ]) {
      const result = await execute(target, [statement]);
      if (proven) {
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.deepEqual(result.body.results[0].rows, [{ state: null }]);
      } else {
        assert.equal(result.status, 400, JSON.stringify(result.body));
        assert.equal(result.body.error.code, "POLICYSQL_INVALID_PARAMETER");
      }
    }
  }
  assert.equal(physical(h, "null").storage, "null");
  assert.equal(physical(h, "seed").storage, "null");
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

// Regression (PR #19 review): malformed input is 400 however long it is; only
// well-formed input whose decoded size exceeds the limit is 413.
test("large malformed base64 remains invalid input, before decoded size classification", async t => {
  const h = await harness(t, { hooks: false, fixture });
  const decode = t.mock.method(globalThis, "atob");
  for (const { name, pattern, repeat, suffix, tooLarge } of JSON.parse(read("bytes-limits.json"))) {
    const value = pattern.repeat(repeat) + suffix;
    const before = decode.mock.callCount();
    assert.throws(() => decodeBlob(value), tooLarge ? BinaryLimitError : TypeError, name);
    assert.equal(decode.mock.callCount(), before, "reject before payload allocation");
    const result = await execute(h, [insert("invalid", value)]);
    assert.equal(result.status, tooLarge ? 413 : 400, name);
    assert.equal(result.body.error.code, tooLarge ? "POLICYSQL_LIMIT_EXCEEDED" : "POLICYSQL_INVALID_PARAMETER", name);
    assert.equal(h.counts().connects, 0);
  }
});

// Regression (PR #19 review): an oversized stored BLOB is a permanent 413 through
// the HTTP transport (not a retryable 503) and rolls back earlier writes.
for (const hooks of [false, true]) test(`oversized physical BLOB returns 413 and rolls back earlier writes (hooks=${hooks})`, async t => {
  const h = await harness(t, { hooks, fixture });
  h.databases.get("a").database.prepare("UPDATE projects SET state=? WHERE id='seed'").run(Buffer.alloc(MAX_BYTES_PER_VALUE + 1));
  const result = await execute(h, [insert("undo-oversize", "AA=="), {
    sql: "SELECT state FROM projects WHERE id=:id", params: { id: "seed" },
  }]);
  assert.equal(result.status, 413, JSON.stringify(result.body));
  assert.equal(result.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
  assert.equal(result.body.results, undefined);
  assert.equal(physical(h, "undo-oversize"), undefined);
  assert.ok(h.events.some(event => event.sql === "ROLLBACK"));
});

// ADR 0024 pull request 8: the transport's result limit reaches core as the outcome class
// `limit`, so an interactive statement gets the same permanent 413 (pull request 7 answered 500).
test("oversized physical BLOB in an interactive statement's result is 413 and ends the transaction", async t => {
  const h = await harness(t, { hooks: false, fixture });
  h.databases.get("a").database.prepare("UPDATE projects SET state=? WHERE id='seed'").run(Buffer.alloc(MAX_BYTES_PER_VALUE + 1));
  const begun = await h.request("a", "/v1/transactions", { mode: "write" }, null);
  const path = `/v1/transactions/${begun.body.transactionId}`;
  assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert("undo-interactive", "AA==") }, null)).status, 200);
  const result = await h.request("a", `${path}/statements`, { sequence: 2, sql: "SELECT state FROM projects WHERE id=:id", params: { id: "seed" } }, null);
  assert.equal(result.status, 413, JSON.stringify(result.body));
  assert.equal(result.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
  const commit = await h.request("a", `${path}/commit`, { sequence: 3 }, null);
  assert.equal(commit.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  assert.equal(physical(h, "undo-interactive"), undefined);
});

// Regression (PR #23 review): in-limit BLOB rows whose raw result exceeds the private
// result ABI bound, and a BLOB large enough to exceed the Hrana response bound, are
// result-budget failures (413) that roll back, not 400 or retryable 503.
for (const hooks of [false, true]) test(`large BLOB results are 413 at every result bound (hooks=${hooks})`, async t => {
  const h = await harness(t, { hooks, fixture });
  const db = h.databases.get("a").database;
  const { tenant_id: tenant } = db.prepare("SELECT tenant_id FROM projects WHERE id='seed'").get();
  const add = db.prepare("INSERT INTO projects(id,tenant_id,name,state,seed) VALUES(?,?,?,?,x'')");
  // Four in-limit values: under the 2 MiB Hrana bound, over the 1 MiB result ABI bound.
  for (const id of ["max1", "max2", "max3", "max4"]) add.run(id, tenant, "max", Buffer.alloc(MAX_BYTES_PER_VALUE, 255));
  add.run("huge", tenant, "huge", Buffer.alloc(2 * 1024 * 1024));
  for (const name of ["max", "huge"]) {
    const read = { sql: "SELECT state FROM projects WHERE name=:name", params: { name } };
    const result = await execute(h, [insert(`undo-${name}`, "AA=="), read]);
    assert.equal(result.status, 413, `${name}: ${JSON.stringify(result.body.error ?? result.body.results?.[1]?.rowCount)}`);
    assert.equal(result.body.error.code, "POLICYSQL_LIMIT_EXCEEDED", name);
    assert.equal(result.body.results, undefined);
    assert.equal(physical(h, `undo-${name}`), undefined);
  }
});
