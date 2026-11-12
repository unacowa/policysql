// #85 path 1: a keyed write that committed, then a deployment in which its compile (or the
// wrapper's session authorization) fails. The request may be the retry of a write whose COMMIT
// was sent, so the answer must never be one the client takes as a definite rejection (ADR 0007):
// it is 500 POLICYSQL_OUTCOME_UNKNOWN (the unknown outcome) on both placements, with the refusal
// the same request would have drawn without a key as `detail.cause` (#145, ADR 0030); nothing is
// looked up or replayed, and a later deployment whose compile accepts the request replays the
// stored result. An unkeyed request has no replay contract and keeps its definite compile error
// or 403.
import assert from "node:assert/strict";
import test from "node:test";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";
import { PolicySqlOutcomeUnknownError } from "../../../packages/client/index.js";
import { REJECTIONS, sendCommand } from "../../../packages/client/protocol.js";

const insert = (id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name: id } });
const commits = (h) => h.events.filter(({ sql }) => sql === "COMMIT").length;
const count = (h, id) => h.rows("a").filter((row) => row.id === id).length;
const idempotencyRows = (h) => h.databases.get("a").database.prepare("SELECT count(*) AS n FROM policysql_idempotency").get().n;
// The example policy's only INSERT permission: removing it makes an INSERT a compile error
// ("No policy permits this operation."), as a policy change does.
const denyInsert = (policy) => policy.replace(/^        insert:\n(?:^          .*\n)+/gmu, "");
const MESSAGE = "This request was not executed. The outcome of an earlier request with the same Idempotency-Key is unknown.";
// The unknown outcome: a fixed message, no top-level path, and the refusal as the cause. The
// cause is also what the unkeyed request answers (the differential), and holds nothing else.
const sameCause = (keyed, unkeyed, label) => {
  assert.deepEqual(keyed.body.error.detail, { cause: { code: unkeyed.body.error.code, path: unkeyed.body.error.path, detail: unkeyed.body.error.detail ?? null } }, `${label}: the cause is the unkeyed answer`);
  assert.ok(unkeyed.body.error.detail === undefined || !("cause" in unkeyed.body.error.detail), `${label}: an unkeyed refusal has no cause`);
};
const unknown = (response, label, cause, unkeyed) => {
  assert.equal(response.status, 500, `${label}: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.error.code, "POLICYSQL_OUTCOME_UNKNOWN", label);
  assert.equal(response.body.error.message, MESSAGE, label);
  assert.equal(response.body.error.path, null, label);
  assert.deepEqual(response.body.error.detail, { cause: { detail: null, ...cause } }, label);
  assert.deepEqual(Object.keys(response.body.error), ["code", "message", "path", "detail", "requestId"], label);
  assert.equal(response.body.results, undefined, `${label}: the stored result is not returned`);
  if (unkeyed !== undefined) sameCause(response, unkeyed, label);
  const text = JSON.stringify(response.body);
  assert.ok(!/INSERT|keyed_|\bname\b/u.test(JSON.stringify(response.body.error.detail)), `${label}: the cause holds no SQL, parameter, or name: ${text}`);
};

for (const ownerAdapter of OWNER_ADAPTERS) {
  // Neither placement commits again, runs SQL, calls the validator, or opens a connection.
  const unchanged = (h, { events, checks, connects, rows, commits: before }) => {
    assert.equal(h.events.length, events, "no database statement ran");
    assert.equal(h.hooksSeen.length, checks, "no commit check");
    assert.equal(h.counts().connects, connects, "no connection");
    assert.equal(idempotencyRows(h), rows, "the idempotency row is untouched");
    assert.equal(commits(h), before, "no second COMMIT");
  };

  for (const [placement, hooks] of [["direct", false], ["owner", true]]) {
    test(`${ownerAdapter}: #85 path 1: a keyed write retried after a policy change (${placement}) is unknown, then replays`, async (t) => {
      t.mock.method(console, "log", () => {});
      let denied = false;
      const h = await harness(t, {
        ownerAdapter, hooks,
        customizePolicy: (policy) => denied ? denyInsert(policy) : policy,
      });
      h.setValidator(async () => true);
      const key = "keyed-policy-change-0001";
      const body = { statements: [insert("keyed_policy")] };
      const first = await h.request("a", "/v1/transactions:execute", body, key);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.meta.commitChecks, hooks ? "passed" : "not_triggered", "the placement");
      assert.equal(commits(h), 1);
      assert.equal(count(h, "keyed_policy"), 1);
      assert.equal(idempotencyRows(h), 1);
      const before = {
        events: h.events.length, checks: h.hooksSeen.length,
        connects: h.counts().connects, rows: idempotencyRows(h), commits: commits(h),
      };

      // The deploy forbids the statement the committed write used.
      denied = true;
      h.redeploy({ policyVersion: "policy_routing_2" });
      const retry = await h.request("a", "/v1/transactions:execute", body, key);
      const unkeyedRetry = await h.request("a", "/v1/transactions:execute", body, null);
      assert.equal(unkeyedRetry.body.error.code, "POLICYSQL_MISSING_POLICY");
      unknown(retry, "policy change", { code: "POLICYSQL_MISSING_POLICY", path: "/statements/0" }, unkeyedRetry);
      unchanged(h, before);
      assert.equal(count(h, "keyed_policy"), 1, "never executed twice");

      // The client takes the answer as an unknown outcome, not a rejection.
      const transport = async () => ({ status: retry.status, body: retry.body });
      await assert.rejects(sendCommand(transport, { kind: "execute" }, {}, () => {}), PolicySqlOutcomeUnknownError);
      assert.equal(REJECTIONS.get(500), undefined, "no code of a 500 is a rejection");

      // Bypass: a keyed request that never committed is unknown too (the row is not evidence of
      // absence), while an unkeyed request keeps the definite compile error and executes nothing.
      unknown(await h.request("a", "/v1/transactions:execute", { statements: [insert("keyed_policy_2")] }, "keyed-policy-change-0002"), "fresh key", { code: "POLICYSQL_MISSING_POLICY", path: "/statements/0" });
      assert.equal(count(h, "keyed_policy_2"), 0);
      const unkeyed = await h.request("a", "/v1/transactions:execute", { statements: [insert("keyed_policy_3")] }, null);
      assert.equal(unkeyed.status, 403, JSON.stringify(unkeyed.body));
      assert.equal(unkeyed.body.error.code, "POLICYSQL_MISSING_POLICY");
      assert.equal(count(h, "keyed_policy_3"), 0);
      unchanged(h, before);

      // A deployment that compiles it again replays the committed response, never a second run.
      denied = false;
      h.redeploy({ policyVersion: "policy_routing_3" });
      const replay = await h.request("a", "/v1/transactions:execute", body, key);
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.deepEqual(replay.body.results, first.body.results);
      assert.equal(replay.body.transactionId, first.body.transactionId);
      assert.equal(replay.body.meta.policyVersion, "policy_routing_3", "the answering deploy");
      assert.equal(commits(h), before.commits, "no second COMMIT");
      assert.equal(count(h, "keyed_policy"), 1, "never executed twice");
    });

    test(`${ownerAdapter}: #85 path 1: a keyed write whose expected is stale after a deploy (${placement}) is unknown, not STALE_OPERATION`, async (t) => {
      t.mock.method(console, "log", () => {});
      const h = await harness(t, { ownerAdapter, hooks });
      h.setValidator(async () => true);
      const key = "keyed-expected-change-0001";
      const body = {
        expected: { schemaVersion: "schema_routing_1", policyVersion: "policy_routing_1" },
        statements: [insert("keyed_expected")],
      };
      const first = await h.request("a", "/v1/transactions:execute", body, key);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const before = { events: h.events.length, checks: h.hooksSeen.length, connects: h.counts().connects, rows: idempotencyRows(h), commits: commits(h) };

      h.redeploy({ policyVersion: "policy_routing_2" });
      const retry = await h.request("a", "/v1/transactions:execute", body, key);
      unknown(retry, "expected", { code: "POLICYSQL_STALE_OPERATION", path: null });
      assert.notEqual(retry.body.error.code, "POLICYSQL_STALE_OPERATION");
      unchanged(h, before);
      assert.equal(count(h, "keyed_expected"), 1);

      // Negative control: without a key the same mismatch is the definite compile error.
      const unkeyed = await h.request("a", "/v1/transactions:execute", {
        expected: { schemaVersion: "schema_routing_1", policyVersion: "policy_routing_1" },
        statements: [insert("keyed_expected_2")],
      }, null);
      assert.equal(unkeyed.status, 409, JSON.stringify(unkeyed.body));
      assert.equal(unkeyed.body.error.code, "POLICYSQL_STALE_OPERATION");
      sameCause(retry, unkeyed, "expected");
      assert.equal(count(h, "keyed_expected_2"), 0);
      unchanged(h, before);

      // The matching deploy lets the same body and key replay.
      h.redeploy({ policyVersion: "policy_routing_1" });
      const replay = await h.request("a", "/v1/transactions:execute", body, key);
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.equal(replay.body.transactionId, first.body.transactionId);
      assert.deepEqual(replay.body.results, first.body.results);
      assert.equal(commits(h), before.commits);
      assert.equal(count(h, "keyed_expected"), 1);
    });

    test(`${ownerAdapter}: #85 path 1: a keyed execute whose session lost execute access (${placement}) is unknown, then replays`, async (t) => {
      t.mock.method(console, "log", () => {});
      const h = await harness(t, { ownerAdapter, hooks });
      h.setValidator(async () => true);
      const key = "keyed-access-loss-0001";
      const body = { statements: [insert("keyed_access")] };
      const first = await h.request("a", "/v1/transactions:execute", body, key);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const before = { events: h.events.length, checks: h.hooksSeen.length, connects: h.counts().connects, rows: idempotencyRows(h), commits: commits(h) };

      // A deploy in which the wrapper's session no longer grants `execute` (the role lost it).
      const reduced = h.session("a", { access: ["catalog"] });
      const retry = await h.request("a", "/v1/transactions:execute", body, key, reduced);
      unknown(retry, "access loss", { code: "POLICYSQL_FORBIDDEN_ACCESS", path: null });
      unchanged(h, before);
      assert.equal(count(h, "keyed_access"), 1);

      // Without a key the same session is the definite 403 and still runs nothing.
      const unkeyed = await h.request("a", "/v1/transactions:execute", { statements: [insert("keyed_access_2")] }, null, reduced);
      assert.equal(unkeyed.status, 403, JSON.stringify(unkeyed.body));
      assert.equal(unkeyed.body.error.code, "POLICYSQL_FORBIDDEN_ACCESS");
      sameCause(retry, unkeyed, "access loss");
      assert.equal(count(h, "keyed_access_2"), 0);
      unchanged(h, before);

      // The same key under the restored session replays the committed result.
      const replay = await h.request("a", "/v1/transactions:execute", body, key);
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.equal(replay.body.transactionId, first.body.transactionId);
      assert.deepEqual(replay.body.results, first.body.results);
      assert.equal(commits(h), before.commits);
      assert.equal(count(h, "keyed_access"), 1);
    });
  }

  // #145: the refusal the keyed answer hides is in the log (`request_rejected.cause`), the answer
  // carries nothing but the code and path (no SQL text, parameter value, or column name), and an
  // unkeyed refusal logs `cause: null`.
  for (const [placement, hooks] of [["direct", false], ["owner", true]]) {
    test(`${ownerAdapter}: #145: request_rejected carries the cause of a keyed unknown outcome and the answer holds no request text (${placement})`, async (t) => {
      const logs = [];
      t.mock.method(console, "log", (line) => { logs.push(String(line)); });
      const h = await harness(t, { ownerAdapter, hooks, customizePolicy: denyInsert });
      h.setValidator(async () => true);
      const secretName = "secret_parameter_value_7";
      const body = { statements: [{ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id: "p_log", name: secretName } }] };
      const rejections = () => logs.map((line) => { try { return JSON.parse(line); } catch { return {}; } }).filter((record) => record.event === "request_rejected");

      const keyed = await h.request("a", "/v1/transactions:execute", body, "keyed-log-cause-key-0001");
      assert.equal(keyed.status, 500, JSON.stringify(keyed.body));
      const [loggedKeyed] = rejections();
      assert.equal(loggedKeyed.code, "POLICYSQL_OUTCOME_UNKNOWN");
      assert.deepEqual(loggedKeyed.cause, { code: "POLICYSQL_MISSING_POLICY", path: "/statements/0", detail: null });
      assert.deepEqual(Object.keys(loggedKeyed).sort(), ["cause", "code", "event", "internalClass", "internalCode", "requestId"]);

      const unkeyed = await h.request("a", "/v1/transactions:execute", body, null);
      assert.equal(unkeyed.status, 403, JSON.stringify(unkeyed.body));
      const loggedUnkeyed = rejections().at(-1);
      assert.equal(loggedUnkeyed.code, "POLICYSQL_MISSING_POLICY");
      assert.equal(loggedUnkeyed.cause, null);
      assert.deepEqual(Object.keys(loggedUnkeyed).sort(), Object.keys(loggedKeyed).sort(), "one fixed set of keys");

      // The answer and the logs hold the code and path only: nothing of the request or the database.
      for (const text of [JSON.stringify(keyed.body), ...logs]) {
        for (const leaked of ["INSERT", secretName, "p_log", "projects", "tenant_id"]) assert.ok(!text.includes(leaked), `${leaked} in ${text.slice(0, 300)}`);
      }
      assert.deepEqual(Object.keys(keyed.body.error.detail.cause), ["code", "path", "detail"]);
    });
  }

  // The owner can also compile a request differently from the Worker while both report the same
  // snapshot (a policy rollout that did not change the version string, or a partial deploy). The
  // Worker compiles and forwards; the owner's compile fails. The answer is unknown, and the
  // stored row is replayed once the owner agrees again.
  test(`${ownerAdapter}: #85 path 1: an owner whose compile rejects a forwarded keyed retry answers unknown, not a rejection`, async (t) => {
    t.mock.method(console, "log", () => {});
    let denied = false;
    const h = await harness(t, {
      ownerAdapter, hooks: true,
      customizePolicy: (policy) => denied ? denyInsert(policy) : policy,
    });
    h.setValidator(async () => true);
    const key = "keyed-owner-compile-0001";
    const body = { statements: [insert("keyed_owner_compile")] };
    const first = await h.request("a", "/v1/transactions:execute", body, key);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(h.ownerNames().length, 1, "the owner placement");
    const owner = h.ownerNames()[0];
    const before = { events: h.events.length, checks: h.hooksSeen.length, connects: h.counts().connects, rows: idempotencyRows(h), commits: commits(h) };
    const inputs = h.ownerInputs(owner).length;

    denied = true;
    const skewed = h.skewOwners({ policyVersion: "policy_routing_1" });
    assert.equal(skewed.snapshot, h.runtime.snapshot, "the snapshot strings agree, so the owner reaches the compile");
    const retry = await h.request("a", "/v1/transactions:execute", body, key);
    unknown(retry, "owner compile", { code: "POLICYSQL_MISSING_POLICY", path: "/statements/0" });
    unchanged(h, before);
    assert.equal(h.ownerInputs(owner).length, inputs + 1, "the Worker forwarded the retry");
    assert.equal(h.ownerInputs(owner).at(-1).kind, "atomic");
    assert.equal(count(h, "keyed_owner_compile"), 1);

    denied = false;
    h.skewOwners(null);
    const replay = await h.request("a", "/v1/transactions:execute", body, key);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.transactionId, first.body.transactionId);
    assert.deepEqual(replay.body.results, first.body.results);
    assert.equal(commits(h), before.commits);
    assert.equal(count(h, "keyed_owner_compile"), 1);
  });
}
