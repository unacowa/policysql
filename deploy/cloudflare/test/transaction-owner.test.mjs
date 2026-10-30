import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { testBinding, testProvider } from "./helpers/database.mjs";
import { identity_json } from "./helpers/identity.mjs";
import { TransactionOwnerCore } from "../src/transaction-owner.ts";
import { LegacyTransactionOwnerCore } from "../src/transaction-owner-legacy.ts";
import { checkBatch } from "../src/transaction-owner.ts";
import { statusFor } from "../src/http/status.ts";
import { limitsJson } from "./helpers/limits.mjs";

// Unit tests of the owner core through the port's owner-side facilities (ADR 0022): an
// in-memory store, a recorded timer, and background tasks. No platform object is involved.
//
// Since ADR 0024 pull request 7 production runs interactive transactions on the step machine,
// which needs the real WASM runtime; its scenarios run through the differential harness
// (step-differential.test.mjs) and the port conformance suite. The interactive cases below,
// over a fake compiler, therefore test `LegacyTransactionOwnerCore`, the harness's reference
// until pull request 9. The atomic cases test the production `TransactionOwnerCore`, which
// keeps the TypeScript atomic path until pull request 8.
const makeStorage = () => {
  const values = new Map();
  const facilities = {
    values,
    timerAt: null,
    async get(key) { return values.get(key); },
    store: {
      async get(key) { return values.get(key); },
      async put(key, value) { values.set(key, structuredClone(value)); },
    },
    timer: { async schedule(atMs) { facilities.timerAt = atMs; } },
    background: { run() {} },
  };
  return facilities;
};

// The owner's reply, rendered as the HTTP adapter would: 201 for a begin, 200 for any other
// value, and the error's status from the single table.
const ownerResponse = (reply, okStatus = 200, requestId = "req") => reply.ok
  ? Response.json(reply.value, { status: okStatus })
  : Response.json({ error: { ...reply.error, requestId } }, { status: statusFor(reply.error.code) });
// The legacy owner takes the parsed command; the production owner the port's input (the
// validation id and the verified text).
const callbackQuery = async (owner, token, command, requestId = "callback_req") =>
  ownerResponse(await (owner instanceof LegacyTransactionOwnerCore
    ? owner.callbackQuery({ capability: token, command }, requestId)
    : owner.callbackQuery({ validationId: `cval_${"d".repeat(32)}`, capability: token, command: JSON.stringify(command) }, requestId)), 200, requestId);

const transaction = () => ({
  open: true,
  usage: [],
  committed: false,
  rolledBack: false,
  async execute(statements) {
    if (statements[0].sql.startsWith("EXPLAIN QUERY PLAN")) {
      return [{ columns: ["detail"], rows: [["SEARCH projects USING INDEX sqlite_autoindex_projects_1"]], rowsAffected: 0, usage: { rowsRead: 0, rowsWritten: 0, queryDurationMs: 0 } }];
    }
    return [{ columns: ["id", "name"], rows: [["p1", "safe"]], rowsAffected: 0, usage: { rowsRead: 1, rowsWritten: 0, queryDurationMs: 1 } }];
  },
  async commit() { this.committed = true; this.open = false; },
  async rollback() { this.rolledBack = true; this.open = false; },
});

// The owner's own transaction is `database`. Every later connection (the post-statement cost
// observation, which the owner hands to its background tasks) gets a separate one, as a
// real provider would.
const ownerProvider = (database) => {
  let begun = 0;
  return testProvider(() => ({ begin: async () => (begun++ === 0 ? database : transaction()) }));
};

