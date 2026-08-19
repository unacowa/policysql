import test from "node:test";
import assert from "node:assert/strict";
import { enforceCumulativeLimits, executeSealedEnvelope } from "../src/turso.ts";

test("applies the statement limits cumulatively to the atomic envelope", () => {
  const compiled = {
    statements: [
      { limits: { maxRows: 3, maxResultBytes: 100, timeoutMs: 50 } },
      { limits: { maxRows: 3, maxResultBytes: 100, timeoutMs: 50 } },
    ],
  };
  assert.throws(
    () => enforceCumulativeLimits(compiled, [
      { rows: [[1], [2]] },
      { rows: [[3], [4]] },
    ], 10),
    (error) => error.code === "POLICYSQL_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => enforceCumulativeLimits(compiled, [{ rows: [] }, { rows: [] }], 51),
    (error) => error.code === "POLICYSQL_TIMEOUT",
  );
});

test("rolls back and publishes no partial result after a cumulative limit breach", async () => {
  let committed = false;
  let rolledBack = false;
  const runtime = {
    validate_result_json(_handle, _index, raw) {
      return JSON.stringify({ ...JSON.parse(raw), redactions: [[false], [false]] });
    },
    release_execution() { return true; },
  };
  const transaction = {
    usage: [],
    async execute() {
      return [0, 1].map((value) => ({
        columns: ["id"],
        rows: [[`${value}-a`], [`${value}-b`]],
        rowsAffected: 0,
        usage: { rowsRead: 2, rowsWritten: 0, queryDurationMs: 1 },
      }));
    },
    async commit() { committed = true; },
    async rollback() { rolledBack = true; },
  };
  await assert.rejects(
    executeSealedEnvelope(
      runtime,
      {
        executionHandle: 11,
        transactionMode: "read",
        statements: [0, 1].map(() => ({
          operation: "select",
          protectedSql: "SELECT id FROM projects",
          clientParameters: {},
          serverParameters: {},
          result: [],
          limits: { maxRows: 3, maxResultBytes: 1_000, timeoutMs: 1_000 },
        })),
      },
      { TURSO_DATABASE_URL: "https://db.test", TURSO_AUTH_TOKEN: "secret" },
      "req_cumulative",
      () => ({ async begin() { return transaction; } }),
    ),
    (error) => error.code === "POLICYSQL_LIMIT_EXCEEDED",
  );
  assert.equal(committed, false);
  assert.equal(rolledBack, true);
});

test("executes only protected SQL and validates every result before publication", async () => {
  const seen = [];
  const released = [];
  const runtime = {
    validate_result_json(handle, index, raw) {
      assert.equal(handle, 7n);
      assert.equal(index, 0);
      const value = JSON.parse(raw);
      return JSON.stringify({ ...value, redactions: [[false, false]] });
    },
    release_execution(handle) {
      released.push(Number(handle));
      return true;
    },
  };
  const transaction = {
    usage: [],
    async execute(statements) {
      seen.push({ statements });
      const output = [{
        columns: ["id", "name"],
        rows: [["p1", "One"]],
        rowsAffected: 0,
        usage: { rowsRead: 1, rowsWritten: 0, queryDurationMs: 1 },
      }];
      this.usage.push(output[0].usage);
      return output;
    },
    async commit() {},
    async rollback() {},
  };
  const compiled = {
    executionHandle: 7,
    transactionMode: "read",
    statements: [{
      operation: "select",
      protectedSql: "SELECT id, name FROM projects WHERE tenant_id = :__policysql_session_tenant_id",
      clientParameters: {},
      serverParameters: { __policysql_session_tenant_id: "tenant_1" },
      result: [],
      limits: { timeoutMs: 1000 },
    }],
  };
  const output = await executeSealedEnvelope(
    runtime,
    compiled,
    { TURSO_DATABASE_URL: "https://db.test", TURSO_AUTH_TOKEN: "secret" },
    "req_1",
    () => ({ async begin() { return transaction; } }),
  );
  assert.equal(seen[0].statements[0].sql, compiled.statements[0].protectedSql);
  assert.deepEqual(seen[0].statements[0].args, {
    __policysql_session_tenant_id: "tenant_1",
  });
  assert.equal(output.results[0].rows[0].name, "One");
  assert.deepEqual(released, [7]);
});

test("validates mutation inside the dedicated transaction and stores terminal idempotency", async () => {
  const order = [];
  let stored;
  const runtime = {
    validate_result_json() {
      order.push("validate");
      return JSON.stringify({
        columns: ["id"],
        rows: [["new_1"]],
        redactions: [[false]],
        affectedRows: 1,
      });
    },
    release_execution() { order.push("release"); return true; },
  };
  const tx = {
    usage: [],
    async execute(statements) {
      const sql = statements[0].sql;
      const usage = { rowsRead: 0, rowsWritten: 0, queryDurationMs: 1 };
      this.usage.push(usage);
      if (sql.startsWith("SELECT fingerprint")) {
        return [{ columns: ["fingerprint", "response_json"], rows: [], rowsAffected: 0, usage }];
      }
      if (sql.startsWith("INSERT INTO policysql_idempotency")) {
        stored = JSON.parse(statements[0].args.response_json);
        order.push("store");
        return [{ columns: [], rows: [], rowsAffected: 1, usage: { ...usage, rowsWritten: 1 } }];
      }
      order.push("execute");
      return [{
        columns: ["id", "__check"],
        rows: [["new_1", 1]],
        rowsAffected: 0,
        usage: { rowsRead: 0, rowsWritten: 1, queryDurationMs: 1 },
      }];
    },
    async commit() { order.push("commit"); },
    async rollback() {},
  };
  const output = await executeSealedEnvelope(
    runtime,
    {
      executionHandle: 9,
      transactionMode: "write",
      statements: [{
        operation: "insert",
        operationCheck: true,
        protectedSql: "INSERT INTO projects ...",
        clientParameters: { id: "new_1" },
        serverParameters: {},
        result: [],
        limits: { timeoutMs: 1000 },
      }],
    },
    { TURSO_DATABASE_URL: "https://db.test", TURSO_AUTH_TOKEN: "secret" },
    "req_write",
    () => ({ async begin() { return tx; } }),
    { keyHash: "a".repeat(64), fingerprint: "b".repeat(64) },
  );
  assert.deepEqual(order.slice(0, 4), ["execute", "validate", "store", "commit"]);
  assert.equal(stored.results[0].affectedRows, 1);
  assert.deepEqual(stored.results[0].meta.mutation, {
    affectedRows: 1,
    returning: false,
    operationCheck: "passed",
  });
  assert.equal(output.transactionId, `atomic_${"a".repeat(24)}`);
});
