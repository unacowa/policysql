import assert from "node:assert/strict";
import test from "node:test";
import { testBinding, testProvider } from "./helpers/database.mjs";
import { identity_json } from "./helpers/identity.mjs";
import { TransactionOwnerCore, checkBatch } from "../src/transaction-owner.ts";
import { limitsJson } from "./helpers/limits.mjs";

// Unit tests of the owner core through the port's owner-side facilities (ADR 0022): an
// in-memory store, a recorded timer, and background tasks. No platform object is involved.
//
// The owner executes the step machine, which needs the real WASM runtime for its decisions;
// its scenarios run through the differential harnesses against their recorded reference
// (step-differential.test.mjs, step-atomic-differential.test.mjs), the port conformance suite
// (transaction-owner-port.test.mjs), the switch-over tests, and the machine's own tests in
// `crates/policysql-transaction`. The cases here need no decision of core: the executor's own
// rules over a scripted `step_json`.
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
const config = { environment: "test" };
const txId = `tx_${"a".repeat(32)}`;
const startFingerprint = "c".repeat(64);
const auth = { principal: "test:u1", subject: "u1", role: "member", roles: ["member"], access: ["execute"], session: { tenant_id: "tenant_a" } };

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
