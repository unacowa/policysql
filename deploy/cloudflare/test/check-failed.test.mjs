// #145 pull request B: a changed row that does not satisfy the policy's `check` is 403
// POLICYSQL_CHECK_FAILED at the failing statement, on every path: atomic (direct and owner
// placement) with and without an Idempotency-Key, and interactive. It is decided after the
// statements ran inside the open transaction and before COMMIT, the idempotency row, and any
// validator call, so nothing is committed and a key is not consumed. A database CHECK constraint
// is a different refusal (409 POLICYSQL_CONSTRAINT_VIOLATION, ADR 0030), and the one example of
// ADR 0030 (a check that does not fix the tenant) is pinned beside it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Kysely } from "kysely";
import { PolicySqlClient, PolicySqlError, PolicySqlOutcomeUnknownError, createHttpTransport } from "../../../packages/client/index.js";
import { PolicySqlDialect } from "../../../packages/kysely/index.js";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";

const example = (name) => readFileSync(new URL(`../../../examples/database-routing/${name}`, import.meta.url), "utf8");
// The example's `projects`, with a physical CHECK and a UNIQUE (tenant_id, name), and an insert
// policy whose check is the only thing that fixes the tenant (no preset), as in ADR 0030.
const INSERT_BLOCK = /^        insert:\n(?:^          .*\n)+/mu;
const policy = example("policy.yaml").replace(INSERT_BLOCK, `        insert:
          columns: [id, tenant_id, name]
          check: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id, name] }
`);
assert.notEqual(policy, example("policy.yaml"), "the insert policy was replaced");
const fixture = {
  catalog: example("catalog.yaml"),
  policy,
  schema: "CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL CHECK (length(name) < 20), UNIQUE (tenant_id, name));",
  physicalSchema: example("physical-schema.json"),
};
const insert = (id, tenant, name = id) => ({
  sql: "INSERT INTO projects (id, tenant_id, name) VALUES (:id, :tenant, :name)",
  params: { id, tenant, name },
});
const EXECUTE = "/v1/transactions:execute";
const commits = (h) => h.events.filter(({ sql }) => sql === "COMMIT").length;
const rollbacks = (h) => h.events.filter(({ sql }) => sql === "ROLLBACK").length;
const ids = (h) => h.rows("a").map((row) => row.id).sort();
const idempotencyRows = (h) => h.databases.get("a").database.prepare("SELECT count(*) AS n FROM policysql_idempotency").get().n;
const MESSAGE = "A changed row does not satisfy the policy check.";
const PLACEMENTS = [["direct", false], ["owner", true]];
// What the answers look like across adapters and placements (the differential).
const answers = new Map();
const withoutRequestId = ({ status, body }) => ({ status, body: { error: { ...body.error, requestId: undefined } } });

