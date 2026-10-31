// #54 case 2: a failure before any byte of COMMIT is sent (the transport's last binding check
// and deadline check) is a provable "not committed". The transaction is rolled back, no COMMIT
// reaches the database, and the answer is the definite 409 POLICYSQL_TRANSACTION_UNAVAILABLE.
// A failure of the COMMIT request itself stays an unknown outcome (ADR 0007).
//
// Both owner adapters, and every placement that sends a COMMIT: atomic on the direct path,
// atomic on an owner, interactive (without and with a commit check).
import assert from "node:assert/strict";
import test from "node:test";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";
import { PolicySqlError, PolicySqlOutcomeUnknownError } from "../../../packages/client/index.js";
import { sendCommand } from "../../../packages/client/protocol.js";

const insert = (id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name: id } });
const count = (h, id) => h.rows("a").filter((row) => row.id === id).length;
const PLACEMENTS = [
  { name: "atomic direct", hooks: false, kind: "execute" },
  { name: "atomic owner", hooks: true, kind: "execute" },
  { name: "interactive", hooks: false, kind: "commit" },
  { name: "interactive with a commit check", hooks: true, kind: "commit" },
];

// A harness whose provider can deny, or push the clock past every deadline after allowing, the
// n-th binding check from now.
const setup = async (t, ownerAdapter, hooks) => {
  t.mock.method(console, "log", () => {});
  const control = { checks: 0, denyAt: -1, expireAt: -1, offset: 0 };
  const realNow = Date.now;
  t.mock.method(Date, "now", () => realNow.call(Date) + control.offset);
  const h = await harness(t, {
    ownerAdapter, hooks,
    customizeProvider: (provider) => ({
      ...provider,
      async check(binding) {
        control.checks++;
        if (control.checks === control.denyAt) return false;
        const allowed = await provider.check(binding);
        if (control.checks === control.expireAt) control.offset = 600_000;
        return allowed;
      },
    }),
  });
  h.setValidator(async () => true);
  return { h, control };
};

// Runs `operation` once to learn how many binding checks it makes (the last one is the
// transport's, right before COMMIT), then arms the given fault on the last check of `again`.
const fault = (control, kind, checksOfOperation) => {
  const at = control.checks + checksOfOperation;
  if (kind === "binding") control.denyAt = at;
  else control.expireAt = at;
};

// One attempt of the placement's commit command, armed or not. Returns what to assert on.
const attempt = async (h, control, placement, id, { armed = null, checksOfCommit = 0, key } = {}) => {
  const mark = h.events.length;
  let response;
  let path;
  let transactionId;
  if (placement.kind === "execute") {
    if (armed) fault(control, armed, checksOfCommit);
    const before = control.checks;
    response = await h.request("a", "/v1/transactions:execute", { statements: [insert(id)] }, key);
    control.offset = 0;
    return { response, checks: control.checks - before, sent: h.events.slice(mark).map(({ sql }) => sql) };
  }
  const begun = await h.request("a", "/v1/transactions", { mode: "write" }, null);
  assert.equal(begun.status, 201, JSON.stringify(begun.body));
  transactionId = begun.body.transactionId;
  path = `/v1/transactions/${transactionId}`;
  const statement = await h.request("a", `${path}/statements`, { sequence: 1, ...insert(id) }, null);
  assert.equal(statement.status, 200, JSON.stringify(statement.body));
  const mark2 = h.events.length;
  if (armed) fault(control, armed, checksOfCommit);
  const before = control.checks;
  response = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
  control.offset = 0;
  return { response, checks: control.checks - before, sent: h.events.slice(mark2).map(({ sql }) => sql), path, transactionId };
};

const definite = async (response, kind) => {
  const transport = async () => ({ status: response.status, body: response.body });
  await assert.rejects(sendCommand(transport, { kind }, {}, () => {}), (error) =>
    error instanceof PolicySqlError && !(error instanceof PolicySqlOutcomeUnknownError) &&
    error.code === "POLICYSQL_TRANSACTION_UNAVAILABLE");
};
const unknown = async (response, kind) => {
  const transport = async () => ({ status: response.status, body: response.body });
  await assert.rejects(sendCommand(transport, { kind }, {}, () => {}), PolicySqlOutcomeUnknownError);
};

