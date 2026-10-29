import test from "node:test";
import assert from "node:assert/strict";
import { estimateSealedEnvelope, observeCostEnvelope } from "../src/cost.ts";
import { validateConfig } from "../src/engine-config.ts";

const compiled = {
  statements: [{
    operation: "select",
    protectedSql: "SELECT id FROM projects WHERE tenant_id = :tenant",
    costExplainSql: "EXPLAIN QUERY PLAN SELECT id FROM projects WHERE tenant_id = :tenant;",
    clientParameters: {},
    serverParameters: { tenant: "tenant_a" },
    explain: { resource: 1 },
  }],
};

// `PolicySqlConfig.costCatalog`, validated once by the engine (ADR 0021).
const catalog = validateConfig({
  environment: "test",
  costCatalog: { maxEstimatedRowsRead: 100, maxEstimatedRowsWritten: 100, resources: { 1: { upperRows: 20, uniqueSearchPatterns: ["unique_projects"] } } },
}).costCatalog;

const transport = (execute) => ({
  async begin() {
    return {
      open: true,
      usage: [{ rowsRead: 0, rowsWritten: 0, queryDurationMs: 0 }],
      async execute(statements) {
        const results = await execute(statements);
        this.usage.push(...results.map((result) => result.usage));
        return results;
      },
      async commit() { this.open = false; },
      async rollback() { this.open = false; },
    };
  },
});

test("bounds a statement from the catalog without interpreting planner prose", async () => {
  const fake = transport(async (statements) => {
      assert.match(statements[0].sql, /^EXPLAIN QUERY PLAN SELECT/);
      return [{
        columns: ["id", "parent", "notused", "detail"],
        rows: [[0, 0, 0, "SCAN projects"]],
        usage: { rowsRead: 0, rowsWritten: 0, queryDurationMs: 1 },
      }];
  });
  const result = await estimateSealedEnvelope(compiled, catalog, "req", () => fake, 1_024);
  assert.equal(result.estimates[0].upperRowsRead, 20);
  assert.equal(result.estimates[0].access, "unknown");
  assert.equal(result.estimates[0].planSteps, 1);
});

test("records complex planner output without treating unstable detail text as authority", async () => {
  const fake = transport(async () => {
      return [{
        columns: ["detail"],
        rows: [["SCAN outer"], ["CORRELATED SCALAR SUBQUERY"], ["SCAN inner"]],
        usage: { rowsRead: 0, rowsWritten: 0, queryDurationMs: 1 },
      }];
  });
  const result = await estimateSealedEnvelope(compiled, catalog, "req", () => fake, 1_024);
  assert.equal(result.estimates[0].upperRowsRead, 20);
  assert.equal(result.estimates[0].access, "unknown");
  assert.equal(result.estimates[0].planSteps, 3);
});

test("logs complex cost observations without blocking execution", async () => {
  const logs = [];
  const previous = console.log;
  console.log = (message) => logs.push(JSON.parse(message));
  try {
    const fake = transport(async () => [{
      columns: ["detail"],
      rows: [["SCAN outer"], ["CORRELATED SCALAR SUBQUERY"], ["SCAN inner"]],
      usage: { rowsRead: 0, rowsWritten: 0, queryDurationMs: 1 },
    }]);
    await observeCostEnvelope(compiled, catalog, "req", () => fake, 1_024);
  } finally {
    console.log = previous;
  }
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "cost_observation");
  assert.equal(logs[0].estimates[0].planSteps, 3);
});

test("logs cost observations and their own Turso usage", async () => {
  const logs = [];
  const previous = console.log;
  console.log = (message) => logs.push(JSON.parse(message));
  try {
    const fake = transport(async () => [{
      columns: ["detail"],
      rows: [["SCAN projects"]],
      usage: { rowsRead: 0, rowsWritten: 0, queryDurationMs: 2 },
    }]);
    await observeCostEnvelope(compiled, catalog, "req", () => fake, 1_024);
  } finally {
    console.log = previous;
  }
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "cost_observation");
  assert.equal(logs[0].estimates[0].upperRowsRead, 20);
  assert.equal(logs[0].usage.queryDurationMs, 2);
});

test("bounds inserts directly and updates conservatively without parsing SEARCH text", async () => {
  let statements;
  const fake = transport(async (input) => {
      statements = input;
      return [{
        columns: ["detail"],
        rows: [["SEARCH projects USING INDEX unique_projects (id=?)"]],
        usage: { rowsRead: 0, rowsWritten: 0, queryDurationMs: 1 },
      }];
  });
  const result = await estimateSealedEnvelope(
    {
      statements: [
        { ...compiled.statements[0], operation: "insert" },
        { ...compiled.statements[0], operation: "update" },
      ],
    },
    catalog,
    "req",
    () => fake,
    1_024,
  );
  assert.equal(statements.length, 1);
  assert.equal(result.estimates[0].upperRowsWritten, 1);
  assert.equal(result.estimates[1].upperRowsWritten, 20);
});

// Regression (PR #24 review): a malformed injected per-value limit fails before the
// cost transaction is opened, not as a BEGIN/rollback followed by a 503.
test("a malformed per-value limit fails before the cost transaction begins", async () => {
  for (const limit of [undefined, 0, "1024", Infinity]) {
    let connected = 0;
    const factory = () => { connected++; return { async begin() { assert.fail("must not BEGIN"); } }; };
    await assert.rejects(estimateSealedEnvelope(compiled, catalog, "req", factory, limit), TypeError, String(limit));
    assert.equal(connected, 0);
  }
});
