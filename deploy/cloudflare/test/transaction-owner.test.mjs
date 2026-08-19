import assert from "node:assert/strict";
import test from "node:test";
import { TransactionOwnerCore } from "../src/transaction-owner.ts";

const makeStorage = () => {
  const values = new Map();
  return {
    values,
    alarm: null,
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async setAlarm(value) { this.alarm = value; },
  };
};

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

const runtime = () => ({
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

const environment = {
  POLICYSQL_COST_CATALOG_JSON: JSON.stringify({
    maxEstimatedRowsRead: 10,
    maxEstimatedRowsWritten: 10,
    resources: { 1: { upperRows: 10, uniqueSearchPatterns: ["sqlite_autoindex_projects_1"] } },
  }),
};
const txId = `tx_${"a".repeat(32)}`;
const fingerprint = "b".repeat(64);
const startFingerprint = "c".repeat(64);
const auth = { subject: "u1", role: "member", roles: ["member"], access: ["execute"], session: { tenant_id: "tenant_a" } };

const call = (owner, action, body) => owner.fetch(new Request(`https://owner/${action}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-policysql-request-id": "req" },
  body: JSON.stringify(body),
}));

const setup = async () => {
  const storage = makeStorage();
  const database = transaction();
  const compiler = runtime();
  const owner = new TransactionOwnerCore(
    { storage },
    environment,
    () => compiler,
    () => ({ begin: async () => database }),
  );
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
  assert.equal(compiler.released, 1);
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
  const replacement = new TransactionOwnerCore(
    { storage }, environment, () => compiler, () => ({ begin: async () => transaction() }),
  );
  const lost = await call(replacement, "statement", { transactionId: txId, authFingerprint: fingerprint, command: { sequence: 1, sql: "SELECT id FROM projects", params: {} } });
  assert.equal(lost.status, 409);
  assert.equal((await storage.get("transaction")).status, "failed");
  assert.equal(database.open, true, "the remote server owns timeout rollback after eviction");

  const second = await setup();
  await second.owner.alarm();
  assert.equal(second.database.rolledBack, true);
  assert.equal((await second.storage.get("transaction")).status, "expired");
});

const commitRuntime = () => ({
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
        urlEnv: "VALIDATOR_URL",
        timeoutMs: 1000,
        hmacSecretEnv: "VALIDATOR_SECRET",
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
    const callback = () => owner.fetch(new Request("https://owner/validation-query", {
        method: "POST",
        headers: {
          authorization: `Bearer ${hook.query.token}`,
          "content-type": "application/json",
          "x-policysql-request-id": "callback_req",
        },
        body: JSON.stringify({ sequence: 1, sql: "SELECT id FROM projects", params: {} }),
      }));
    const query = await callback();
    assert.equal(query.status, 200);
    const result = await query.json();
    assert.equal(result.meta.role, "admin");
    const replay = await callback();
    assert.deepEqual(await replay.json(), result);
    return new Response(JSON.stringify({ version: "1", allowed: true }), { status: 200 });
  };
  owner = new TransactionOwnerCore(
    { storage },
    {
      ...environment,
      POLICYSQL_PUBLIC_BASE_URL: "https://gateway.example.test",
      VALIDATOR_URL: "https://validator.example.test/check",
      VALIDATOR_SECRET: "0123456789abcdef0123456789abcdef",
    },
    () => compiler,
    () => ({ begin: async () => database }),
    hookFetch,
  );
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

test("commit check denial rolls back and suppresses commit", async () => {
  const storage = makeStorage();
  const database = transaction();
  database.execute = async (statements) => [{
    columns: ["id", "__policysql_check"],
    rows: [["p1", 1]],
    rowsAffected: 1,
    usage: { rowsRead: 1, rowsWritten: 1, queryDurationMs: 1 },
  }];
  const owner = new TransactionOwnerCore(
    { storage },
    {
      ...environment,
      POLICYSQL_PUBLIC_BASE_URL: "https://gateway.example.test",
      VALIDATOR_URL: "https://validator.example.test/check",
      VALIDATOR_SECRET: "0123456789abcdef0123456789abcdef",
    },
    () => commitRuntime(),
    () => ({ begin: async () => database }),
    async () => new Response(JSON.stringify({ version: "1", allowed: false }), { status: 200 }),
  );
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
    const query = await owner.fetch(new Request("https://owner/validation-query", {
      method: "POST",
      headers: { authorization: `Bearer ${hook.query.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sequence: 1, sql: "SELECT id FROM projects", params: {} }),
    }));
    assert.equal(query.status, 200);
    return new Response(JSON.stringify({ version: "1", allowed: true }), { status: 200 });
  };
  owner = new TransactionOwnerCore(
    { storage },
    {
      ...environment,
      POLICYSQL_PUBLIC_BASE_URL: "https://gateway.example.test",
      VALIDATOR_URL: "https://validator.example.test/check",
      VALIDATOR_SECRET: "0123456789abcdef0123456789abcdef",
    },
    () => compiler,
    () => ({ begin: async () => database }),
    hookFetch,
  );
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
  const owner = new TransactionOwnerCore(
    { storage },
    environment,
    () => commitRuntime(),
    () => ({ begin: async () => database }),
  );
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