for (const ownerAdapter of OWNER_ADAPTERS) {
  for (const [placement, hooks] of PLACEMENTS) {
    for (const keyed of [false, true]) {
      test(`${ownerAdapter}/${placement}/${keyed ? "keyed" : "unkeyed"}: a failed policy check is a definite 403 at the failing statement and commits nothing`, async (t) => {
        const logs = [];
        t.mock.method(console, "log", (line) => { logs.push(String(line)); });
        const h = await harness(t, { ownerAdapter, hooks, fixture });
        h.setValidator(async () => true);
        const key = keyed ? `check-failed-${placement}-key-0001` : null;
        const before = { ids: ids(h), idempotency: idempotencyRows(h), commits: commits(h), hooks: h.hooksSeen.length };

        // The first statement is fine, the second writes another tenant's row: its check fails.
        const body = { statements: [insert("ok_1", "tenant_a"), insert("bad_1", "another_tenant")] };
        const refused = await h.request("a", EXECUTE, body, key);
        assert.equal(refused.status, 403, JSON.stringify(refused.body));
        assert.equal(refused.body.error.code, "POLICYSQL_CHECK_FAILED");
        assert.equal(refused.body.error.message, MESSAGE);
        assert.equal(refused.body.error.path, "/statements/1");
        assert.equal(refused.body.error.detail, undefined, "no detail");
        assert.deepEqual(Object.keys(refused.body.error), ["code", "message", "path", "requestId"]);
        assert.equal(refused.body.results, undefined);
        await h.flush();
        assert.deepEqual(ids(h), before.ids, "the earlier statement is rolled back too");
        assert.equal(commits(h), before.commits, "no COMMIT was sent");
        assert.ok(rollbacks(h) > 0, "the transaction was rolled back");
        assert.equal(idempotencyRows(h), before.idempotency, "no idempotency row");
        assert.equal(h.hooksSeen.length, before.hooks, "the validator was never called");
        assert.equal(h.ownerNames().length > 0, hooks, `the ${placement} placement ran`);

        // The first statement alone failing is /statements/0.
        const first = await h.request("a", EXECUTE, { statements: [insert("bad_2", "another_tenant")] }, key);
        assert.equal(first.status, 403, JSON.stringify(first.body));
        assert.equal(first.body.error.path, "/statements/0");
        assert.deepEqual(ids(h), before.ids);

        // Nothing leaks: not the predicate, a session key, the reserved prefix, a table name, or
        // the database's words, in the answer or in anything logged for the request.
        const everything = JSON.stringify(refused.body) + logs.join("\n");
        for (const secret of ["tenant_id", "__policysql", "projects", "check:", "SQLITE", "constraint", "another_tenant"]) {
          assert.ok(!everything.includes(secret), `${secret} must not appear: ${everything.slice(0, 400)}`);
        }

        // The key is not consumed: the same key with a body that passes is a new attempt.
        const fixed = await h.request("a", EXECUTE, { statements: [insert("ok_1", "tenant_a"), insert("ok_2", "tenant_a")] }, key);
        assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
        assert.deepEqual(ids(h), [...before.ids, "ok_1", "ok_2"].sort());
        assert.equal(commits(h), before.commits + 1);
        assert.equal(idempotencyRows(h), before.idempotency + (keyed ? 1 : 0));
        // The client's definite 403 is the same answer for the unkeyed request.
        answers.set(`${ownerAdapter}/${placement}/${keyed}`, withoutRequestId(refused));
      });
    }

    test(`${ownerAdapter}/${placement}: an interactive statement that fails its policy check closes the transaction as failed`, async (t) => {
      t.mock.method(console, "log", () => {});
      const h = await harness(t, { ownerAdapter, hooks, fixture });
      h.setValidator(async () => true);
      const before = { ids: ids(h), commits: commits(h) };
      const begun = await h.request("a", "/v1/transactions", { mode: "write" }, null);
      assert.equal(begun.status, 201, JSON.stringify(begun.body));
      const path = `/v1/transactions/${begun.body.transactionId}`;
      const ok = await h.request("a", `${path}/statements`, { sequence: 1, ...insert("ok_i", "tenant_a") }, null);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const refused = await h.request("a", `${path}/statements`, { sequence: 2, ...insert("bad_i", "another_tenant") }, null);
      assert.equal(refused.status, 403, JSON.stringify(refused.body));
      assert.equal(refused.body.error.code, "POLICYSQL_CHECK_FAILED");
      assert.equal(refused.body.error.path, "/statements/0", "an interactive statement is the envelope's first");
      assert.equal(refused.body.error.detail, undefined);
      const next = await h.request("a", `${path}/statements`, { sequence: 3, ...insert("ok_j", "tenant_a") }, null);
      assert.equal(next.status, 409, JSON.stringify(next.body));
      assert.equal(next.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
      const commit = await h.request("a", `${path}/commit`, { sequence: 3 }, null);
      assert.equal(commit.status, 409, JSON.stringify(commit.body));
      assert.equal(commit.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
      await h.flush();
      assert.deepEqual(ids(h), before.ids, "the first statement was rolled back");
      assert.equal(commits(h), before.commits);
    });
  }

  // The official client and Kysely: a rejection (PolicySqlError, status 403), never an unknown outcome.
  test(`${ownerAdapter}: the official client and Kysely read a failed policy check as a rejection and roll back`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { ownerAdapter, hooks: false, fixture });
    const fetchImpl = (url, init) => h.app.fetch(new Request(url, init), { database: h.binding("a"), session: h.session("a") }, h.background);
    const client = new PolicySqlClient({ transport: createHttpTransport({ endpoint: "https://worker.test", fetchImpl }) });
    const refusal = (error) => {
      assert.ok(error instanceof PolicySqlError, String(error));
      assert.equal(error instanceof PolicySqlOutcomeUnknownError, false);
      assert.equal(error.code, "POLICYSQL_CHECK_FAILED");
      assert.equal(error.status, 403);
      return true;
    };
    const sql = "INSERT INTO projects (id, tenant_id, name) VALUES (:id, :tenant, :name)";
    await assert.rejects(client.execute(sql, { id: "bad_c", tenant: "another_tenant", name: "n" }), refusal);
    const trx = await client.beginTransaction({ mode: "write" });
    await trx.execute(sql, { id: "ok_c", tenant: "tenant_a", name: "n" });
    await assert.rejects(trx.execute(sql, { id: "bad_c", tenant: "another_tenant", name: "n" }), refusal);
    await trx.dispose();

    const db = new Kysely({ dialect: new PolicySqlDialect({ client }) });
    t.after(() => db.destroy());
    await assert.rejects(db.transaction().execute(async (kysely) => {
      await kysely.insertInto("projects").values({ id: "ok_k", tenant_id: "tenant_a", name: "n" }).execute();
      await kysely.insertInto("projects").values({ id: "bad_k", tenant_id: "another_tenant", name: "n" }).execute();
    }), refusal);
    await h.flush();
    assert.deepEqual(ids(h), ["seed"], "every attempt rolled back");
  });

  // A database CHECK constraint and a policy check are different refusals, in the same fixture.
  test(`${ownerAdapter}: a physical CHECK constraint is 409 CONSTRAINT_VIOLATION and a failed policy check is 403 CHECK_FAILED`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { ownerAdapter, hooks: false, fixture });
    const physical = await h.request("a", EXECUTE, { statements: [insert("long_name", "tenant_a", "a name that is too long")] }, null);
    assert.equal(physical.status, 409, JSON.stringify(physical.body));
    assert.equal(physical.body.error.code, "POLICYSQL_CONSTRAINT_VIOLATION");
    assert.deepEqual(physical.body.error.detail, { constraint: "check" });
    const policyCheck = await h.request("a", EXECUTE, { statements: [insert("other", "another_tenant", "short")] }, null);
    assert.equal(policyCheck.status, 403, JSON.stringify(policyCheck.body));
    assert.equal(policyCheck.body.error.code, "POLICYSQL_CHECK_FAILED");
    assert.equal(policyCheck.body.error.detail, undefined);
  });

  // ADR 0030's example: the check does not fix the tenant. Whether the other tenant has the
  // `name` shows as 409 `unique` or 403 `CHECK_FAILED`; this is the residual risk 2 of the security
  // model and is pinned so that a change of either answer is a decision.
  test(`${ownerAdapter}: ADR 0030's example: another tenant's UNIQUE key is 409 unique, an absent one is 403 CHECK_FAILED`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { ownerAdapter, hooks: false, fixture });
    h.databases.get("b").database.prepare("INSERT INTO projects VALUES (?, ?, ?)").run("b_row", "another_tenant", "taken");
    h.databases.get("a").database.prepare("INSERT INTO projects VALUES (?, ?, ?)").run("a_row", "another_tenant", "taken");
    const taken = await h.request("a", EXECUTE, { statements: [insert("probe_1", "another_tenant", "taken")] }, null);
    assert.equal(taken.status, 409, JSON.stringify(taken.body));
    assert.equal(taken.body.error.code, "POLICYSQL_CONSTRAINT_VIOLATION");
    assert.deepEqual(taken.body.error.detail, { constraint: "unique" });
    const free = await h.request("a", EXECUTE, { statements: [insert("probe_2", "another_tenant", "free")] }, null);
    assert.equal(free.status, 403, JSON.stringify(free.body));
    assert.equal(free.body.error.code, "POLICYSQL_CHECK_FAILED");
  });
}

// The answer, apart from its request ID, is the same on both owner adapters, in both
// placements, with and without a key.
test("a failed policy check is answered alike on every adapter, placement, and key", () => {
  assert.equal(answers.size, OWNER_ADAPTERS.length * PLACEMENTS.length * 2);
  const [first, ...rest] = [...answers.values()];
  for (const other of rest) assert.deepEqual(other, first);
  assert.equal(first.status, 403);
});
