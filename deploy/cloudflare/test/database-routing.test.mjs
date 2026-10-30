import { harness } from "./helpers/routing.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app.ts";
import { TransactionOwnerCore } from "../src/transaction-owner.ts";
import { createMemoryTransactionOwners } from "./helpers/memory-owner.mjs";
import { validateDatabaseBinding, databaseTransportFactory } from "../src/database.ts";
import { authIdentity, requestIdentity } from "../src/core-identity.ts";
import { identityRuntime } from "./helpers/identity.mjs";

const schemaVersion = "schema_routing_1";
const policyVersion = "policy_routing_1";
const read = { sql: "SELECT id, name FROM projects ORDER BY id", params: {} };
const insert = (id, name = id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name } });
const envelope = (...statements) => ({ statements });

test("parallel session/Wasm/HTTP reads and cost observations stay on their selected SQLite databases", async (t) => {
  const h = await harness(t);
  const results = await Promise.all(["a", "b"].map((tenant) => h.request(tenant, "/v1/transactions:execute", envelope(read))));
  for (const [index, tenant] of ["a", "b"].entries()) {
    assert.equal(results[index].status, 200, JSON.stringify(results[index].body));
    assert.deepEqual(results[index].body.results[0].rows, [{ id: "seed", name: `database_${tenant}` }]);
  }
  await h.flush();
  for (const tenant of ["a", "b"]) assert.ok(h.events.some((event) => event.tenant === tenant && event.sql.startsWith("EXPLAIN QUERY PLAN")));
  assert.equal(h.env.TURSO_DATABASE_URL, undefined, "injected transports do not require the fixed DB env");
  assert.ok(h.counts().checks >= 2);
});

test("wrapper-rejected JWTs and missing endpoint access never connect or check a database", async (t) => {
  const h = await harness(t);
  // The example wrapper rejects an unverifiable credential with 401 before the library runs.
  assert.equal((await h.request("a", "/v1/transactions:execute", envelope(read), undefined, "invalid")).status, 401);
  for (const jwt of [{ issuer: "https://other-issuer.test" }, { audience: "another-app" }, { expires: "-1h" }]) {
    const rejected = await h.request("a", "/v1/transactions:execute", envelope(read), undefined, await h.token("a", {}, jwt));
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.error.code, "POLICYSQL_UNAUTHENTICATED");
  }
  assert.equal(h.counts().checks, 0);
  // A verified session without the endpoint's access is a client-caused 403 from core,
  // whether it arrives directly or through the wrapper's JWT adapter.
  for (const credential of [
    h.session("a", { access: ["catalog"] }),
    await h.token("a", { policysql: { roles: ["member"], default_role: "member", access: ["catalog"], session: { tenant_id: "tenant_a" } } }),
  ]) {
    const denied = await h.request("a", "/v1/transactions:execute", envelope(read), undefined, credential);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "POLICYSQL_FORBIDDEN_ACCESS");
  }
  assert.equal(h.counts().checks, 0);
  assert.equal(h.counts().connects, 0);
  assert.equal(h.events.length, 0);
});

test("Catalog and Explain validate the binding without opening a DB connection", async (t) => {
  const h = await harness(t);
  assert.equal((await h.request("a", "/v1/catalog")).status, 200);
  assert.equal((await h.request("a", "/v1/transactions:explain", envelope(read))).status, 200);
  h.env.TENANT_A_ENABLED = "false";
  assert.equal((await h.request("a", "/v1/catalog")).status, 403);
  assert.equal(h.counts().connects, 0);
});

test("a missing request database is detected even when legacy Turso env credentials exist", async (t) => {
  const h = await harness(t);
  const env = { ...h.env, TURSO_DATABASE_URL: "https://a.test", TURSO_AUTH_TOKEN: "token_a" };
  for (const context of [undefined, null, { session: h.session("a") }, { database: null, session: h.session("a") }, h.binding("a")]) {
    const response = await h.workerApp().fetch(new Request("https://worker.test/v1/transactions:execute", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope(read)),
    }), env, h.ctx, context);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, "POLICYSQL_DATABASE_REQUIRED");
  }
  assert.equal(h.counts().checks, 0);
  assert.equal(h.counts().connects, 0);
});

test("DB injection is independent of JWT database claims, including absent or conflicting claims", async (t) => {
  const h = await harness(t);
  for (const claims of [{}, { database: { id: "db_b", generation: "old", url: "https://evil.test" } }, { database: "malformed" }]) {
    const result = await h.request("a", "/v1/transactions:execute", envelope(read), undefined, await h.token("a", claims));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.results[0].rows, [{ id: "seed", name: "database_a" }]);
  }
  await h.flush();
  assert.ok(h.events.every((event) => event.tenant === "a"));
});

test("the callback entrypoint cannot be used to bypass required DB injection", async (t) => {
  const h = await harness(t);
  for (const path of ["/v1/transactions:execute", "/v1/catalog", "/healthz"]) {
    const response = await h.app.fetchCallback(new Request(`https://worker.test${path}`, { method: "POST" }));
    assert.equal(response.status, 404);
  }
  assert.equal(h.counts().connects, 0);
});

