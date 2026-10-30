import test from "node:test";
import assert from "node:assert/strict";
import { createInProcessPolicySql, loadRuntime } from "../../../examples/in-process/policysql.ts";

// The non-HTTP example (examples/in-process, ADR 0023): engine operations called directly,
// in one process, with results as values or `{ code, message, path }` and no HTTP status.
const getRuntime = loadRuntime();
const session = (tenant, access = ["execute", "explain", "catalog"]) => ({
  principal: `in-process:${tenant}`, subject: `user_${tenant}`, roles: ["member"], defaultRole: "member", access,
  session: { tenant_id: tenant },
});
const statements = (...items) => JSON.stringify({ statements: items });

test("in-process: every operation runs without HTTP, and policy still applies", async (t) => {
  t.mock.method(console, "log", () => {});
  const p = createInProcessPolicySql(getRuntime);
  t.after(() => p.close());
  p.database.exec("INSERT INTO projects VALUES ('other', 'tenant_b', 'hidden')");
  const context = (tenant = "tenant_a", requestId = undefined) => ({
    database: p.binding, session: session(tenant), ...(requestId ? { requestId } : {}),
  });

  const health = await p.engine.health();
  assert.equal(health.ok, true);
  assert.equal(health.value.snapshot, getRuntime().snapshot);

  const capabilities = await p.engine.capabilities({}, context());
  assert.equal(capabilities.ok, true);
  assert.equal(capabilities.notModified, false);
  assert.equal(capabilities.value.id, capabilities.snapshot);
  assert.deepEqual(await p.engine.capabilities({ ifNoneMatch: capabilities.snapshot }, context("tenant_a", "req_cached")),
    { ok: true, notModified: true, snapshot: capabilities.snapshot, requestId: "req_cached" });
  const catalog = await p.engine.catalog({}, context());
  assert.equal(catalog.ok, true);
  assert.ok(JSON.stringify(catalog.value).includes("projects"));

  const inserted = await p.engine.execute({
    bodyText: statements({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id: "p1", name: "first" } }),
    idempotencyKey: "in-process-key-0001",
  }, context("tenant_a", "req_insert"));
  assert.equal(inserted.ok, true, JSON.stringify(inserted));
  assert.equal(inserted.requestId, "req_insert");
  assert.deepEqual(inserted.value.results[0].rows, [{ id: "p1", name: "first" }]);
  // The preset column came from the trusted session, not the caller.
  assert.equal(p.database.prepare("SELECT tenant_id FROM projects WHERE id = 'p1'").get().tenant_id, "tenant_a");

  const read = await p.engine.execute({ bodyText: statements({ sql: "SELECT id, name FROM projects ORDER BY id", params: {} }) }, context());
  assert.deepEqual(read.value.results[0].rows, [{ id: "p1", name: "first" }], "the row filter hides another tenant's row");

  const explained = await p.engine.explain({ bodyText: statements({ sql: "SELECT id FROM projects", params: {} }) }, context());
  assert.equal(explained.ok, true);
  assert.equal(explained.value.statements[0].resources[0].policy, "projects.member.select");

  const begun = await p.engine.begin({ bodyText: JSON.stringify({ mode: "write" }) }, context());
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const { transactionId } = begun.value;
  const statement = await p.engine.statement({
    transactionId, bodyText: JSON.stringify({ sequence: 1, sql: "UPDATE projects SET name = :name WHERE id = :id RETURNING id, name", params: { id: "p1", name: "renamed" } }),
  }, context());
  assert.equal(statement.ok, true, JSON.stringify(statement));
  const committed = await p.engine.commit({ transactionId, bodyText: JSON.stringify({ sequence: 2 }) }, context());
  assert.equal(committed.value.status, "committed");
  assert.equal(p.database.prepare("SELECT name FROM projects WHERE id = 'p1'").get().name, "renamed");

  const rolledBack = await p.engine.begin({ bodyText: JSON.stringify({ mode: "read" }) }, context());
  assert.equal((await p.engine.rollback({ transactionId: rolledBack.value.transactionId, bodyText: '{"sequence":1}' }, context())).value.status,
    "rolled_back");
});

