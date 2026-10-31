// Cost observation (ADR 0024 "Cost"): core's `observe` effect names the cost statements and the
// binding; the executor runs them in the background on a separate read connection and logs
// core's `cost_estimate_json` answer. It never affects a reply. Before ADR 0024 pull request 9
// these cases tested `src/cost.ts`, whose evaluation core took over (the evaluation itself is
// compared with `cost.ts`'s recorded answers in step-atomic-differential.test.mjs and tested in
// `crates/policysql-transaction/src/cost.rs`).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initSync, PolicySqlRuntime } from "../pkg/policysql_wasm.js";
import { observeCost } from "../src/step-effects.ts";
import { validateConfig } from "../src/engine-config.ts";
import { runtimeLimitsJson } from "../src/limits.ts";
import { testBinding } from "./helpers/database.mjs";
import { limitsJson } from "./helpers/limits.mjs";

initSync({ module: readFileSync(new URL("../pkg/policysql_wasm_bg.wasm", import.meta.url)) });

const CATALOG = `version: 1
resources:
  projects:
    source: { table: projects }
    columns:
      id: { type: string }
      tenant_id: { type: string }
`;
const POLICY = `version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
`;

// `PolicySqlConfig.costCatalog`, validated once by the engine (ADR 0021).
const costCatalog = validateConfig({
  environment: "test",
  costCatalog: { maxEstimatedRowsRead: 100, maxEstimatedRowsWritten: 100, resources: { 1: { upperRows: 20 } } },
}).costCatalog;

const withRuntime = (t, limits = {}) => {
  const runtime = new PolicySqlRuntime(CATALOG, POLICY, "schema_1", "policy_1",
    runtimeLimitsJson({ maxRows: 100, maxResultBytes: 64_000, timeoutMs: 1_000, maxStatements: 8, ...limits }));
  t.after(() => runtime.free());
  return runtime;
};

// An `observe` effect as core emits it: the cost statements of the non-insert statements, and
// one context entry per envelope statement.
const observe = (statements = [{ operation: "select", explainResource: 1 }]) => ({
  type: "observe",
  statements: statements.filter((statement) => statement.operation !== "insert")
    .map(() => ({ sql: "EXPLAIN QUERY PLAN SELECT id FROM projects WHERE tenant_id = :t", args: { t: "tenant_a" } })),
  context: { requestId: "req", binding: testBinding(), statements },
});

/** A provider whose cost connection answers each statement with `rows` of `detail`. */
const provider = (rows, seen = {}) => ({
  streamedReadCap: true, check() { return true; },
  connect(_binding, requestId) {
    seen.requestId = requestId;
    return {
      async begin(mode, timeoutMs, deadlineMs, options) {
        Object.assign(seen, { mode, timeoutMs, deadlineMs, options });
        return {
          open: true,
          usage: [],
          async execute(statements) {
            seen.statements = statements;
            return statements.map(() => {
              const usage = { rowsRead: 0, rowsWritten: 0, queryDurationMs: 2 };
              this.usage.push(usage);
              return { columns: ["id", "parent", "notused", "detail"], rows: rows.map((detail, index) => [index, 0, 0, detail]), usage };
            });
          },
          async commit() { this.open = false; seen.committed = true; },
          async rollback() { this.open = false; seen.rolledBack = true; },
        };
      },
    };
  },
});

const logged = (t) => {
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(JSON.parse(line)));
  return logs;
};

test("logs a cost observation from the catalog bound and its own connection's usage, without reading planner prose", async (t) => {
  const runtime = withRuntime(t);
  const logs = logged(t);
  const seen = {};
  await observeCost(observe(), { getRuntime: () => runtime, database: provider(["SCAN outer", "CORRELATED SCALAR SUBQUERY", "SCAN inner"], seen), costCatalog });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "cost_observation");
  assert.equal(logs[0].requestId, "req-cost", "a separate connection, named for the request");
  assert.equal(logs[0].estimates[0].upperRowsRead, 20);
  assert.equal(logs[0].estimates[0].access, "unknown");
  assert.equal(logs[0].estimates[0].planSteps, 3);
  assert.deepEqual(logs[0].usage, { rowsRead: 0, rowsWritten: 0, queryDurationMs: 2 });
  assert.equal(seen.requestId, "req-cost");
  assert.equal(seen.mode, "read");
  // The runtime's cost timeout, less what connecting took (the transport counts it).
  const { costTimeoutMs } = JSON.parse(runtime.limits_json());
  assert.ok(seen.timeoutMs <= costTimeoutMs && seen.timeoutMs > costTimeoutMs - 100, `${seen.timeoutMs}`);
  assert.deepEqual(seen.options, { maxBytesPerValue: JSON.parse(runtime.limits_json()).maxBytesPerValue });
  assert.deepEqual(seen.statements, [{ sql: "EXPLAIN QUERY PLAN SELECT id FROM projects WHERE tenant_id = :t", args: { t: "tenant_a" } }]);
  assert.equal(seen.committed, true);
});

