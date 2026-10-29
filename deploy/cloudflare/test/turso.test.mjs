import test from "node:test";
import assert from "node:assert/strict";
import { enforceCumulativeLimits, executeSealedEnvelope, executeSealedOnTransaction } from "../src/turso.ts";
import { databaseTransportFactory } from "../src/database.ts";
import { testBinding } from "./helpers/database.mjs";
import { MAX_BYTES_PER_VALUE } from "./helpers/routing.mjs";

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
    max_bytes_per_value: MAX_BYTES_PER_VALUE,
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
    max_bytes_per_value: MAX_BYTES_PER_VALUE,
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
    max_bytes_per_value: MAX_BYTES_PER_VALUE,
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

// Regression (PR #19 review): the serverless-driver path classifies an oversized
// BLOB exactly like the HTTP transport (413), and the shape log is emitted before
// row validation can throw.
test("serverless oversized BLOB and malformed rows fail before validation, log shape and roll back", async t => {
  const log = t.mock.method(console, "log", () => {});
  for (const [rows, status, code, widths] of [
    [[[new Uint8Array(MAX_BYTES_PER_VALUE + 1)]], 413, "POLICYSQL_LIMIT_EXCEEDED", [1]],
    [[{ unrelated: "private-value" }], 422, "POLICYSQL_SCHEMA_MISMATCH", [1]],
    [[[]], 422, "POLICYSQL_SCHEMA_MISMATCH", [0]],
  ]) {
    let rolledBack = false, released = false;
    const runtime = {
      max_bytes_per_value: MAX_BYTES_PER_VALUE,
      validate_result_json() { assert.fail("invalid physical results must not reach WASM"); },
      release_execution() { released = true; },
    };
    const transaction = {
      usage: [],
      async execute() { return [{ columns: ["state"], rows, rowsAffected: 0, usage: { rowsRead: 1, rowsWritten: 0, queryDurationMs: 1 } }]; },
      async commit() { assert.fail("must roll back"); },
      async rollback() { rolledBack = true; },
    };
    await assert.rejects(executeSealedEnvelope(runtime, {
      executionHandle: 7, transactionMode: "read",
      statements: [{ operation: "select", protectedSql: "SELECT state FROM projects", clientParameters: {}, serverParameters: {}, result: [], limits: { timeoutMs: 1000 } }],
    }, {}, "req_invalid_result", () => ({ async begin() { return transaction; } })), { status, code });
    assert.ok(rolledBack);
    assert.ok(released);
    const logged = log.mock.calls.map(call => JSON.parse(call.arguments[0])).filter(entry => entry.event === "database_result_received").at(-1);
    assert.deepEqual(logged.rowWidths, widths);
    assert.ok(!JSON.stringify(logged).includes("private-value"));
    assert.equal(logged.valueTypes, undefined);
  }
});