test("missing DB binding in an internal owner command fails before a connection is opened", async (t) => {
  const h = await harness(t);
  const owner = h.transactionOwners.route(`tx_${"a".repeat(32)}`);
  // The step machine reads the owner input exactly (ADR 0024): a begin without its binding is
  // malformed, and a binding that is not one is rejected, before any database work.
  for (const [databaseBinding, code] of [[undefined, "POLICYSQL_INVALID_REQUEST"], [null, "POLICYSQL_DATABASE_BINDING_REJECTED"]]) {
    const reply = await owner.begin({
      transactionId: `tx_${"a".repeat(32)}`, startFingerprint: "c".repeat(64),
      mode: "read", auth: {}, snapshot: h.runtime.snapshot, ...(databaseBinding === undefined ? {} : { databaseBinding }),
    }, "req");
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, code);
  }
  assert.equal(h.counts().connects, 0);
  assert.equal(h.counts().checks, 0);
});

test("client headers, body fields, and SQL cannot replace the wrapper-selected database", async (t) => {
  const h = await harness(t);
  const result = await h.request("a", "/v1/transactions:execute", envelope(read), undefined, undefined, {
    "x-database-id": "db_b", "turso-database-url": "https://b.test", "policysql-database": "db_b",
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.results[0].rows, [{ id: "seed", name: "database_a" }]);
  await h.flush();
  const before = h.counts().connects;
  const injected = await h.request("a", "/v1/transactions:execute", { ...envelope(read), databaseBinding: { databaseId: "db_b" } });
  assert.equal(injected.status, 400);
  const attach = await h.request("a", "/v1/transactions:execute", envelope({ sql: "ATTACH DATABASE :url AS other", params: { url: "https://b.test" } }));
  assert.ok(attach.status >= 400);
  assert.equal(h.counts().connects, before);
  assert.ok(h.events.every((event) => event.tenant === "a"));
});

test("ordinary atomic writes isolate identical keys, replay once, and roll back all items on a late failure", async (t) => {
  const h = await harness(t, { hooks: false });
  const body = envelope(insert("new"));
  const results = await Promise.all(["a", "b"].map((tenant) => h.request(tenant, "/v1/transactions:execute", body)));
  assert.deepEqual(results.map((result) => result.status), [200, 200]);
  assert.notEqual(results[0].body.transactionId, results[1].body.transactionId);
  await h.flush();
  const replay = await h.request("a", "/v1/transactions:execute", body);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.transactionId, results[0].body.transactionId);
  assert.equal((await h.request("a", "/v1/transactions:execute", envelope(insert("different")))).status, 409);
  assert.equal((await h.request("a", "/v1/transactions:execute", envelope(insert("rollback"), insert("seed")), "late-failure-key-001")).status, 503);
  assert.equal(h.rows("a").some((row) => row.id === "rollback"), false);
  assert.equal(h.rows("b").some((row) => row.id === "rollback"), false);
  for (const tenant of ["a", "b"]) assert.equal(h.databases.get(tenant).database.prepare("SELECT count(*) AS n FROM policysql_idempotency").get().n, 1);
});

for (const hooks of [false, true]) {
  for (const idempotencyTable of [false, true]) {
    test(`unkeyed writes never access idempotency storage and run independently (DO=${hooks}, table=${idempotencyTable})`, async (t) => {
      const h = await harness(t, { hooks, idempotencyTable });
      if (idempotencyTable) h.databases.get("a").database.exec("INSERT INTO policysql_idempotency VALUES ('untouched', 'fingerprint', '{}')");
      const update = envelope({ sql: "UPDATE projects SET name = :name WHERE id = :id RETURNING id, name", params: { id: "seed", name: "changed" } });
      const first = await h.request("a", "/v1/transactions:execute", update, null);
      const second = await h.request("a", "/v1/transactions:execute", update, null);
      assert.equal(first.status, 200, JSON.stringify(first));
      assert.equal(second.status, 200, JSON.stringify(second));
      assert.notEqual(first.body.transactionId, second.body.transactionId);
      assert.deepEqual(second.body.results[0].rows, [{ id: "seed", name: "changed" }]);
      // Separate databases allow real concurrent writers in the SQLite test server.
      const parallel = await Promise.all(["a", "b"].map((tenant) => h.request(tenant, "/v1/transactions:execute", envelope(insert("unkeyed")), null)));
      assert.deepEqual(parallel.map((result) => result.status), [200, 200]);
      await h.flush();
      assert.equal(h.events.filter(({ sql }) => sql.startsWith("UPDATE")).length, 2);
      assert.equal(h.events.some(({ sql }) => /policysql_idempotency/i.test(sql)), false);
      if (hooks) {
        assert.equal(h.ownerNames().length, 4);
        assert.equal(h.hooksSeen.length, 4);
        assert.equal(new Set(h.hooksSeen.map(({ hook }) => hook.query.url)).size, 4);
        for (const { result, status } of h.hooksSeen) assert.equal(status, 200, JSON.stringify(result));
        assert.ok(h.hooksSeen.slice(2).every(({ result }) => result.rows.some((row) => row.id === "unkeyed")));
      }
      if (idempotencyTable) assert.deepEqual(
        h.databases.get("a").database.prepare("SELECT * FROM policysql_idempotency").all().map((row) => ({ ...row })),
        [{ key_hash: "untouched", fingerprint: "fingerprint", response_json: "{}" }],
      );
    });
  }

  test(`keyed writes still fail before mutation when the table is missing (DO=${hooks})`, async (t) => {
    const h = await harness(t, { hooks, idempotencyTable: false });
    const result = await h.request("a", "/v1/transactions:execute", envelope(insert("must_not_run")));
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, "POLICYSQL_DATABASE_UNAVAILABLE");
    assert.equal(h.events.some(({ sql }) => sql.startsWith("INSERT INTO projects")), false);
    assert.ok(h.events.some(({ sql }) => sql === "ROLLBACK"));
    assert.equal(h.hooksSeen.length, 0);
  });

  test(`unkeyed requests roll back on late SQL errors (DO=${hooks})`, async (t) => {
    const h = await harness(t, { hooks, idempotencyTable: false });
    const result = await h.request("a", "/v1/transactions:execute", envelope(insert("rollback"), insert("seed")), null);
    assert.equal(result.status, 503);
    assert.equal(h.rows("a").some((row) => row.id === "rollback"), false);
    assert.equal(h.events.some(({ sql }) => /policysql_idempotency/i.test(sql)), false);
    assert.ok(h.events.some(({ sql }) => sql === "ROLLBACK"));
  });
}

