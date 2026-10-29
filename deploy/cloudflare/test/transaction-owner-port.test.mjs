// TransactionOwner port conformance (ADR 0022). One suite, run against every adapter: the
// production Durable Objects adapter over a simulated platform, and the in-memory adapter.
// Each case drives the public HTTP routes through the real WASM core, the real HTTP database
// transport, and SQLite; only the owner platform differs. A custom adapter passes this suite
// by adding itself to OWNER_ADAPTERS in helpers/routing.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";
import { createApp } from "../src/app.ts";
import { durableObjectTransactionOwners, durableObjectTransactionOwnerClass, executionContextTasks } from "../src/adapters/durable-objects.ts";
import { testBinding, testConfig, testOwners, testProvider } from "./helpers/database.mjs";

const read = { sql: "SELECT id, name FROM projects ORDER BY id", params: {} };
const insert = (id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name: id } });
const statements = (h, prefix) => h.events.filter(({ sql }) => sql.startsWith(prefix)).length;

for (const ownerAdapter of OWNER_ADAPTERS) {
  const setup = (t, options = {}) => harness(t, { ownerAdapter, ...options });
  const start = async (h, mode, key = null, tenant = "a") => {
    const started = await h.request(tenant, "/v1/transactions", { mode }, key);
    assert.equal(started.status, 201, JSON.stringify(started.body));
    return started.body.transactionId;
  };

  test(`${ownerAdapter}: commands to one owner are serialized in arrival order`, async (t) => {
    const h = await setup(t, { hooks: false });
    const id = await start(h, "read");
    const path = `/v1/transactions/${id}/statements`;
    // Identical concurrent retries: the first executes, the second replays its response.
    const before = statements(h, "SELECT");
    const duplicates = await Promise.all([1, 2].map(() => h.request("a", path, { sequence: 1, ...read }, null)));
    assert.deepEqual(duplicates.map((result) => result.status), [200, 200]);
    assert.deepEqual(duplicates[1].body, duplicates[0].body);
    assert.equal(statements(h, "SELECT") - before, 1, "one execution for two identical commands");
    // Different concurrent commands for the same sequence: whichever reaches the owner second
    // (the Worker-side steps before the owner may reorder them) conflicts and rolls back.
    const different = await Promise.all([
      h.request("a", path, { sequence: 2, ...read }, null),
      h.request("a", path, { sequence: 2, sql: "SELECT id FROM projects", params: {} }, null),
    ]);
    assert.deepEqual(different.map((result) => result.status).sort(), [200, 409]);
    assert.equal(different.find((result) => result.status === 409).body.error.code, "POLICYSQL_TRANSACTION_CONFLICT");
    assert.equal((await h.ownerRecord(id)).status, "failed");
    assert.ok(h.events.some(({ sql }) => sql === "ROLLBACK"));
  });

  test(`${ownerAdapter}: commands are processed in the order they reach the owner, whatever their body timing`, async (t) => {
    const h = await setup(t, { hooks: false });
    const id = await start(h, "write");
    const { authFingerprint, databaseBinding, snapshot } = await h.ownerRecord(id);
    const owner = h.transactionOwners.route(id);
    const input = (command) => ({ transactionId: id, authFingerprint, command, databaseBinding, snapshot });
    // The first message's body is delivered late. A later command must not overtake it:
    // overtaking would put sequence 2 before 1 and fail the transaction (ADR 0007).
    h.delayNextOwnerBody(30);
    const replies = await Promise.all([
      owner.command("statement", input({ sequence: 1, ...insert("ordered") }), "req_1"),
      owner.command("commit", input({ sequence: 2 }), "req_2"),
    ]);
    assert.deepEqual(replies.map((reply) => reply.ok), [true, true], JSON.stringify(replies));
    assert.equal(replies[1].value.status, "committed");
    assert.ok(h.rows("a").some((row) => row.id === "ordered"));
  });

  test(`${ownerAdapter}: timer expiry and owner loss while a commit waits on its validator never commit`, async (t) => {
    const h = await setup(t);
    for (const [label, interrupt] of [["expired", (id) => h.fireTimer(id)], ["lost", (id) => h.loseOwner(id)]]) {
      const id = await start(h, "write");
      const path = `/v1/transactions/${id}`;
      assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert(label) }, null)).status, 200);
      h.setValidator(async () => { await interrupt(id); return true; });
      const commit = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
      const retry = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
      if (label === "expired") {
        // Expiry ends the commit on the waiting lane: the check is rejected and rolled back.
        assert.equal(commit.status, 409, label);
        assert.equal(commit.body.error.code, "POLICYSQL_COMMIT_CHECK_REJECTED", label);
        assert.equal((await h.ownerRecord(id)).status, "failed", label);
      } else {
        // The lost owner cannot record anything; its successor has no open transaction.
        assert.equal(commit.status, 500, label);
        assert.equal(commit.body.error.code, "POLICYSQL_INTERNAL", label);
        assert.equal(retry.status, 409, label);
        assert.equal(retry.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE", label);
      }
      assert.notEqual(commit.body.status, "committed", label);
      assert.notEqual(retry.body.status, "committed", label);
      assert.equal(h.rows("a").some((row) => row.id === label), false, label);
    }
  });

  test(`${ownerAdapter}: one name has exactly one owner, and names are isolated`, async (t) => {
    const h = await setup(t, { hooks: false });
    // The same start key, concurrently: one owner, one database transaction.
    const keyed = await Promise.all([1, 2].map(() => h.request("a", "/v1/transactions", { mode: "read" }, "same-start-key-0001")));
    assert.deepEqual(keyed.map((result) => result.status), [201, 201]);
    assert.equal(keyed[0].body.transactionId, keyed[1].body.transactionId);
    assert.deepEqual(h.ownerNames(), [keyed[0].body.transactionId]);
    assert.equal(statements(h, "BEGIN"), 1);
    // Unkeyed starts get separate owners whose state does not mix.
    const [first, second] = await Promise.all([start(h, "read"), start(h, "write")]);
    assert.notEqual(first, second);
    assert.equal(h.ownerNames().length, 3);
    assert.deepEqual([(await h.ownerRecord(first)).mode, (await h.ownerRecord(second)).mode], ["read", "write"]);
    assert.equal((await h.request("a", `/v1/transactions/${first}/rollback`, { sequence: 1 }, null)).status, 200);
    assert.equal((await h.ownerRecord(second)).status, "active");
  });

  test(`${ownerAdapter}: owner loss fails the transaction closed and never reconnects`, async (t) => {
    const h = await setup(t, { hooks: false });
    const id = await start(h, "write");
    const path = `/v1/transactions/${id}`;
    assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert("lost") }, null)).status, 200);
    const connects = h.counts().connects;
    h.loseOwner(id);
    const after = await h.request("a", `${path}/statements`, { sequence: 2, ...read }, null);
    assert.equal(after.status, 409);
    assert.equal(after.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
    assert.equal((await h.ownerRecord(id)).status, "failed");
    const commit = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
    assert.equal(commit.status, 409, "a lost transaction is never reported committed");
    assert.equal(h.counts().connects, connects, "no replacement connection");
    assert.equal(h.rows("a").some((row) => row.id === "lost"), false);
  });

  test(`${ownerAdapter}: the owner timer expires an open transaction and rolls it back`, async (t) => {
    const h = await setup(t, { hooks: false });
    const id = await start(h, "write");
    assert.equal(h.ownerTimerAt(id), (await h.ownerRecord(id)).expiresAtMs, "begin schedules expiry at the deadline");
    assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("expired") }, null)).status, 200);
    assert.equal(await h.fireTimer(id), true);
    assert.equal((await h.ownerRecord(id)).status, "expired");
    assert.ok(h.events.some(({ sql }) => sql === "ROLLBACK"));
    const after = await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 }, null);
    assert.equal(after.status, 409);
    assert.equal(h.rows("a").some((row) => row.id === "expired"), false);
  });

  test(`${ownerAdapter}: exact retry replays a command and a terminal response; a changed payload conflicts`, async (t) => {
    const h = await setup(t, { hooks: false });
    const id = await start(h, "write");
    const path = `/v1/transactions/${id}`;
    const command = { sequence: 1, ...insert("retried") };
    const first = await h.request("a", `${path}/statements`, command, null);
    assert.deepEqual((await h.request("a", `${path}/statements`, command, null)).body, first.body);
    assert.equal(statements(h, 'INSERT INTO "projects"'), 1);
    const committed = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
    assert.equal(committed.body.status, "committed");
    assert.deepEqual((await h.request("a", `${path}/commit`, { sequence: 2 }, null)).body, committed.body);
    assert.equal((await h.request("a", `${path}/rollback`, { sequence: 2 }, null)).status, 409, "a different terminal command conflicts");
    assert.equal(h.rows("a").filter((row) => row.id === "retried").length, 1);

    const other = await start(h, "write");
    const otherPath = `/v1/transactions/${other}/statements`;
    assert.equal((await h.request("a", otherPath, { sequence: 1, ...insert("kept") }, null)).status, 200);
    const changed = await h.request("a", otherPath, { sequence: 1, ...insert("changed") }, null);
    assert.equal(changed.status, 409);
    assert.equal((await h.ownerRecord(other)).status, "failed");
  });

  test(`${ownerAdapter}: commit-check callbacks reach the owner of the open transaction`, async (t) => {
    const h = await setup(t);
    const id = await start(h, "write");
    const path = `/v1/transactions/${id}`;
    assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert("checked") }, null)).status, 200);
    const committed = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    assert.equal(committed.body.meta.commitChecks, "passed");
    assert.equal(h.hooksSeen.length, 1);
    const [{ hook, status, result }] = h.hooksSeen;
    assert.equal(status, 200, JSON.stringify(result));
    assert.equal(hook.validationId, id.replace(/^tx_/u, "cval_"), "the capability names this owner");
    assert.ok(result.rows.some((row) => row.id === "checked"), "the callback sees the owner's uncommitted row");
    assert.deepEqual(h.ownerNames(), [id], "the callback created no other owner");
    // A callback for a name with no open transaction is unavailable, and a capability
    // the owner did not issue fails the check and rolls back.
    const stranger = await h.request("a", `/v1/commit-checks/cval_${"0".repeat(32)}/query`, { sequence: 1, ...read }, undefined, "A".repeat(43));
    assert.equal(stranger.status, 409);
    const forged = await start(h, "write");
    h.setValidator(async (issued) => {
      const response = await h.request("a", new URL(issued.query.url).pathname, { sequence: 1, ...read }, undefined, "B".repeat(43));
      assert.equal(response.status, 409);
      return true;
    });
    assert.equal((await h.request("a", `/v1/transactions/${forged}/statements`, { sequence: 1, ...insert("forged") }, null)).status, 200);
    const rejected = await h.request("a", `/v1/transactions/${forged}/commit`, { sequence: 2 }, null);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "POLICYSQL_COMMIT_CHECK_REJECTED");
    assert.equal(h.rows("a").some((row) => row.id === "forged"), false);
  });

  test(`${ownerAdapter}: the owner pins the database binding for commands and callbacks (ADR 0014)`, async (t) => {
    const h = await setup(t);
    const id = await start(h, "write");
    const path = `/v1/transactions/${id}`;
    // Another database's binding cannot drive this owner, and does not end it.
    const crossed = await h.request("b", `${path}/statements`, { sequence: 1, ...insert("pinned") }, null);
    assert.equal(crossed.status, 409);
    assert.equal((await h.ownerRecord(id)).databaseBinding.databaseId, "db_a");
    assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert("pinned") }, null)).status, 200);
    const before = h.events.length;
    assert.equal((await h.request("a", `${path}/commit`, { sequence: 2 }, null)).status, 200);
    assert.ok(h.events.slice(before).every((event) => event.tenant === "a"), "callback and commit use the pinned database");
    assert.ok(h.hooksSeen[0].result.rows.every((row) => row.id !== "seed" || row.name === "database_a"));
    assert.ok(h.rows("a").some((row) => row.id === "pinned"));
    assert.equal(h.rows("b").some((row) => row.id === "pinned"), false);
  });
}