// Regression (#22): a runtime whose Rust limit differs from the previous adapter
// constant must not turn valid WASM output into 500 POLICYSQL_INTERNAL. Parameters,
// raw driver results and the transport options all follow runtime.max_bytes_per_value.
test("execution follows the runtime's advertised per-value limit end to end", async t => {
  t.mock.method(console, "log", () => {});
  const statement = (base64) => ({
    operation: "select", protectedSql: "SELECT state FROM projects WHERE state = :state",
    clientParameters: { state: { type: "blob", base64 } }, serverParameters: {}, result: [], limits: { timeoutMs: 1000 },
  });
  for (const advertised of [MAX_BYTES_PER_VALUE * 2, 16]) {
    const fits = Buffer.alloc(advertised, 3);
    const over = new Uint8Array(advertised + 1);
    for (const [rows, expected] of [[[[new Uint8Array(fits)]], "validated"], [[[over]], 413]]) {
      let validated = false, rolledBack = false, beginOptions, boundArgs;
      const runtime = {
        max_bytes_per_value: advertised,
        validate_result_json(_handle, _index, raw) {
          validated = true;
          const value = JSON.parse(raw);
          assert.deepEqual(value.rows, [[{ type: "blob", base64: fits.toString("base64") }]]);
          return JSON.stringify({ ...value, rows: [["ok"]], redactions: [[false]] });
        },
        release_execution() {},
      };
      const provider = {
        check: () => true,
        connect: () => ({
          async begin(_mode, _timeoutMs, _deadlineMs, options) {
            beginOptions = options;
            return {
              open: true, usage: [],
              async execute(statements) {
                boundArgs = statements[0].args;
                return [{ columns: ["state"], rows, rowsAffected: 0, usage: { rowsRead: 1, rowsWritten: 0, queryDurationMs: 1 } }];
              },
              async commit() {}, async rollback() { rolledBack = true; },
            };
          },
        }),
      };
      const run = executeSealedEnvelope(runtime, { executionHandle: 9, transactionMode: "read", statements: [statement(fits.toString("base64"))] },
        {}, "req_drift", databaseTransportFactory(provider, testBinding(), runtime.max_bytes_per_value));
      if (expected === 413) {
        await assert.rejects(run, { status: 413, code: "POLICYSQL_LIMIT_EXCEEDED" }, `advertised=${advertised}`);
        assert.ok(rolledBack);
        assert.equal(validated, false);
      } else {
        await run;
        assert.ok(validated, `advertised=${advertised}`);
      }
      assert.deepEqual(beginOptions, { maxBytesPerValue: advertised });
      assert.deepEqual(Buffer.from(boundArgs.state), fits);
    }
  }
  // The interactive/callback path uses the same runtime value.
  const value = Buffer.alloc(MAX_BYTES_PER_VALUE + 1, 4).toString("base64");
  let bound;
  await executeSealedOnTransaction({
    max_bytes_per_value: MAX_BYTES_PER_VALUE * 2,
    validate_result_json: (_h, _i, raw) => JSON.stringify({ ...JSON.parse(raw), redactions: [] }),
    release_execution() {},
  }, { executionHandle: 3, statements: [statement(value)] }, {
    usage: [],
    async execute(statements) {
      bound = statements[0].args.state;
      return [{ columns: ["state"], rows: [], rowsAffected: 0, usage: { rowsRead: 0, rowsWritten: 0, queryDurationMs: 0 } }];
    },
  }, "req_drift_interactive");
  assert.equal(Buffer.from(bound).toString("base64"), value);
});

test("a runtime without a well-formed per-value limit cannot execute", async () => {
  for (const max_bytes_per_value of [undefined, 0, "262144"]) {
    let released = false;
    await assert.rejects(executeSealedOnTransaction({ max_bytes_per_value, release_execution() { released = true; } }, {
      executionHandle: 3,
      statements: [{ operation: "select", protectedSql: "SELECT 1", clientParameters: {}, serverParameters: {}, result: [], limits: { timeoutMs: 1000 } }],
    }, { usage: [], async execute() { assert.fail("must not reach the database"); } }, "req_bad_limit"), TypeError);
    assert.ok(released);
  }
});

// Regression (PR #24 review): a runtime with a malformed per-value limit is a host
// wiring defect. It fails as 500 before BEGIN, so a misconfiguration is neither a
// retryable 503 nor a database transaction opened and rolled back per retry.
test("a malformed runtime limit fails before BEGIN on serverless and interactive paths", async t => {
  t.mock.method(console, "log", () => {});
  const statement = { operation: "select", protectedSql: "SELECT 1", clientParameters: {}, serverParameters: {}, result: [], limits: { timeoutMs: 1000 } };
  for (const max_bytes_per_value of [undefined, 0, -1, 1.5, "262144", Infinity]) {
    let released = 0, begun = 0, connected = 0;
    const runtime = { max_bytes_per_value, release_execution() { released++; } };
    const transportFactory = async () => {
      connected++;
      return { async begin() { begun++; assert.fail("must not BEGIN"); } };
    };
    const error = await executeSealedEnvelope(runtime, { executionHandle: 9, transactionMode: "read", statements: [statement] },
      {}, "req_bad_runtime", transportFactory).then(() => assert.fail("must reject"), e => e);
    assert.ok(error instanceof TypeError, `limit=${String(max_bytes_per_value)}`);
    assert.notEqual(error.code, "POLICYSQL_DATABASE_UNAVAILABLE");
    assert.equal(connected, 0);
    assert.equal(begun, 0);
    assert.equal(released, 1, "the execution handle is still released");

    let executed = 0;
    await assert.rejects(executeSealedOnTransaction(runtime, { executionHandle: 3, statements: [statement] },
      { usage: [], async execute() { executed++; return []; } }, "req_bad_runtime_interactive"), TypeError);
    assert.equal(executed, 0);
    assert.equal(released, 2);
  }
});
