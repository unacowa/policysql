// Unit tests of the engine-side executor of the `request` kind (src/request-step.ts) over a
// scripted `step_json`, so the effect order is the test's, not core's (ADR 0024 pull request 8,
// #77 review): the engine's own binding check answers at most the first `checkBinding` of a
// request, and only when it names the same binding with no deadline.
import assert from "node:assert/strict";
import test from "node:test";
import { runRequestStep } from "../src/request-step.ts";
import { testBinding } from "./helpers/database.mjs";
import { MAX_BYTES_PER_VALUE as MAX_BYTES } from "./helpers/routing.mjs";

const reply = { ok: true, value: { done: true } };

/** A runtime whose `step_json` answers each call with the next scripted batch of effects. */
const scripted = (batches) => {
  const events = [];
  return {
    events,
    step_json(_durable, _volatile, eventText) {
      events.push(JSON.parse(eventText));
      const effects = batches.shift() ?? [{ type: "respond", lane: "client", reply }];
      return JSON.stringify({ durable: null, volatile: batches.length > 0 ? "{}" : null, effects });
    },
  };
};

const run = async (batches, checked = testBinding()) => {
  const runtime = scripted(batches);
  const calls = [];
  const database = {
    streamedReadCap: true, check(binding) { calls.push(binding); return true; },
    connect() { throw new Error("no connection in this test"); },
  };
  const result = await runRequestStep(
    { getRuntime: () => runtime, database, owner() { throw new Error("no owner"); } },
    { kind: "execute" },
    { requestId: "req_unit", checked, maxBytes: 1_024 },
  );
  return { result, calls, events: runtime.events };
};

const check = (id, binding, deadlineMs = null) => ({ type: "checkBinding", id, binding, deadlineMs });

test("the engine's binding check answers the first matching deadline-less checkBinding, once", async () => {
  const { result, calls, events } = await run([[check(1, testBinding())], [check(2, testBinding())]]);
  assert.deepEqual(result, reply);
  assert.equal(calls.length, 1, "only the second check reaches the provider");
  assert.deepEqual(events.slice(1).map((event) => [event.type, event.id]), [["bindingChecked", 1], ["bindingChecked", 2]]);
});

test("a first checkBinding that does not match consumes the cache: no later check is answered from it", async (t) => {
  for (const [label, first] of [
    ["another binding", check(1, { ...testBinding(), generation: "2" })],
    ["a deadline", check(1, testBinding(), Date.now() + 60_000)],
  ]) {
    await t.test(label, async () => {
      // The second check names the cached binding with no deadline; it must still call the provider.
      const { result, calls } = await run([[first], [check(2, testBinding())]]);
      assert.deepEqual(result, reply);
      assert.equal(calls.length, 2, label);
    });
  }
});

// ---- the direct placement's database effects (formerly turso.test.mjs, ADR 0024 pull request 9) ----

/**
 * Runs `open` and one `execute` of `args` through the executor over a provider whose
 * transaction answers `rows`, with the runtime's per-value limit `maxBytes`. Returns the event
 * the executor fed back for the `execute`, and what the provider saw.
 */
const executeOnce = async ({ args, rows, maxBytes }) => {
  const seen = { rolledBack: false, committed: false };
  const database = {
    streamedReadCap: true, check() { return true; },
    connect() {
      return {
        async begin(_mode, _timeoutMs, _deadlineMs, options) {
          seen.options = options;
          return {
            open: true, usage: [],
            async execute(statements) {
              seen.args = statements[0].args;
              return [{ columns: ["state"], rows, rowsAffected: 0, usage: { rowsRead: 1, rowsWritten: 0, queryDurationMs: 1 } }];
            },
            async commit() { seen.committed = true; this.open = false; },
            async rollback() { seen.rolledBack = true; this.open = false; },
          };
        },
      };
    },
  };
  const runtime = scripted([
    [{ type: "open", id: 1, binding: testBinding(), mode: "read", timeoutMs: 1_000, deadlineMs: Date.now() + 60_000 }],
    [{ type: "execute", id: 2, statements: [{ sql: "SELECT state FROM projects WHERE state = :state", args }] }],
    [{ type: "rollback", id: 3 }],
  ]);
  const result = await runRequestStep(
    { getRuntime: () => runtime, database, owner() { throw new Error("no owner"); } },
    { kind: "execute" },
    { requestId: "req_unit", checked: testBinding(), maxBytes },
  );
  assert.deepEqual(result, reply);
  return { event: runtime.events.find((event) => event.id === 2), seen };
};

// Regression (#22): a runtime whose Rust limit differs from a host constant must not turn valid
// WASM output into 500. Parameters, raw driver results, and the transport options all follow the
// runtime's `max_bytes_per_value`; a stored value over it reaches core as the `invalid` marker
// with `limit`, which core answers 413 (bytes.test.mjs end to end).
test("the executor follows the runtime's per-value limit for arguments, results, and the transport", async () => {
  for (const advertised of [MAX_BYTES * 2, 16]) {
    const fits = Buffer.alloc(advertised, 3);
    const base64 = fits.toString("base64");
    for (const [rows, expected] of [
      [[[new Uint8Array(fits)]], [[{ type: "blob", base64 }]]],
      [[[new Uint8Array(advertised + 1)]], [[{ type: "invalid", limit: true }]]],
    ]) {
      const { event, seen } = await executeOnce({ args: { state: { type: "blob", base64 } }, rows, maxBytes: advertised });
      assert.equal(event.type, "executed", `advertised=${advertised}`);
      assert.deepEqual(event.results[0].rows, expected, `advertised=${advertised}`);
      assert.deepEqual(seen.options, { maxBytesPerValue: advertised });
      assert.deepEqual(Buffer.from(seen.args.state), fits);
    }
  }
});

// Regression (PR #19 review): a driver value the codec cannot represent never reaches core's
// validation as data: it is the `invalid` marker (core answers 422), and a row whose shape does
// not match its columns fails the effect. Either way nothing is committed.
test("driver values and rows the codec cannot carry never reach core as data", async () => {
  const { event } = await executeOnce({ args: {}, rows: [[{ nested: "private-value" }]], maxBytes: MAX_BYTES });
  assert.deepEqual(event.results[0].rows, [[{ type: "invalid", limit: false }]]);
  for (const rows of [[{ unrelated: "private-value" }], [[]]]) {
    const { event: failed, seen } = await executeOnce({ args: {}, rows, maxBytes: MAX_BYTES });
    assert.equal(failed.type, "executeFailed", JSON.stringify(rows));
    assert.equal(JSON.stringify(failed).includes("private-value"), false);
    assert.equal(seen.committed, false);
  }
});