// Durable Objects adapter specifics, beyond the shared contract.
test("durable-objects: the wire to the object is the internal HTTP form, and replies come back as data", async () => {
  const sent = [];
  const namespace = {
    idFromName: (name) => ({ name }),
    get: (id) => ({
      async fetch(url, init) {
        sent.push({ name: id.name, url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
        if (new URL(url).pathname === "/rollback") {
          return Response.json({ error: { code: "POLICYSQL_TRANSACTION_CONFLICT", message: "m", path: null, requestId: "old" } }, { status: 409 });
        }
        return Response.json({ started: true }, { status: 201 });
      },
    }),
  };
  const owner = durableObjectTransactionOwners(namespace).route(`tx_${"a".repeat(32)}`);
  // A 2xx reply is the value; any other is the error, whatever its wire status (ADR 0023).
  assert.deepEqual(await owner.begin({ transactionId: "x" }, "req_1"), { ok: true, value: { started: true } });
  await owner.command("statement", { transactionId: "x" }, "req_2");
  assert.deepEqual(await owner.command("rollback", { transactionId: "x" }, "req_3"),
    { ok: false, error: { code: "POLICYSQL_TRANSACTION_CONFLICT", message: "m", path: null } });
  await owner.callbackQuery({ capability: "cap", command: { sequence: 1 } }, "req_4");
  assert.deepEqual(sent.map(({ url }) => new URL(url).pathname), ["/begin", "/statement", "/rollback", "/validation-query"]);
  assert.ok(sent.every(({ name, method }) => name === `tx_${"a".repeat(32)}` && method === "POST"));
  assert.equal(sent[3].headers.authorization, "Bearer cap");
  assert.equal(sent[3].headers["x-policysql-request-id"], "req_4");
  assert.deepEqual(sent[3].body, { sequence: 1 });
  await assert.rejects(owner.command("unknown", {}, "req"), TypeError);
  assert.throws(() => durableObjectTransactionOwners(undefined), TypeError);
  assert.throws(() => durableObjectTransactionOwners({ get() {} }), TypeError);
});

test("durable-objects: a non-JSON object reply is a safe 500, never forwarded", async (t) => {
  t.mock.method(console, "log", () => {});
  const namespace = { idFromName: (name) => name, get: () => ({ fetch: async () => new Response("<html>internal detail</html>", { status: 500 }) }) };
  const runtime = { snapshot: "test-snapshot", max_bytes_per_value: 1_024, authorize_session_json: () => JSON.stringify({ ok: true }) };
  const app = createApp({ getRuntime: () => runtime, database: testProvider(), config: testConfig(), transactionOwners: durableObjectTransactionOwners(namespace) });
  const response = await app.fetchCallback(new Request(`https://worker.test/v1/commit-checks/cval_${"0".repeat(32)}/query`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sequence: 1, ...read }),
  }));
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.equal(JSON.parse(text).error.code, "POLICYSQL_INTERNAL");
  assert.equal(text.includes("internal detail"), false);
});

