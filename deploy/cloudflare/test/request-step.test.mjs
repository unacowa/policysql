// Unit tests of the engine-side executor of the `request` kind (src/request-step.ts) over a
// scripted `step_json`, so the effect order is the test's, not core's (ADR 0024 pull request 8,
// #77 review): the engine's own binding check answers at most the first `checkBinding` of a
// request, and only when it names the same binding with no deadline.
import assert from "node:assert/strict";
import test from "node:test";
import { runRequestStep } from "../src/request-step.ts";
import { testBinding } from "./helpers/database.mjs";

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
    check(binding) { calls.push(binding); return true; },
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