// ADR 0021: the validator endpoint comes from the wrapper's config, keyed by check id. A
// policy check with no configured endpoint fails closed for atomic and interactive commits.
test("a commit check without a configured endpoint rejects the commit, rolls back, and calls no validator", async (t) => {
  const h = await harness(t, { customizeConfig: (config) => ({ ...config, commitChecks: { another_check: config.commitChecks.consistency } }) });
  let calls = 0;
  h.setValidator(async () => { calls++; return true; });
  const atomic = await h.request("a", "/v1/transactions:execute", envelope(insert("unconfigured_atomic")), null);
  assert.equal(atomic.status, 409);
  assert.equal(atomic.body.error.code, "POLICYSQL_COMMIT_CHECK_REJECTED");
  const start = await h.request("a", "/v1/transactions", { mode: "write" }, null);
  const path = `/v1/transactions/${start.body.transactionId}`;
  assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert("unconfigured_tx") }, null)).status, 200);
  const commit = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
  assert.equal(commit.status, 409);
  assert.equal(commit.body.error.code, "POLICYSQL_COMMIT_CHECK_REJECTED");
  assert.equal(calls, 0);
  assert.equal(h.hooksSeen.length, 0);
  assert.equal(h.rows("a").some((row) => row.id.startsWith("unconfigured")), false);
});

test("unkeyed commit-check rejection rolls back the update", async (t) => {
  const h = await harness(t, { idempotencyTable: false });
  h.setValidator(async () => false);
  const result = await h.request("a", "/v1/transactions:execute", envelope(insert("denied")), null);
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "POLICYSQL_COMMIT_CHECK_REJECTED");
  assert.equal(h.rows("a").some((row) => row.id === "denied"), false);
  assert.ok(h.events.some(({ sql }) => sql === "ROLLBACK"));
  assert.equal(h.events.some(({ sql }) => /policysql_idempotency/i.test(sql)), false);
});

test("interactive starts without keys are distinct and retain command retries without a table", async (t) => {
  const h = await harness(t, { idempotencyTable: false });
  // Two simultaneous read transactions on the same database must have separate owners.
  const starts = await Promise.all([1, 2].map(() => h.request("a", "/v1/transactions", { mode: "read" }, null)));
  assert.deepEqual(starts.map((result) => result.status), [201, 201], JSON.stringify(starts));
  assert.notEqual(starts[0].body.transactionId, starts[1].body.transactionId);
  for (const start of starts) {
    const path = `/v1/transactions/${start.body.transactionId}`;
    const command = { sequence: 1, ...read };
    const first = await h.request("a", `${path}/statements`, command, null);
    assert.equal(first.status, 200);
    assert.deepEqual((await h.request("a", `${path}/statements`, command, null)).body, first.body);
    assert.equal((await h.request("a", `${path}/rollback`, { sequence: 2 }, null)).status, 200);
  }
  const write = await h.request("a", "/v1/transactions", { mode: "write" }, null);
  assert.equal(write.status, 201);
  const path = `/v1/transactions/${write.body.transactionId}`;
  assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert("interactive_unkeyed") }, null)).status, 200);
  const committed = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
  assert.equal(committed.status, 200);
  assert.deepEqual((await h.request("a", `${path}/commit`, { sequence: 2 }, null)).body, committed.body);
  await h.flush();
  assert.equal(h.hooksSeen.length, 1);
  assert.ok(h.rows("a").some((row) => row.id === "interactive_unkeyed"));
  assert.equal(h.events.some(({ sql }) => /policysql_idempotency/i.test(sql)), false);
});