const runtime = () => ({
  snapshot: "test-snapshot",
  max_bytes_per_value: 1_024,
  limits_json: limitsJson(),
  identity_json,
  released: 0,
  compile_json() {
    return JSON.stringify({
      executionHandle: 1,
      transactionMode: "read",
      statements: [{
        operation: "select",
        protectedSql: "SELECT id, name FROM projects WHERE tenant_id = :session_tenant_id",
        clientParameters: {},
        serverParameters: { session_tenant_id: "tenant_a" },
        result: [],
        limits: { timeoutMs: 1000 },
        explain: { resource: 1 },
      }],
    });
  },
  validate_result_json() {
    return JSON.stringify({ columns: ["id", "name"], rows: [["p1", "safe"]], affectedRows: 0, redactions: [[false, false]] });
  },
  release_execution() { this.released += 1; },
});

// Explicit deployment configuration (ADR 0021), the same object the Worker app receives.
const config = {
  environment: "test",
  costCatalog: {
    maxEstimatedRowsRead: 10,
    maxEstimatedRowsWritten: 10,
    resources: { 1: { upperRows: 10, uniqueSearchPatterns: ["sqlite_autoindex_projects_1"] } },
  },
};
const checkedConfig = {
  ...config,
  publicBaseUrl: "https://gateway.example.test",
  commitChecks: {
    project_consistency: { url: "https://validator.example.test/check", hmacSecret: "0123456789abcdef0123456789abcdef" },
  },
};
const txId = `tx_${"a".repeat(32)}`;
const fingerprint = "b".repeat(64);
const startFingerprint = "c".repeat(64);
const auth = { principal: "test:u1", subject: "u1", role: "member", roles: ["member"], access: ["execute"], session: { tenant_id: "tenant_a" } };

test("malformed delegated idempotency cannot silently disable replay protection", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/optional-idempotency.json", import.meta.url), "utf8"));
  const owner = new TransactionOwnerCore(makeStorage(), { config, getRuntime: () => runtime(), database: {
    check() { assert.fail("must reject before checking or opening a database"); },
    connect() { assert.fail("must not execute"); },
  } });
  for (const idempotency of fixture.invalidDelegatedValues) {
    const response = await call(owner, "atomic", {
      validationId: `cval_${"d".repeat(32)}`, auth,
      request: JSON.stringify({ statements: [{ sql: "DELETE FROM projects", params: {} }] }), idempotency,
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "POLICYSQL_INVALID_REQUEST");
  }
});

const call = async (owner, action, body) => {
  const input = { databaseBinding: testBinding(owner.getRuntime().snapshot), snapshot: owner.getRuntime().snapshot, ...body };
  const reply = action === "begin" ? await owner.begin(input, "req")
    : action === "atomic" ? await owner.atomic(input, "req")
      : await owner.command(action, input, "req");
  return ownerResponse(reply, action === "begin" ? 201 : 200);
};

const setup = async () => {
  const storage = makeStorage();
  const database = transaction();
  const compiler = runtime();
  const owner = new LegacyTransactionOwnerCore(storage, {
    config,
    getRuntime: () => compiler,
    database: ownerProvider(database),
  });
  const begin = await call(owner, "begin", { transactionId: txId, authFingerprint: fingerprint, startFingerprint, mode: "read", auth });
  assert.equal(begin.status, 201);
  return { owner, storage, database, compiler };
};

test("runs a sequenced statement, exact-retries it, and commits", async () => {
  const { owner, database, compiler } = await setup();
  const body = { transactionId: txId, authFingerprint: fingerprint, command: { sequence: 1, sql: "SELECT id, name FROM projects", params: {} } };
  const first = await call(owner, "statement", body);
  const replay = await call(owner, "statement", body);
  assert.equal(first.status, 200);
  assert.deepEqual(await replay.json(), await first.clone().json());
  // The statement's plan, and the retry's: a possible exact retry is compiled (and released at
  // once) before it is hashed, so a body that cannot compile is never hashed (#55 review).
  assert.equal(compiler.released, 2);
  const committed = await call(owner, "commit", { transactionId: txId, authFingerprint: fingerprint, command: { sequence: 2 } });
  assert.equal((await committed.json()).status, "committed");
  assert.equal(database.committed, true);
});

