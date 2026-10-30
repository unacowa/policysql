// #85, path 2: a Worker and a Durable Object of the same `/atomic` wire version but another
// ABI (another snapshot) meet during a rollout. The owner reads the Worker's snapshot, finds it
// is not its own, and runs nothing. The Worker may be retrying a keyed write that already
// committed, so the answer must never be one the client takes as a definite rejection
// (ADR 0007): it is the version-skew answer, 500 POLICYSQL_INTERNAL, the one a wire-version
// skew gets, and the retry replays from the idempotency row once the versions agree again.
// A legitimate TRANSACTION_CONFLICT (a busy owner, a sequence conflict) stays a rejection.
import assert from "node:assert/strict";
import test from "node:test";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";
import { PolicySqlOutcomeUnknownError } from "../../../packages/client/index.js";
import { REJECTIONS, sendCommand } from "../../../packages/client/protocol.js";

const insert = (id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name: id } });
const commits = (h) => h.events.filter(({ sql }) => sql === "COMMIT").length;
const count = (h, id) => h.rows("a").filter((row) => row.id === id).length;

for (const ownerAdapter of OWNER_ADAPTERS) {
  // `hooks: true` makes the commit check trigger, so a keyed execute runs on its owner.
  const ownerHarness = async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { ownerAdapter, hooks: true });
    h.setValidator(async () => true);
    return h;
  };

  test(`${ownerAdapter}: #85: a keyed write retried while the owner has another snapshot is skew (500), not a rejection, and replays after`, async (t) => {
    const h = await ownerHarness(t);
    const key = "owner-skew-key-000001";
    const body = { statements: [insert("skew_1")] };
    const first = await h.request("a", "/v1/transactions:execute", body, key);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(h.ownerNames().length, 1, "the owner placement");
    const committed = commits(h);

    // The owners roll to another snapshot; the Worker keeps its own.
    const owner = h.skewOwners({ policyVersion: "policy_routing_2" });
    assert.notEqual(owner.snapshot, h.runtime.snapshot);
    const skewed = await h.request("a", "/v1/transactions:execute", body, key);
    assert.equal(skewed.status, 500, JSON.stringify(skewed.body));
    assert.equal(skewed.body.error.code, "POLICYSQL_INTERNAL");
    assert.equal(skewed.body.error.message, "The request could not be completed.");
    assert.equal(commits(h), committed, "the owner ran nothing");
    assert.equal(count(h, "skew_1"), 1);

    // The same for a key that did not commit anything, and for a request without a key.
    for (const [label, requestKey, id] of [["new key", "owner-skew-key-000002", "skew_2"], ["no key", null, "skew_3"]]) {
      const response = await h.request("a", "/v1/transactions:execute", { statements: [insert(id)] }, requestKey);
      assert.equal(response.status, 500, `${label}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.code, "POLICYSQL_INTERNAL", label);
      assert.equal(count(h, id), 0, `${label}: nothing executed`);
    }

    // The skew ends: the retry replays the committed response, never a second execution.
    h.skewOwners(null);
    const retry = await h.request("a", "/v1/transactions:execute", body, key);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.deepEqual(retry.body.results, first.body.results);
    assert.equal(retry.body.transactionId, first.body.transactionId);
    assert.equal(commits(h), committed, "no second COMMIT");
    assert.equal(count(h, "skew_1"), 1, "never executed twice");
  });

  // The client: the skew answer is an unknown outcome for execute, as the wire-skew answer is.
  test(`${ownerAdapter}: #85: the client takes the owner's skew answer as an unknown outcome`, async (t) => {
    const h = await ownerHarness(t);
    h.skewOwners({ policyVersion: "policy_routing_2" });
    const response = await h.request("a", "/v1/transactions:execute", { statements: [insert("skew_4")] }, "owner-skew-key-000003");
    const transport = async () => ({ status: response.status, body: response.body });
    await assert.rejects(sendCommand(transport, { kind: "execute" }, {}, () => {}), PolicySqlOutcomeUnknownError);
    assert.equal(REJECTIONS.get(500), undefined, "no code of a 500 is a rejection");
  });

  // Bypass: the skew answer is not a way to run the request. The owner executes nothing, and
  // a request whose binding names a snapshot other than the Worker's is still stale.
  test(`${ownerAdapter}: #85: bypass: a skewed owner executes nothing, and a binding of another snapshot is still stale`, async (t) => {
    const h = await ownerHarness(t);
    h.skewOwners({ policyVersion: "policy_routing_2" });
    const before = h.events.length;
    const skewed = await h.request("a", "/v1/transactions:execute", { statements: [insert("skew_5")] }, "owner-skew-key-000004");
    assert.equal(skewed.status, 500, JSON.stringify(skewed.body));
    assert.equal(h.events.length, before, "no database statement ran");
    h.skewOwners(null);
    const earlier = h.binding("a");
    h.redeploy({ policyVersion: "policy_routing_3" });
    const response = await h.app.fetch(new Request("https://worker.test/v1/transactions:execute", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "owner-skew-key-000005" },
      body: JSON.stringify({ statements: [insert("skew_6")] }),
    }), { database: earlier, session: h.session("a") }, h.background);
    const stale = await response.json();
    assert.equal(response.status, 409, JSON.stringify(stale));
    assert.equal(stale.error.code, "POLICYSQL_STALE_OPERATION");
    assert.equal(count(h, "skew_6"), 0);
  });

  // Interactive owner paths: nothing is a rejection of a COMMIT that may have been sent. A
  // transaction still active when the owners change snapshot is closed without a COMMIT.
  test(`${ownerAdapter}: #85: interactive: a commit after the owners changed snapshot never applies, and begin is skew`, async (t) => {
    const h = await ownerHarness(t);
    const begun = await h.request("a", "/v1/transactions", { mode: "write" });
    assert.equal(begun.status, 201, JSON.stringify(begun.body));
    const id = begun.body.transactionId;
    const statement = await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("skew_7") });
    assert.equal(statement.status, 200, JSON.stringify(statement.body));
    const committed = commits(h);
    h.skewOwners({ policyVersion: "policy_routing_2" });
    const commit = await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 });
    assert.notEqual(commit.status, 200, JSON.stringify(commit.body));
    assert.equal(commits(h), committed, "COMMIT was never sent");
    assert.equal(count(h, "skew_7"), 0);
    // A new transaction on a skewed owner is the skew answer, not a conflict with a state.
    const begin = await h.request("a", "/v1/transactions", { mode: "write" }, "owner-skew-begin-0001");
    assert.equal(begin.status, 500, JSON.stringify(begin.body));
    assert.equal(begin.body.error.code, "POLICYSQL_INTERNAL");
  });

  // Regression: a legitimate TRANSACTION_CONFLICT stays a rejection (a sequence conflict).
  test(`${ownerAdapter}: #85: regression: a statement sequence conflict is still TRANSACTION_CONFLICT`, async (t) => {
    const h = await ownerHarness(t);
    const begun = await h.request("a", "/v1/transactions", { mode: "write" });
    const id = begun.body.transactionId;
    const conflict = await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 5, ...insert("skew_8") });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, "POLICYSQL_TRANSACTION_CONFLICT");
  });
}