test("explicit invalid keys remain errors before database execution", async (t) => {
  const h = await harness(t);
  for (const key of ["", "short", "a".repeat(129), "request-key-0001,request-key-0002", "invalid key with spaces"]) {
    for (const [path, body] of [["/v1/transactions:execute", envelope(insert("invalid"))], ["/v1/transactions", { mode: "read" }]]) {
      const result = await h.request("a", path, body, key);
      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, "POLICYSQL_IDEMPOTENCY_KEY_REQUIRED");
    }
  }
  assert.equal(h.events.length, 0);
  assert.equal(h.ownerNames().length, 0);
});

test("DO atomic callbacks see uncommitted rows on the initiating database and replay without another hook", async (t) => {
  const h = await harness(t);
  const results = await Promise.all(["a", "b"].map((tenant) => h.request(tenant, "/v1/transactions:execute", envelope(insert("pending")))));
  assert.deepEqual(results.map((result) => result.status), [200, 200], JSON.stringify(results));
  assert.equal(h.hooksSeen.length, 2);
  for (const { hook, result, status } of h.hooksSeen) {
    assert.equal(status, 200);
    const tenant = hook.session.tenant_id.slice(-1);
    assert.deepEqual(result.rows, [{ id: "pending", name: "pending" }, { id: "seed", name: `database_${tenant}` }]);
    assert.equal(JSON.stringify(hook).includes("token_a"), false);
  }
  await h.flush();
  assert.equal((await h.request("a", "/v1/transactions:execute", envelope(insert("pending")))).status, 200);
  assert.equal(h.hooksSeen.length, 2);
  for (const name of h.ownerNames()) assert.equal(JSON.stringify(await h.ownerRecord(name)).includes("token_"), false);
});

test("interactive transactions pin DB and snapshot, reject cross-tenant commands, and preserve commit/rollback replay", async (t) => {
  const h = await harness(t);
  const starts = await Promise.all(["a", "b"].map((tenant) => h.request(tenant, "/v1/transactions", { mode: "write", expected: { schemaVersion, policyVersion } })));
  assert.deepEqual(starts.map((result) => result.status), [201, 201], JSON.stringify(starts));
  const [a, b] = starts.map((result) => result.body.transactionId);
  assert.notEqual(a, b);
  const command = { sequence: 1, ...insert("interactive") };
  assert.equal((await h.request("a", `/v1/transactions/${a}/statements`, command)).status, 200);
  assert.equal((await h.request("b", `/v1/transactions/${a}/statements`, command)).status, 409);
  assert.equal((await h.request("a", `/v1/transactions/${a}/statements`, command)).status, 200);
  assert.equal((await h.request("b", `/v1/transactions/${b}/statements`, command)).status, 200);
  const committed = await h.request("a", `/v1/transactions/${a}/commit`, { sequence: 2 });
  assert.equal(committed.body.status, "committed", JSON.stringify(committed));
  assert.deepEqual((await h.request("a", `/v1/transactions/${a}/commit`, { sequence: 2 })).body, committed.body);
  assert.equal((await h.request("b", `/v1/transactions/${b}/rollback`, { sequence: 2 })).body.status, "rolled_back");
  assert.equal(h.rows("a").some((row) => row.id === "interactive"), true);
  assert.equal(h.rows("b").some((row) => row.id === "interactive"), false);
  assert.equal(h.hooksSeen.length, 1);
});

test("owner replacement never reconnects or resumes an interactive transaction", async (t) => {
  const h = await harness(t);
  const start = await h.request("a", "/v1/transactions", { mode: "read" });
  assert.equal(start.status, 201);
  h.loseOwner(start.body.transactionId);
  const connects = h.counts().connects;
  const response = await h.request("a", `/v1/transactions/${start.body.transactionId}/statements`, { sequence: 1, ...read });
  assert.equal(response.status, 409);
  assert.equal(h.counts().connects, connects);
});

test("revocation during validation rejects the callback and rolls back the original DB", async (t) => {
  const h = await harness(t);
  h.setValidator(async (hook) => {
    h.env.TENANT_A_ENABLED = "false";
    const response = await h.request("a", new URL(hook.query.url).pathname, { sequence: 1, ...read }, undefined, hook.query.token);
    assert.equal(response.status, 403);
    return true;
  });
  const result = await h.request("a", "/v1/transactions:execute", envelope(insert("revoked")));
  assert.ok(result.status >= 400);
  assert.equal(h.rows("a").some((row) => row.id === "revoked"), false);
  assert.equal(h.events.some((event) => event.tenant === "b"), false);
});