test("rolls back on a sequence gap", async () => {
  const { owner, database } = await setup();
  const response = await call(owner, "statement", { transactionId: txId, authFingerprint: fingerprint, command: { sequence: 2, sql: "SELECT id FROM projects", params: {} } });
  assert.equal(response.status, 409);
  assert.equal(database.rolledBack, true);
});

test("fails closed after owner replacement and on alarm expiry", async () => {
  const { storage, database, compiler } = await setup();
  const replacement = new LegacyTransactionOwnerCore(storage, {
    config, getRuntime: () => compiler, database: testProvider(() => ({ begin: async () => transaction() })),
  });
  const lost = await call(replacement, "statement", { transactionId: txId, authFingerprint: fingerprint, command: { sequence: 1, sql: "SELECT id FROM projects", params: {} } });
  assert.equal(lost.status, 409);
  assert.equal((await storage.get("transaction")).status, "failed");
  assert.equal(database.open, true, "the remote server owns timeout rollback after eviction");

  const second = await setup();
  assert.ok(second.storage.timerAt > Date.now(), "begin scheduled the expiry timer");
  await second.owner.onTimer();
  assert.equal(second.database.rolledBack, true);
  assert.equal((await second.storage.get("transaction")).status, "expired");
});

const commitRuntime = () => ({
  snapshot: "test-snapshot",
  max_bytes_per_value: 1_024,
  limits_json: limitsJson(),
  identity_json,
  released: 0,
  compile_json(_auth, envelope) {
    const sql = JSON.parse(envelope).statements[0].sql;
    const select = /^SELECT\b/iu.test(sql);
    return JSON.stringify({
      executionHandle: select ? 2 : 1,
      transactionMode: select ? "read" : "write",
      schemaVersion: "schema_1",
      policyVersion: "policy_1",
      commitChecks: select ? [] : [{
        id: "project_consistency",
        triggeredBy: ["projects"],
        role: "admin",
        timeoutMs: 1000,
      }],
      statements: [{
        operation: select ? "select" : "update",
        resource: "projects",
        operationCheck: !select,
        protectedSql: select
          ? "SELECT id FROM projects WHERE tenant_id = :__policysql_session_tenant_id"
          : "UPDATE projects SET name = :name WHERE tenant_id = :__policysql_session_tenant_id RETURNING id, 1 AS __policysql_check",
        clientParameters: select ? {} : { name: "changed" },
        serverParameters: { __policysql_session_tenant_id: "tenant_a" },
        result: select
          ? [{ name: "id", logicalType: "string", representation: "string", nullable: false }]
          : [{ name: "id", logicalType: "string", representation: "string", nullable: false }],
        limits: { timeoutMs: 1000 },
        explain: { resource: 1 },
      }],
    });
  },
  validate_result_json(handle) {
    return handle === 2
      ? JSON.stringify({ columns: ["id"], rows: [["p1"]], affectedRows: 0, redactions: [[false]] })
      : JSON.stringify({ columns: ["id"], rows: [["p1"]], affectedRows: 1, redactions: [[false]] });
  },
  release_execution() { this.released += 1; },
});