test("in-process: failures are codes, never statuses, and body checks run without HTTP", async (t) => {
  t.mock.method(console, "log", () => {});
  const p = createInProcessPolicySql(getRuntime);
  t.after(() => p.close());
  const context = { database: p.binding, session: session("tenant_a") };
  const failure = async (promise, code) => {
    const result = await promise;
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error.code, code);
    assert.deepEqual(Object.keys(result.error).sort(), ["code", "message", "path"]);
    assert.equal(JSON.stringify(result).includes("status\":4"), false);
  };
  await failure(p.engine.execute({ bodyText: statements({ sql: "SELECT tenant_id FROM projects", params: {} }) }, context),
    "POLICYSQL_FORBIDDEN_COLUMN");
  await failure(p.engine.execute({ bodyText: '{"statements":[],"statements":[]}' }, context), "POLICYSQL_INVALID_REQUEST");
  await failure(p.engine.execute({ bodyText: '{"a":"\ud800"}' }, context), "POLICYSQL_INVALID_REQUEST");
  await failure(p.engine.execute({ bodyText: '{"a":"\\ud800"}' }, context), "POLICYSQL_INVALID_REQUEST");
  await failure(p.engine.execute({ bodyText: '{"a":"\\udc00"}' }, context), "POLICYSQL_INVALID_REQUEST");
  await failure(p.engine.execute({ bodyText: `"${"x".repeat(1_048_576)}"` }, context), "POLICYSQL_REQUEST_TOO_LARGE");
  await failure(p.engine.execute({ bodyText: statements({ sql: "SELECT id FROM projects", params: {} }), role: "admin" }, context),
    "POLICYSQL_FORBIDDEN_ACCESS");
  await failure(p.engine.catalog({}, { database: p.binding, session: session("tenant_a", ["execute"]) }), "POLICYSQL_FORBIDDEN_ACCESS");
  await failure(p.engine.statement({ transactionId: "tx_bad", bodyText: "{}" }, context), "POLICYSQL_INVALID_REQUEST");
  await failure(p.engine.commit({ transactionId: `tx_${"0".repeat(32)}`, bodyText: '{"sequence":1}' }, context),
    "POLICYSQL_TRANSACTION_UNAVAILABLE");
  await failure(p.engine.execute({ bodyText: "{}" }, { session: session("tenant_a") }), "POLICYSQL_DATABASE_REQUIRED");
  await failure(p.engine.execute({ bodyText: "{}", extra: true }, context), "POLICYSQL_INTERNAL");
  await failure(p.engine.callbackQuery({ validationId: `cval_${"0".repeat(32)}`, capability: "", bodyText: "{}" }),
    "POLICYSQL_TRANSACTION_UNAVAILABLE");
});

// ADR 0025, "Escaped lone surrogates": the engine rejects the escaped form as it rejects the
// raw one, before anything reaches the owner or core. The two observable differences.
test("in-process: an escaped lone surrogate in a statement is rejected before the owner, and the transaction stays open", async (t) => {
  t.mock.method(console, "log", () => {});
  const p = createInProcessPolicySql(getRuntime);
  t.after(() => p.close());
  const context = { database: p.binding, session: session("tenant_a") };
  const begun = await p.engine.begin({ bodyText: JSON.stringify({ mode: "write" }) }, context);
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const { transactionId } = begun.value;
  const sql = "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name";
  for (const escaped of ["\\ud800", "\\udc00"]) {
    const bodyText = `{"sequence":1,"sql":${JSON.stringify(sql)},"params":{"id":"s1","name":"${escaped}"}}`;
    const rejected = await p.engine.statement({ transactionId, bodyText }, context);
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.error, { code: "POLICYSQL_INVALID_REQUEST", message: "Request body is not valid UTF-8.", path: null });
  }
  // Before ADR 0025 the owner's compile error closed the transaction as failed; now it is open.
  const next = await p.engine.statement({
    transactionId, bodyText: JSON.stringify({ sequence: 1, sql, params: { id: "s1", name: "kept" } }),
  }, context);
  assert.equal(next.ok, true, JSON.stringify(next));
  const committed = await p.engine.commit({ transactionId, bodyText: JSON.stringify({ sequence: 2 }) }, context);
  assert.equal(committed.value.status, "committed");
  assert.equal(p.database.prepare("SELECT name FROM projects WHERE id = 's1'").get().name, "kept");
});

test("in-process: a begin whose expected versions contain an escaped lone surrogate is invalid, not stale", async (t) => {
  t.mock.method(console, "log", () => {});
  const p = createInProcessPolicySql(getRuntime);
  t.after(() => p.close());
  const context = { database: p.binding, session: session("tenant_a") };
  for (const expected of [
    '{"schemaVersion":"\\ud800","policyVersion":"p"}',
    '{"schemaVersion":"s","policyVersion":"x\\udc00"}',
  ]) {
    const begun = await p.engine.begin({ bodyText: `{"mode":"write","expected":${expected}}` }, context);
    assert.equal(begun.ok, false);
    assert.equal(begun.error.code, "POLICYSQL_INVALID_REQUEST", expected);
  }
  // Other wrong versions are still stale.
  const stale = await p.engine.begin({ bodyText: '{"mode":"write","expected":{"schemaVersion":"\\u00e9","policyVersion":"p"}}' }, context);
  assert.equal(stale.error.code, "POLICYSQL_STALE_OPERATION");
});