test("wrapper failures are bounded safe errors without fallback or credential leakage", async (t) => {
  const h = await harness(t, { customizeProvider: (provider) => ({ ...provider, connect() { throw new Error("secret-token-private-url"); } }) });
  const result = await h.request("a", "/v1/transactions:execute", envelope(read));
  assert.equal(result.status, 503);
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
  assert.equal(h.events.length, 0);
});

test("DO cost observations use the selected database after updates", async (t) => {
  const h = await harness(t);
  const update = { sql: "UPDATE projects SET name = :name WHERE id = :id RETURNING id, name", params: { id: "seed", name: "updated" } };
  for (const tenant of ["a", "b"]) {
    assert.equal((await h.request(tenant, "/v1/transactions:execute", envelope(update))).status, 200);
  }
  await h.flush();
  for (const tenant of ["a", "b"]) {
    assert.ok(h.events.some((event) => event.tenant === tenant && event.sql.startsWith("EXPLAIN QUERY PLAN")));
    assert.deepEqual(h.rows(tenant), [{ id: "seed", name: "updated" }]);
  }
});

test("callback capability from another database cannot read the active transaction", async (t) => {
  const h = await harness(t);
  let firstToken;
  h.setValidator(async (hook) => { firstToken = hook.query.token; return true; });
  assert.equal((await h.request("a", "/v1/transactions:execute", envelope(insert("a_only")))).status, 200);
  h.setValidator(async (hook) => {
    const before = h.events.length;
    const wrong = await h.request("b", new URL(hook.query.url).pathname, { sequence: 1, ...read }, undefined, firstToken);
    assert.equal(wrong.status, 409);
    assert.equal(h.events.slice(before).some((event) => event.sql.startsWith("SELECT") && event.sql.includes("projects")), false);
    return true;
  });
  assert.equal((await h.request("b", "/v1/transactions:execute", envelope(insert("b_only")))).status, 409);
  assert.equal(h.rows("b").some((row) => row.id === "b_only"), false);
});

// #73: a callback reaches an owner by its validation id alone (the transaction id with `tx_`
// replaced by `cval_`). Without a live capability it is unavailable and changes nothing; only
// a failure while a capability is live ends the transaction (ADR 0007, docs/commit-checks.md).
const callbackPath = (transactionId) => `/v1/commit-checks/cval_${transactionId.slice("tx_".length)}/query`;
const strayToken = "A".repeat(43);

test("a callback with no validation running leaves the open transaction usable (#73)", async (t) => {
  const h = await harness(t);
  const start = await h.request("a", "/v1/transactions", { mode: "write" });
  assert.equal(start.status, 201, JSON.stringify(start));
  const id = start.body.transactionId;
  assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("kept") })).status, 200);
  const events = h.events.length;
  for (const token of [strayToken, "malformed", ""]) {
    const stray = await h.request("a", callbackPath(id), { sequence: 1, ...read }, undefined, token);
    assert.equal(stray.status, 409, JSON.stringify(stray));
    assert.equal(stray.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  }
  assert.equal(h.events.length, events, "no SQL and no rollback reached the database");
  assert.equal((await h.ownerRecord(id)).status, "active");
  assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 2, ...insert("later") })).status, 200);
  const committed = await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 3 });
  assert.equal(committed.status, 200, JSON.stringify(committed));
  assert.equal(committed.body.status, "committed");
  assert.equal(committed.body.meta.commitChecks, "passed");
  assert.deepEqual(h.rows("a").filter((row) => ["kept", "later"].includes(row.id)).map((row) => row.id), ["kept", "later"]);
});

test("a revoked capability changes nothing: the committed record and its replay stay (#73)", async (t) => {
  const h = await harness(t);
  let token;
  const validator = async (hook) => {
    token = hook.query.token;
    const query = await h.request("a", new URL(hook.query.url).pathname, { sequence: 1, ...read }, undefined, token);
    return query.status === 200;
  };
  h.setValidator(validator);
  const start = await h.request("a", "/v1/transactions", { mode: "write" });
  const id = start.body.transactionId;
  assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("revoked_cap") })).status, 200);
  const committed = await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 });
  assert.equal(committed.body.status, "committed", JSON.stringify(committed));
  // The verdict revoked the capability; its token, replayed or advanced, is unavailable.
  for (const sequence of [1, 2]) {
    const late = await h.request("a", callbackPath(id), { sequence, ...read }, undefined, token);
    assert.equal(late.status, 409, JSON.stringify(late));
    assert.equal(late.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  }
  assert.equal((await h.ownerRecord(id)).status, "committed");
  assert.deepEqual((await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 })).body, committed.body);
  assert.equal(h.rows("a").some((row) => row.id === "revoked_cap"), true);
});