test("commit check callback SELECT uses the same owner transaction before commit", async () => {
  const storage = makeStorage();
  const database = transaction();
  const executedSql = [];
  database.execute = async (statements) => {
    executedSql.push(...statements.map((statement) => statement.sql));
    if (statements[0].sql.startsWith("UPDATE")) {
      return [{ columns: ["id", "__policysql_check"], rows: [["p1", 1]], rowsAffected: 1, usage: { rowsRead: 1, rowsWritten: 1, queryDurationMs: 1 } }];
    }
    return [{ columns: ["id"], rows: [["p1"]], rowsAffected: 0, usage: { rowsRead: 1, rowsWritten: 0, queryDurationMs: 1 } }];
  };
  const compiler = commitRuntime();
  let owner;
  const hookFetch = async (_url, init) => {
    const hook = JSON.parse(init.body);
    const callback = () => callbackQuery(owner, hook.query.token, { sequence: 1, sql: "SELECT id FROM projects", params: {} });
    const query = await callback();
    assert.equal(query.status, 200);
    const result = await query.json();
    assert.equal(result.meta.role, "admin");
    const replay = await callback();
    assert.deepEqual(await replay.json(), result);
    return new Response(JSON.stringify({ version: "1", allowed: true }), { status: 200 });
  };
  owner = new LegacyTransactionOwnerCore(storage, {
    config: checkedConfig,
    getRuntime: () => compiler,
    database: ownerProvider(database),
    fetchImpl: hookFetch,
  });
  await call(owner, "begin", { transactionId: txId, authFingerprint: fingerprint, startFingerprint, mode: "write", auth });
  const statement = await call(owner, "statement", {
    transactionId: txId,
    authFingerprint: fingerprint,
    command: { sequence: 1, sql: "UPDATE projects SET name = :name", params: { name: "changed" } },
  });
  assert.equal(statement.status, 200);
  const committed = await call(owner, "commit", {
    transactionId: txId,
    authFingerprint: fingerprint,
    command: { sequence: 2 },
  });
  assert.equal(committed.status, 200);
  assert.equal((await committed.json()).meta.commitChecks, "passed");
  assert.equal(database.committed, true);
  assert.equal(executedSql.some((sql) => sql.startsWith("SELECT id FROM projects")), true);
});

// #73 review: a callback query whose capability is revoked while it runs (here by an expiry
// that fires while the database executes its SELECT) returns no rows, does not restore the
// capability, and leaves the record as the timer wrote it.
test("a callback query revoked by expiry mid-query returns no rows and restores nothing (#73)", async () => {
  const storage = makeStorage();
  const database = transaction();
  const selects = [];
  let owner;
  database.execute = async (statements) => {
    if (statements[0].sql.startsWith("UPDATE")) {
      return [{ columns: ["id", "__policysql_check"], rows: [["p1", 1]], rowsAffected: 1, usage: { rowsRead: 1, rowsWritten: 1, queryDurationMs: 1 } }];
    }
    selects.push(statements[0].sql);
    // The expiry fires while the SELECT runs; the remote statement still completes.
    await owner.onTimer();
    return [{ columns: ["id"], rows: [["p1"]], rowsAffected: 0, usage: { rowsRead: 1, rowsWritten: 0, queryDurationMs: 1 } }];
  };
  const seen = {};
  const hookFetch = async (_url, init) => {
    const hook = JSON.parse(init.body);
    const query = { sequence: 1, sql: "SELECT id FROM projects", params: {} };
    const revoked = await callbackQuery(owner, hook.query.token, query);
    seen.revoked = { status: revoked.status, body: await revoked.json() };
    seen.afterTimer = structuredClone(await storage.get("transaction"));
    seen.validation = owner.validation;
    const again = await callbackQuery(owner, hook.query.token, query);
    seen.again = { status: again.status, body: await again.json() };
    return new Response(JSON.stringify({ version: "1", allowed: true }), { status: 200 });
  };
  owner = new LegacyTransactionOwnerCore(storage, {
    config: checkedConfig,
    getRuntime: () => commitRuntime(),
    database: ownerProvider(database),
    fetchImpl: hookFetch,
  });
  await call(owner, "begin", { transactionId: txId, authFingerprint: fingerprint, startFingerprint, mode: "write", auth });
  await call(owner, "statement", {
    transactionId: txId,
    authFingerprint: fingerprint,
    command: { sequence: 1, sql: "UPDATE projects SET name = :name", params: { name: "changed" } },
  });
  const committed = await call(owner, "commit", { transactionId: txId, authFingerprint: fingerprint, command: { sequence: 2 } });
  assert.equal(seen.revoked.status, 409);
  assert.equal(seen.revoked.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  assert.equal(seen.revoked.body.rows, undefined, "no rows of the revoked query");
  assert.equal(seen.afterTimer.status, "expired", "the record as the timer wrote it");
  assert.equal(seen.validation, null, "the revoked capability is not restored");
  assert.equal(seen.again.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  assert.equal(selects.length, 1, "the revoked token runs no further query");
  assert.equal(committed.status, 409);
  assert.equal((await committed.json()).error.code, "POLICYSQL_COMMIT_CHECK_REJECTED");
  assert.equal(database.rolledBack, true);
  assert.equal(database.committed, false);
});

test("commit check denial rolls back and suppresses commit", async () => {
  const storage = makeStorage();
  const database = transaction();
  database.execute = async (statements) => [{
    columns: ["id", "__policysql_check"],
    rows: [["p1", 1]],
    rowsAffected: 1,
    usage: { rowsRead: 1, rowsWritten: 1, queryDurationMs: 1 },
  }];
  const owner = new LegacyTransactionOwnerCore(storage, {
    config: checkedConfig,
    getRuntime: () => commitRuntime(),
    database: ownerProvider(database),
    fetchImpl: async () => new Response(JSON.stringify({ version: "1", allowed: false }), { status: 200 }),
  });
  await call(owner, "begin", { transactionId: txId, authFingerprint: fingerprint, startFingerprint, mode: "write", auth });
  await call(owner, "statement", {
    transactionId: txId,
    authFingerprint: fingerprint,
    command: { sequence: 1, sql: "UPDATE projects SET name = :name", params: { name: "changed" } },
  });
  const denied = await call(owner, "commit", {
    transactionId: txId,
    authFingerprint: fingerprint,
    command: { sequence: 2 },
  });
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).error.code, "POLICYSQL_COMMIT_CHECK_REJECTED");
  assert.equal(database.rolledBack, true);
  assert.equal(database.committed, false);
});