test("bounds inserts directly and updates conservatively from the catalog", async (t) => {
  const runtime = withRuntime(t);
  const logs = logged(t);
  const seen = {};
  await observeCost(observe([{ operation: "insert", explainResource: 1 }, { operation: "update", explainResource: 1 }]), {
    getRuntime: () => runtime, database: provider(["SEARCH projects USING INDEX unique_projects (id=?)"], seen), costCatalog,
  });
  assert.equal(seen.statements.length, 1, "no plan is asked for an insert");
  assert.equal(logs[0].event, "cost_observation");
  assert.equal(logs[0].estimates[0].upperRowsWritten, 1);
  assert.equal(logs[0].estimates[1].upperRowsWritten, 20);
});

test("without a catalog the observation is logged as unknown and opens no database work", async (t) => {
  const runtime = withRuntime(t);
  const logs = logged(t);
  let connected = 0;
  // ADR 0021: a configuration without `costCatalog` (formerly in config.test.mjs).
  await observeCost(observe(), {
    getRuntime: () => runtime, database: { streamedReadCap: true, check() {}, connect() { connected++; } }, costCatalog: validateConfig({ environment: "test" }).costCatalog,
  });
  assert.equal(connected, 0);
  assert.deepEqual(logs, [{ event: "cost_observation_failed", requestId: "req-cost", code: "POLICYSQL_COST_UNKNOWN" }]);
});

test("a failed cost connection is logged and rolled back, and an estimate over the budget is logged", async (t) => {
  const runtime = withRuntime(t);
  const logs = logged(t);
  const refused = { streamedReadCap: true, check() { return true; }, connect() { throw new Error("connection refused"); } };
  await observeCost(observe(), { getRuntime: () => runtime, database: refused, costCatalog });
  const seen = {};
  const failing = provider(["SCAN projects"], seen);
  const connect = failing.connect;
  failing.connect = (...args) => {
    const transport = connect(...args);
    return { async begin(...options) {
      const transaction = await transport.begin(...options);
      transaction.execute = async () => { throw new Error("stream reset"); };
      return transaction;
    } };
  };
  await observeCost(observe(), { getRuntime: () => runtime, database: failing, costCatalog });
  assert.equal(seen.rolledBack, true, "the failed cost transaction is rolled back");
  const tight = validateConfig({ environment: "test", costCatalog: { maxEstimatedRowsRead: 5, maxEstimatedRowsWritten: 5, resources: { 1: { upperRows: 20 } } } }).costCatalog;
  await observeCost(observe(), { getRuntime: () => runtime, database: provider(["SCAN projects"]), costCatalog: tight });
  assert.deepEqual(logs.map((log) => [log.event, log.code]), [
    ["cost_observation_failed", "POLICYSQL_DATABASE_UNAVAILABLE"],
    ["cost_observation_failed", "POLICYSQL_COST_ADMISSION_UNAVAILABLE"],
    ["cost_observation_failed", "POLICYSQL_USAGE_BUDGET_EXCEEDED"],
  ]);
});

// Regression (PR #24 review): a malformed per-value limit fails before the cost transaction is
// opened, not as a BEGIN and rollback.
test("a malformed per-value limit fails before the cost connection is opened", async (t) => {
  t.mock.method(console, "log", () => {});
  for (const limit of [undefined, 0, "1024", Infinity]) {
    let connected = 0;
    const runtime = { limits_json: limitsJson({ maxBytesPerValue: limit }) };
    await assert.rejects(observeCost(observe(), {
      getRuntime: () => runtime, database: { streamedReadCap: true, check() {}, connect() { connected++; } }, costCatalog,
    }), TypeError, String(limit));
    assert.equal(connected, 0);
  }
});