for (const ownerAdapter of OWNER_ADAPTERS) {
  for (const placement of PLACEMENTS) {
    const label = `${ownerAdapter}/${placement.name}`;
    for (const faultKind of ["binding", "deadline"]) {
      test(`${label}: ${faultKind === "binding" ? "an invalid binding" : "an exhausted deadline"} right before COMMIT is a definite rejection, rolled back, no COMMIT sent`, async (t) => {
        const { h, control } = await setup(t, ownerAdapter, placement.hooks);
        const key = placement.kind === "execute" ? `not-sent-${faultKind}-key-01` : undefined;
        const baseline = await attempt(h, control, placement, "baseline", { key: key && "not-sent-baseline-key1" });
        assert.equal(baseline.response.status, 200, JSON.stringify(baseline.response.body));
        assert.ok(baseline.sent.includes("COMMIT"), "the baseline commits");
        const run = await attempt(h, control, placement, "faulted", { armed: faultKind, checksOfCommit: baseline.checks, key });
        assert.equal(run.response.status, 409, JSON.stringify(run.response.body));
        assert.equal(run.response.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
        assert.ok(run.sent.includes("ROLLBACK"), "rolled back");
        assert.equal(run.sent.includes("COMMIT"), false, "no COMMIT was sent");
        assert.equal(count(h, "faulted"), 0, "nothing committed");
        await definite(run.response, placement.kind);
        assert.equal(JSON.stringify(run.response.body).includes("denied"), false, "no cause is exposed");
      });
    }

    // Regression: COMMIT sent, then its reply fails: still unknown, never a rejection.
    test(`${label}: a COMMIT that was sent and then fails stays an unknown outcome`, async (t) => {
      const { h } = await setup(t, ownerAdapter, placement.hooks);
      let armed = true;
      h.replaceDatabaseResponse(({ sqls }) => {
        if (!armed || sqls[0] !== "COMMIT") return undefined;
        armed = false;
        return new Response("unavailable", { status: 503 });
      });
      const control = { checks: 0 };
      const run = await attempt(h, control, placement, "sent", { key: placement.kind === "execute" ? "not-sent-regress-key1" : undefined });
      assert.ok(run.sent.includes("COMMIT"), "COMMIT was sent");
      assert.notEqual(run.response.status, 409, JSON.stringify(run.response.body));
      assert.equal(run.response.status >= 500, true, JSON.stringify(run.response.body));
      await unknown(run.response, placement.kind);
      assert.equal(count(h, "sent"), 1, "the database applied it");
      if (placement.kind === "commit") {
        assert.equal(run.response.body.error.code, "POLICYSQL_COMMIT_OUTCOME_UNKNOWN");
        const retry = await h.request("a", `${run.path}/commit`, { sequence: 2 }, null);
        assert.equal(retry.body.error.code, "POLICYSQL_COMMIT_OUTCOME_UNKNOWN", "the retry stays unknown");
      }
    });

    // The deadline runs out while COMMIT is in flight (the reply body read times out): COMMIT was
    // sent, so the answer is never a rejection, whichever placement. The transport's own pre-send
    // deadline check cannot be driven end to end on its own: the wrapper's identical check runs
    // first and gives the same 409; it is covered by turso-http.test.mjs and database-routing.test.mjs.
    test(`${label}: a deadline that runs out while COMMIT is in flight stays an unknown outcome`, async (t) => {
      const { h } = await setup(t, ownerAdapter, placement.hooks);
      let armed = true;
      h.replaceDatabaseResponse(({ sqls }) => {
        if (!armed || sqls[0] !== "COMMIT") return undefined;
        armed = false;
        const body = new ReadableStream({ pull(controller) { controller.error(new DOMException("timed out", "TimeoutError")); } });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      });
      const run = await attempt(h, { checks: 0 }, placement, "inflight", { key: placement.kind === "execute" ? "not-sent-inflight-key" : undefined });
      assert.ok(run.sent.includes("COMMIT"), "COMMIT was sent");
      assert.notEqual(run.response.status, 409, JSON.stringify(run.response.body));
      assert.equal(run.response.status >= 500, true, JSON.stringify(run.response.body));
      await unknown(run.response, placement.kind);
      assert.equal(count(h, "inflight"), 1, "the database applied it");
    });

    // The retry after a not-committed answer: atomic runs again as a new attempt, interactive
    // finds a transaction that is no longer active (a definite answer again), and a new
    // transaction is unaffected.
    test(`${label}: a retry after a not-committed answer behaves as the existing rules say`, async (t) => {
      const { h, control } = await setup(t, ownerAdapter, placement.hooks);
      const baseline = await attempt(h, control, placement, "baseline", { key: placement.kind === "execute" ? "not-sent-baseline-key2" : undefined });
      const key = placement.kind === "execute" ? "not-sent-retry-key-001" : undefined;
      const first = await attempt(h, control, placement, "retried", { armed: "binding", checksOfCommit: baseline.checks, key });
      assert.equal(first.response.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
      if (placement.kind === "execute") {
        const retry = await attempt(h, control, placement, "retried", { key });
        assert.equal(retry.response.status, 200, JSON.stringify(retry.response.body));
        assert.ok(retry.sent.includes("COMMIT"), "a new attempt committed");
        assert.equal(count(h, "retried"), 1);
        const replay = await attempt(h, control, placement, "retried", { key });
        assert.equal(replay.response.status, 200);
        assert.deepEqual(replay.response.body.results, retry.response.body.results);
        assert.equal(replay.sent.includes("COMMIT"), false, "a replay does not run again");
        assert.equal(count(h, "retried"), 1);
      } else {
        const retry = await h.request("a", `${first.path}/commit`, { sequence: 2 }, null);
        assert.equal(retry.status, 409, JSON.stringify(retry.body));
        assert.equal(retry.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
        assert.equal(count(h, "retried"), 0);
        const record = await h.ownerRecord(first.transactionId);
        assert.equal(record.status, "failed");
        const next = await attempt(h, control, placement, "after");
        assert.equal(next.response.status, 200, JSON.stringify(next.response.body));
        assert.equal(count(h, "after"), 1);
      }
    });
  }
}