test("a capability revoked by expiry changes nothing: the expired record stays (#73)", async (t) => {
  const h = await harness(t);
  // Expiry with no validation running.
  const idle = (await h.request("b", "/v1/transactions", { mode: "write" })).body.transactionId;
  assert.equal(await h.fireTimer(idle), true);
  const stray = await h.request("b", callbackPath(idle), { sequence: 1, ...read }, undefined, strayToken);
  assert.equal(stray.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  assert.equal((await h.ownerRecord(idle)).status, "expired");

  // Expiry while the validator is awaited: the capability it holds is revoked.
  const id = (await h.request("a", "/v1/transactions", { mode: "write" })).body.transactionId;
  assert.notEqual(id, idle);
  assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("expired_cap") })).status, 200);
  let seen;
  let validated;
  const done = new Promise((resolve) => { validated = resolve; });
  h.setValidator(async (hook) => {
    assert.equal(await h.fireTimer(id), true);
    const late = await h.request("a", new URL(hook.query.url).pathname, { sequence: 1, ...read }, undefined, hook.query.token);
    seen = { late, status: (await h.ownerRecord(id)).status };
    validated();
    return true;
  });
  // The expiry answers the waiting commit at once (ADR 0024 inconsistency 5); the validator
  // finishes after it.
  const commit = await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 });
  await done;
  assert.equal(seen.late.status, 409, JSON.stringify(seen.late));
  assert.equal(seen.late.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  assert.equal(seen.status, "expired", "the late callback did not overwrite the expiry");
  assert.ok(commit.status >= 400, JSON.stringify(commit));
  assert.equal(h.rows("a").some((row) => row.id === "expired_cap"), false);
});

test("a wrong or malformed token while a capability is live still fails the validation and rolls back (#73)", async (t) => {
  for (const token of [strayToken, "malformed"]) {
    const h = await harness(t);
    const id = (await h.request("a", "/v1/transactions", { mode: "write" })).body.transactionId;
    assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("wrong_token") })).status, 200);
    let wrong;
    h.setValidator(async (hook) => {
      wrong = await h.request("a", new URL(hook.query.url).pathname, { sequence: 1, ...read }, undefined, token);
      // The real token no longer works: the failure revoked the capability.
      const real = await h.request("a", new URL(hook.query.url).pathname, { sequence: 1, ...read }, undefined, hook.query.token);
      assert.equal(real.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
      return true;
    });
    const commit = await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 });
    assert.equal(wrong.status, 409, JSON.stringify(wrong));
    assert.equal(wrong.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
    assert.equal(commit.status, 409, JSON.stringify(commit));
    assert.equal(commit.body.error.code, "POLICYSQL_COMMIT_CHECK_REJECTED");
    assert.equal((await h.ownerRecord(id)).status, "failed");
    assert.equal(h.rows("a").some((row) => row.id === "wrong_token"), false);
  }
});

test("a store read fault during a live validation cannot touch its capability: the machine reads nothing (#73 review)", async (t) => {
  const h = await harness(t);
  const id = (await h.request("a", "/v1/transactions", { mode: "write" })).body.transactionId;
  assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("store_fault") })).status, 200);
  let armed = false;
  let answered;
  // Every owner store read throws while the validator runs. The step machine keeps its record
  // in memory (ADR 0007 "Callback rules of the step machine"), so a callback reads nothing and
  // a store fault can neither fail nor extend the live capability.
  h.interceptOwnerGet(() => (armed ? { fail: true } : undefined));
  h.setValidator(async (hook) => {
    armed = true;
    answered = await h.request("a", new URL(hook.query.url).pathname, { sequence: 1, ...read }, undefined, hook.query.token);
    armed = false;
    return true;
  });
  const commit = await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 });
  h.interceptOwnerGet(null);
  assert.equal(answered.status, 200, JSON.stringify(answered));
  assert.equal(commit.status, 200, JSON.stringify(commit));
  assert.equal(commit.body.meta.commitChecks, "passed");
  assert.equal((await h.ownerRecord(id)).status, "committed");
  assert.equal(h.rows("a").some((row) => row.id === "store_fault"), true);
});

test("a changed runtime snapshot fails before another statement and rolls back", async (t) => {
  const h = await harness(t);
  const start = await h.request("a", "/v1/transactions", { mode: "write" });
  const id = start.body.transactionId;
  assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("stale") })).status, 200);
  // A later runtime on the owner: another snapshot (another policy version).
  const later = h.makeRuntime({ policyVersion: "policy_routing_2" });
  assert.notEqual(later.snapshot, h.runtime.snapshot);
  h.ownerCore(id).getRuntime = () => later;
  const commit = await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 });
  assert.equal(commit.status, 409, JSON.stringify(commit.body));
  assert.equal(commit.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  assert.ok(h.events.some(({ sql }) => sql === "ROLLBACK"));
  assert.equal(h.events.some(({ sql }) => sql === "COMMIT"), false);
  assert.equal(h.rows("a").some((row) => row.id === "stale"), false);
});