test("atomic mutation runs commit check and callback query before idempotency commit", async () => {
  const storage = makeStorage();
  const database = transaction();
  const events = [];
  database.execute = async (statements) => {
    const sql = statements[0].sql;
    events.push(sql);
    if (sql.startsWith("SELECT fingerprint")) {
      return [{ columns: ["fingerprint", "response_json"], rows: [], rowsAffected: 0, usage: { rowsRead: 0, rowsWritten: 0, queryDurationMs: 1 } }];
    }
    if (sql.startsWith("UPDATE")) {
      return [{ columns: ["id", "__policysql_check"], rows: [["p1", 1]], rowsAffected: 1, usage: { rowsRead: 1, rowsWritten: 1, queryDurationMs: 1 } }];
    }
    if (sql.startsWith("INSERT INTO policysql_idempotency")) {
      return [{ columns: [], rows: [], rowsAffected: 1, usage: { rowsRead: 0, rowsWritten: 1, queryDurationMs: 1 } }];
    }
    return [{ columns: ["id"], rows: [["p1"]], rowsAffected: 0, usage: { rowsRead: 1, rowsWritten: 0, queryDurationMs: 1 } }];
  };
  const compiler = commitRuntime();
  let owner;
  const hookFetch = async (_url, init) => {
    events.push("hook");
    const hook = JSON.parse(init.body);
    const query = await callbackQuery(owner, hook.query.token, { sequence: 1, sql: "SELECT id FROM projects", params: {} });
    assert.equal(query.status, 200);
    return new Response(JSON.stringify({ version: "1", allowed: true }), { status: 200 });
  };
  owner = new TransactionOwnerCore(storage, {
    config: checkedConfig,
    getRuntime: () => compiler,
    database: ownerProvider(database),
    fetchImpl: hookFetch,
  });
  const response = await call(owner, "atomic", {
    validationId: `cval_${"d".repeat(32)}`,
    auth,
    request: JSON.stringify({ statements: [{ sql: "UPDATE projects SET name = :name", params: { name: "changed" } }] }),
    idempotency: { keyHash: "e".repeat(64), fingerprint: "f".repeat(64) },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.commitChecks, "passed");
  assert.deepEqual(body.usage, {
    rowsReturned: 1,
    rowsAffected: 1,
    rowsRead: 1,
    rowsWritten: 1,
    queryDurationMs: 1,
  });
  assert.equal(database.committed, true);
  assert.ok(events.indexOf("hook") < events.findIndex((value) => value.startsWith("INSERT INTO policysql_idempotency")));
  assert.ok(events.some((value) => value.startsWith("SELECT id FROM projects")));
});

test("atomic replay rejects malformed database-owned response JSON", async () => {
  const storage = makeStorage();
  const database = transaction();
  database.execute = async () => [{
    columns: ["fingerprint", "response_json"],
    rows: [["f".repeat(64), JSON.stringify({ version: 1, results: [], injected: "untrusted" })]],
    rowsAffected: 0,
    usage: { rowsRead: 1, rowsWritten: 0, queryDurationMs: 1 },
  }];
  const owner = new TransactionOwnerCore(storage, {
    config,
    getRuntime: () => commitRuntime(),
    database: ownerProvider(database),
  });
  const response = await call(owner, "atomic", {
    validationId: `cval_${"d".repeat(32)}`,
    auth,
    request: JSON.stringify({ statements: [{ sql: "UPDATE projects SET name = :name", params: { name: "changed" } }] }),
    idempotency: { keyHash: "e".repeat(64), fingerprint: "f".repeat(64) },
  });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "POLICYSQL_INTERNAL");
  assert.equal(database.rolledBack, true);
});