test("durable-objects: the object class decodes the internal messages and fails malformed ones as invalid", async () => {
  const values = new Map();
  let alarm = null;
  const state = {
    waitUntil() {},
    storage: { async get(key) { return values.get(key); }, async put(key, value) { values.set(key, value); }, async setAlarm(at) { alarm = at; } },
  };
  const OwnerObject = durableObjectTransactionOwnerClass(() => ({
    getRuntime: () => ({ snapshot: "test-snapshot", max_bytes_per_value: 1_024 }),
    database: testProvider(() => ({ begin: async () => ({ open: true, usage: [], async rollback() { this.open = false; } }) })),
    config: testConfig(),
  }));
  const object = new OwnerObject(state, {});
  const send = (path, body, headers = {}) => object.fetch(new Request(`https://owner${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-policysql-request-id": "req_obj", ...headers }, body,
  }));
  for (const [path, body] of [["/begin", "{"], ["/atomic", "null"], ["/statement", "[]"], ["/unknown", "{}"]]) {
    const response = await send(path, body);
    assert.equal(response.status, 500, `${path}: the wire marks every error reply the same way`);
    const reply = await response.json();
    assert.deepEqual(reply, { error: { code: "POLICYSQL_INVALID_REQUEST", message: "The request is invalid.", path: null } }, path);
  }
  const begun = await send("/begin", JSON.stringify({
    transactionId: `tx_${"a".repeat(32)}`, authFingerprint: "b".repeat(64), startFingerprint: "c".repeat(64), mode: "read",
    auth: {}, databaseBinding: testBinding(), snapshot: "test-snapshot",
  }));
  assert.equal(begun.status, 200);
  assert.equal((await begun.json()).transactionId, `tx_${"a".repeat(32)}`);
  assert.equal(alarm, values.get("transaction").expiresAtMs, "the core's timer is the object's alarm");
  await object.alarm();
  assert.equal(values.get("transaction").status, "expired");
});

test("durable-objects: ExecutionContext.waitUntil backs per-request BackgroundTasks", () => {
  const kept = [];
  const tasks = executionContextTasks({ waitUntil: (task) => kept.push(task), passThroughOnException() {} });
  const task = Promise.resolve();
  tasks.run(task);
  assert.deepEqual(kept, [task]);
  assert.equal(executionContextTasks(undefined), undefined);
  assert.equal(executionContextTasks({}), undefined);
});

test("createApp requires a TransactionOwner port, and app.fetch rejects malformed BackgroundTasks before any work", async (t) => {
  t.mock.method(console, "log", () => {});
  const runtime = { snapshot: "test-snapshot", max_bytes_per_value: 1_024 };
  for (const transactionOwners of [undefined, null, {}, { route: 1 }]) {
    assert.throws(() => createApp({ getRuntime: () => runtime, database: testProvider(), config: testConfig(), transactionOwners }), TypeError);
  }
  let runtimeCalls = 0;
  const app = createApp({ getRuntime: () => { runtimeCalls++; return runtime; }, database: testProvider(), config: testConfig(), transactionOwners: testOwners() });
  for (const background of [null, {}, { run: "no" }]) {
    const response = await app.fetch(new Request("https://worker.test/healthz"), { database: testBinding() }, background);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, "POLICYSQL_INTERNAL");
  }
  assert.equal(runtimeCalls, 0);
  const ok = await app.fetch(new Request("https://worker.test/healthz"), { database: testBinding() }, { run() {} });
  assert.equal(ok.status, 200);
});
