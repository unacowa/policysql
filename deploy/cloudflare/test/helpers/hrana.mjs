// Hrana pipeline helpers shared by the fake database servers. Statements go out as one
// conditional batch (#144); BEGIN, COMMIT, ROLLBACK stay plain `execute` requests.
import assert from "node:assert/strict";

/** The statements one pipeline request carries: a batch's steps, one `execute`, or none (`close`). */
export const stepStatements = (request) => {
  if (request.type === "batch") return request.batch.steps.map((step) => step.stmt);
  if (request.type === "execute") return [request.stmt];
  return [];
};

/** The SQL of every statement in every request, in order; a `close` is the string "close". */
export const requestSqls = (requests) => requests.flatMap((request) =>
  request.type === "close" ? ["close"] : stepStatements(request).map((stmt) => stmt.sql));

/**
 * Evaluates a batch as Hrana does: a step runs when it has no condition, or when its `ok`
 * condition names an earlier step that succeeded. Any other condition fails the test, so a
 * transport that sends a different shape is caught. `runStep(stmt, index)` returns an `ok` execute
 * entry or an `error` entry, and is called only for the steps that run.
 */
export const runBatch = async (request, runStep) => {
  const stepResults = [];
  const stepErrors = [];
  const succeeded = [];
  for (const [index, step] of request.batch.steps.entries()) {
    const { condition } = step;
    let run = true;
    if (condition !== undefined) {
      assert.equal(condition.type, "ok", "only ok conditions are expected");
      assert.ok(Number.isInteger(condition.step) && condition.step >= 0 && condition.step < index, "a condition names an earlier step");
      run = succeeded[condition.step] === true;
    }
    if (!run) {
      stepResults.push(null);
      stepErrors.push(null);
      succeeded.push(false);
      continue;
    }
    const entry = await runStep(step.stmt, index);
    if (entry.type === "ok") {
      stepResults.push(entry.response.result);
      stepErrors.push(null);
      succeeded.push(true);
    } else {
      stepResults.push(null);
      stepErrors.push(entry.error);
      succeeded.push(false);
    }
  }
  return { type: "ok", response: { type: "batch", result: { step_results: stepResults, step_errors: stepErrors, replication_index: null } } };
};

/**
 * A batch reply from per-step entries (`ok` execute entries or `error` entries) for tests that
 * build a reply by hand: the steps after the first error did not run.
 */
export const batchReply = (entries) => {
  const stepResults = [];
  const stepErrors = [];
  let failed = false;
  for (const entry of entries) {
    if (failed) {
      stepResults.push(null);
      stepErrors.push(null);
    } else if (entry.type === "ok") {
      stepResults.push(entry.response.result);
      stepErrors.push(null);
    } else {
      failed = true;
      stepResults.push(null);
      stepErrors.push(entry.error);
    }
  }
  return { type: "ok", response: { type: "batch", result: { step_results: stepResults, step_errors: stepErrors, replication_index: null } } };
};

/**
 * The reply entries for a pipeline when every statement succeeds with `entry` (a function of the
 * request, or a fixed entry): a batch gets a batch reply with one `entry` per step, `close` gets
 * its close entry, and a control `execute` gets `entry`.
 */
export const okResults = (requests, entry) => requests.map((request) => {
  const make = typeof entry === "function" ? entry : () => entry;
  if (request.type === "close") return { type: "ok", response: { type: "close" } };
  if (request.type === "batch") return batchReply(request.batch.steps.map((step) => make(step.stmt)));
  return make(request.stmt);
});