// ADR 0024 "Effects": a batch holds immediate effects and at most one awaited effect, last.
// A step output that breaks the rule is an engine fault: nothing of the batch runs, the owner
// abandons its state and answers POLICYSQL_INTERNAL, so no outcome is ever dropped.
test("an awaited effect that is not last in its batch is an engine fault, and nothing of it runs", async (t) => {
  t.mock.method(console, "log", () => {});
  assert.doesNotThrow(() => checkBatch([{ type: "log" }, { type: "respond" }, { type: "persist", id: 1 }]));
  assert.doesNotThrow(() => checkBatch([]));
  assert.throws(() => checkBatch([{ type: "persist", id: 1 }, { type: "log" }]));
  assert.throws(() => checkBatch([{ type: "setTimer", id: 1, atMs: 1 }, { type: "persist", id: 2 }]));
  const storage = makeStorage();
  const puts = [];
  storage.store.put = async (key, value) => { puts.push(value); };
  let timers = 0;
  storage.timer.schedule = async () => { timers += 1; };
  const steps = [];
  const fake = {
    ...runtime(),
    step_json(_durable, _volatile, event) {
      const type = JSON.parse(event).type;
      steps.push(type);
      if (type === "abandon") return JSON.stringify({ durable: null, volatile: null, effects: [] });
      return JSON.stringify({ durable: '{"v":1}', volatile: '{"v":1}', effects: [
        { type: "setTimer", id: 7, atMs: 1 }, { type: "persist", id: 8 }, { type: "respond", lane: "client", reply: { ok: true, value: {} } },
      ] });
    },
  };
  const owner = new TransactionOwnerCore({ ...storage, name: txId }, { config, getRuntime: () => fake, database: ownerProvider(transaction()) });
  const reply = await owner.begin({ transactionId: txId, startFingerprint, mode: "read", auth, databaseBinding: testBinding(), snapshot: "test-snapshot" }, "req");
  assert.deepEqual(reply, { ok: false, error: { code: "POLICYSQL_INTERNAL", message: "The request could not be completed.", path: null } });
  assert.deepEqual(steps, ["forwarded", "abandon"]);
  assert.equal(timers, 0, "no effect of the faulty batch ran");
  assert.deepEqual(puts, []);
});