test("Worker/DO provider configuration mismatch fails before connecting", async (t) => {
  const h = await harness(t);
  const start = await h.request("a", "/v1/transactions", { mode: "read" });
  // The begin input the engine forwarded (ADR 0024: the session and the binding).
  const message = h.ownerInputs(start.body.transactionId)[0].input;
  // An owner whose deployment registers no such database checks the binding first.
  const ownerWithoutProvider = createMemoryTransactionOwners(() => ({ getRuntime: () => h.runtime, config: h.config, database: {
    check: () => false,
    connect: () => { assert.fail("No default database is available"); },
  } })).port.route(start.body.transactionId);
  const reply = await ownerWithoutProvider.begin({
    transactionId: message.transactionId, startFingerprint: message.startFingerprint,
    mode: "read", auth: message.auth, databaseBinding: message.databaseBinding, snapshot: message.snapshot,
  }, "req");
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, "POLICYSQL_DATABASE_BINDING_REJECTED");
});

for (const hooks of [false, true]) {
  test(`generation changes conflict on retry without duplicating writes (DO=${hooks})`, async (t) => {
    let generation = "1";
    const h = await harness(t, { hooks, customizeBinding: (binding) => ({ ...binding, generation }), customizeProvider: (provider) => ({
      check: (binding) => provider.check({ ...binding, generation: "1" }),
      connect: (binding, ...args) => provider.connect({ ...binding, generation: "1" }, ...args),
    }) });
    const body = envelope(insert("one_write"));
    assert.equal((await h.request("a", "/v1/transactions:execute", body)).status, 200);
    generation = "2";
    assert.equal((await h.request("a", "/v1/transactions:execute", body)).status, 409);
    assert.equal(h.rows("a").filter((row) => row.id === "one_write").length, 1);
  });
}

test("a stalled provider times out without selecting a default database", async (t) => {
  const h = await harness(t, { customizeProvider: (provider) => ({ ...provider, check: () => new Promise(() => {}) }) });
  const result = await h.request("a", "/v1/transactions:execute", envelope(read));
  assert.equal(result.status, 503);
  assert.equal(h.counts().connects, 0);
});

test("credential rotation changes new connections while an interactive transaction keeps its connection", async (t) => {
  const h = await harness(t);
  const start = await h.request("a", "/v1/transactions", { mode: "write" });
  const id = start.body.transactionId;
  h.rotateCredential("a", "token_a_rotated");
  assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("rotated") })).status, 200);
  const write = h.events.find((event) => event.sql.startsWith('INSERT INTO "projects"'));
  assert.equal(write.credential, "Bearer token_a");
  assert.equal((await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 })).body.status, "committed");
  const afterCommit = h.events.length;
  assert.equal((await h.request("a", "/v1/transactions:execute", envelope(read))).status, 200);
  await h.flush();
  assert.ok(h.events.slice(afterCommit).every((event) => event.credential === "Bearer token_a_rotated"));
});

test("revoking an active connection credential fails without reconnecting", async (t) => {
  const h = await harness(t);
  const start = await h.request("a", "/v1/transactions", { mode: "write" });
  const id = start.body.transactionId;
  assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("uncommitted") })).status, 200);
  await h.flush();
  h.rotateCredential("a", "token_a_rotated");
  h.revokeCredential("a", "token_a");
  const connects = h.counts().connects;
  assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 2, ...read })).status, 503);
  assert.equal(h.counts().connects, connects);
  assert.equal(h.rows("a").some((row) => row.id === "uncommitted"), false);
  assert.equal((await h.ownerRecord(id)).status, "failed");
});

test("DO atomic SQL failure rolls back every preceding item on the selected database", async (t) => {
  const h = await harness(t);
  const response = await h.request("b", "/v1/transactions:execute", envelope(insert("rolled_back"), insert("seed")));
  assert.equal(response.status, 503);
  assert.equal(h.rows("b").some((row) => row.id === "rolled_back"), false);
  assert.equal(h.hooksSeen.length, 0);
});

for (const scenario of JSON.parse(readFileSync(new URL("./fixtures/database-deadlines.json", import.meta.url), "utf8"))) {
  test(`atomic deadline: ${scenario.name}`, async (t) => {
    let now = Date.now();
    let connected = false;
    t.mock.method(Date, "now", () => now);
    const h = await harness(t, { hooks: false, customizeProvider: (provider) => ({
      check(...args) {
        if (connected) now += scenario.commitCheckMs;
        return provider.check(...args);
      },
      connect(...args) {
        now += scenario.connectMs;
        connected = true;
        return provider.connect(...args);
      },
    }) });
    const response = await h.request("a", "/v1/transactions:execute", envelope(insert("deadline")));
    assert.equal(response.status, scenario.status, JSON.stringify(response));
    const succeeds = scenario.status === 200;
    assert.equal(h.events.some(({ sql }) => sql.startsWith("BEGIN")), scenario.begins);
    assert.equal(h.events.some(({ sql }) => sql === "COMMIT"), succeeds);
    assert.equal(h.events.some(({ sql }) => sql === "ROLLBACK"), !succeeds && scenario.begins);
    assert.equal(h.rows("a").some(({ id }) => id === "deadline"), succeeds);
    assert.equal(h.databases.get("a").database.prepare("SELECT count(*) AS n FROM policysql_idempotency").get().n, succeeds ? 1 : 0);
    if (!succeeds) assert.equal(response.body.error.code, "POLICYSQL_DATABASE_TIMEOUT");
  });
}

test("a slow commit authorization cannot extend the transaction deadline", async () => {
  const binding = { version: 1, scope: "test:a", databaseId: "a", generation: "1", snapshot: "snapshot" };
  let committed = false;
  let rolledBack = false;
  let slow = false;
  const provider = {
    check: async () => { if (slow) await new Promise((resolve) => setTimeout(resolve, 150)); return true; },
    connect: () => ({ begin: async () => ({ open: true, usage: [], execute: async () => [],
      commit: async () => { committed = true; }, rollback: async () => { rolledBack = true; },
    }) }),
  };
  const transport = await databaseTransportFactory(provider, binding, 1_024)("request");
  const transaction = await transport.begin("write", 100);
  slow = true;
  await assert.rejects(transaction.commit(), (error) => error.code === "POLICYSQL_DATABASE_TIMEOUT");
  assert.equal(committed, false);
  assert.equal(rolledBack, true);
});

test("database identity scopes retries: a generation change conflicts, a snapshot change keeps the request fingerprint (#80)", async () => {
  const binding = { version: 1, scope: "test:tenant_a", databaseId: "db_a", generation: "1", snapshot: "snapshot_1" };
  const auth = { principal: "issuer:u", subject: "u", role: "member", session: { tenant_id: "a" } };
  const request = "same-idempotency-key";
  const digest = (value, endpoint = "execute") => requestIdentity(identityRuntime, {
    key: request, auth, bodyText: JSON.stringify(envelope(read)), endpoint, databaseBinding: value,
  });
  const first = digest(binding);
  const generation = { ...binding, generation: "2" };
  assert.equal(digest(generation).keyHash, first.keyHash);
  assert.notEqual(digest(generation).fingerprint, first.fingerprint);
  // A deployment that changes the snapshot keeps the request fingerprint, so a committed keyed
  // write replays across it (ADR 0007); the auth fingerprint still has the snapshot.
  const snapshot = { ...binding, snapshot: "snapshot_2" };
  assert.deepEqual(digest(snapshot), first);
  assert.deepEqual(digest(snapshot, "interactive-start").fingerprint, digest(binding, "interactive-start").fingerprint);
  for (const changed of [generation, snapshot]) {
    assert.notEqual(authIdentity(identityRuntime, auth, binding), authIdentity(identityRuntime, auth, changed));
  }
  assert.notEqual(digest({ ...binding, databaseId: "db_b" }).keyHash, first.keyHash);
});

test("binding validation rejects extra credentials and snapshots and captures an immutable copy", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/database-bindings.json", import.meta.url), "utf8"));
  assert.deepEqual(validateDatabaseBinding(fixture.valid, "snapshot_1"), fixture.valid);
  for (const fields of fixture.invalidOverrides) {
    assert.throws(() => validateDatabaseBinding({ ...fixture.valid, ...fields }, "snapshot_1"));
  }
  const original = { version: 1, scope: "test:a", databaseId: "a", generation: "1", snapshot: "snapshot" };
  const captured = validateDatabaseBinding(original, "snapshot");
  original.databaseId = "b";
  assert.equal(captured.databaseId, "a");
  assert.ok(Object.isFrozen(captured));
  assert.throws(() => validateDatabaseBinding({ ...original, token: "secret" }, "snapshot"));
  assert.throws(() => validateDatabaseBinding(original, "different"));
});

test("malformed database configuration cannot enable a legacy fixed-DB fallback", () => {
  const config = { environment: "test" };
  for (const database of [undefined, null, false, {}, { connect() {} }]) {
    assert.throws(() => createApp({ getRuntime: () => ({}), database, config }), TypeError);
    assert.throws(() => new TransactionOwnerCore({}, { getRuntime: () => ({}), database, config }), TypeError);
  }
  const database = { check() {}, connect() {} };
  assert.throws(() => createApp({ getRuntime: () => ({}), database, config, transportFactory() {} }), TypeError);
  assert.throws(() => createApp({ getRuntime: () => ({}), database, config, costTransportFactory() {} }), TypeError);
});

test("revocation before direct commit rolls back without opening a replacement connection", async () => {
  const binding = { version: 1, scope: "test:a", databaseId: "a", generation: "1", snapshot: "snapshot" };
  let allowed = true;
  let commits = 0;
  let rollbacks = 0;
  const provider = { check: () => allowed, connect: () => ({ begin: async () => ({
    open: true, usage: [], execute: async () => [],
    commit: async () => { commits++; }, rollback: async () => { rollbacks++; },
  }) }) };
  const transport = await databaseTransportFactory(provider, binding, 1_024)("request");
  const transaction = await transport.begin("write", 1000);
  allowed = false;
  await assert.rejects(transaction.commit(), (error) => error.code === "POLICYSQL_DATABASE_BINDING_REJECTED");
  assert.equal(commits, 0);
  assert.equal(rollbacks, 1);
});
