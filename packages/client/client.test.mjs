import assert from "node:assert/strict";
import test from "node:test";
import { PolicySqlClient, PolicySqlOutcomeUnknownError } from "./index.js";
import { mockGateway } from "./test-fixture.mjs";

const config = { endpoint: "https://gateway.example.com", token: "token" };
const select = "SELECT id FROM posts";
const setup = (options = {}) => {
  const h = mockGateway();
  return { ...h, client: new PolicySqlClient({ ...config, fetchImpl: h.fetchImpl, ...options }) };
};

test("minimal client omits role/version and makes only the requested HTTP call", async () => {
  const h = setup();
  await h.client.execute(select);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].headers.has("policysql-role"), false);
  assert.equal(h.calls[0].headers.has("x-policysql-role"), false);
  assert.equal(Object.hasOwn(h.calls[0].body, "expected"), false);
  assert.equal(h.client.schemaVersion, undefined);
  assert.equal(h.client.role, undefined);
});

test("explicit role and paired versions use the canonical HTTP contract on atomic and begin", async () => {
  const h = setup({ role: "author", schemaVersion: "s1", policyVersion: "p1" });
  await h.client.execute(select);
  const tx = await h.client.beginTransaction();
  await tx.rollback();
  for (const call of h.calls) assert.equal(call.headers.get("policysql-role"), "author");
  for (const call of h.calls.slice(0, 2)) assert.deepEqual(call.body.expected, { schemaVersion: "s1", policyVersion: "p1" });
  assert.equal(h.calls[1].headers.has("idempotency-key"), false);
  assert.throws(() => { h.client.role = "admin"; }, TypeError);
});

test("invalid explicit configuration never becomes omission", () => {
  for (const options of [
    { schemaVersion: "s" }, { policyVersion: "p" }, { schemaVersion: null, policyVersion: null },
    { schemaVersion: "", policyVersion: "p" }, { schemaVersion: "s", policyVersion: false },
    ...[null, "", false, "ADMIN", "admin,member", "a\nb"].map(role => ({ role })),
    { endpoint: "http://remote.test" }, { endpoint: "ftp://localhost" }, { endpoint: "https://user:password@host.test" },
    { token: "" },
  ]) assert.throws(() => setup(options), TypeError);
});

test("invalid keys, expectations, and JSON parameters fail before sending", async () => {
  const h = setup();
  for (const idempotencyKey of [null, "", false, "short", "a".repeat(129), "invalid key 123456789"]) {
    await assert.rejects(h.client.execute(select, {}, { idempotencyKey }), TypeError);
  }
  for (const expect of [null, {}, { affectedRows: -1 }, { rowCount: 0.5 }, { other: 1 }, { affectedRows: Infinity }]) {
    await assert.rejects(h.client.execute(select, {}, { expect }), TypeError);
  }
  for (const value of [undefined, BigInt(1), Infinity, new Date(), () => 1]) {
    await assert.rejects(h.client.execute(select, { value }), TypeError);
  }
  assert.equal(h.calls.length, 0);
});

test("minimal client binds global fetch to its platform receiver", async () => {
  const previous = globalThis.fetch;
  let receiver;
  globalThis.fetch = function (url, init) { receiver = this; return mockGateway().fetchImpl(url, init); };
  try { await new PolicySqlClient(config).execute(select); assert.equal(receiver, globalThis); }
  finally { globalThis.fetch = previous; }
});

test("unkeyed atomic network and malformed responses are unknown, never automatically replayed", async () => {
  for (const response of [undefined, { status: "failed", results: [], meta: {} }, { status: "committed", results: [{ rows: [], meta: {}, affectedRows: -1 }], meta: {} }]) {
    let calls = 0;
    const client = new PolicySqlClient({ ...config, fetchImpl: async () => {
      calls++;
      if (response === undefined) throw new Error("network credentials must not leak");
      return Response.json(response);
    } });
    await assert.rejects(client.execute("UPDATE posts SET title = :title", { title: "x" }), error => error instanceof PolicySqlOutcomeUnknownError && error.phase === "execute" && !error.message.includes("credentials"));
    assert.equal(calls, 1);
  }
});

test("gateway errors preserve safe codes and are not retried without version preconditions", async () => {
  let count = 0;
  const h = setup({ schemaVersion: "stale", policyVersion: "p", fetchImpl: async () => {
    count++;
    return Response.json({ error: { code: "POLICYSQL_STALE_OPERATION", message: "private schema" } }, { status: 409 });
  } });
  await assert.rejects(h.client.execute(select), { code: "POLICYSQL_STALE_OPERATION", status: 409 });
  await assert.rejects(h.client.beginTransaction(), { code: "POLICYSQL_STALE_OPERATION" });
  assert.equal(count, 2);
});

test("lost begin response creates a fresh transaction before any statement", async () => {
  const gateway = mockGateway();
  let dropped = false;
  const h = setup({ fetchImpl: async (url, init) => {
    const response = await gateway.fetchImpl(url, init);
    if (new URL(url).pathname === "/v1/transactions" && !dropped) { dropped = true; throw new Error("lost begin"); }
    return response;
  } });
  const tx = await h.client.beginTransaction();
  await tx.execute(select);
  await tx.commit();
  assert.equal(gateway.transactions.size, 2);
  assert.equal([...gateway.transactions.values()][0].sequence, 1);
  assert.equal([...gateway.transactions.values()][1].status, "committed");
  assert.ok(gateway.calls.every(call => !call.headers.has("idempotency-key")));
});

for (const terminal of ["commit", "rollback"]) test(`statement and ${terminal} retries keep identical bytes and sequence`, async () => {
  const gateway = mockGateway();
  const lost = new Set();
  const client = new PolicySqlClient({ ...config, fetchImpl: async (url, init) => {
    const response = await gateway.fetchImpl(url, init);
    const path = new URL(url).pathname;
    if ((path.endsWith("/statements") || path.endsWith(`/${terminal}`)) && !lost.has(path)) { lost.add(path); throw new Error("response lost"); }
    return response;
  } });
  const tx = await client.beginTransaction();
  await tx.execute(select);
  await tx[terminal]();
  assert.deepEqual(gateway.calls.map(c => c.body.sequence), [undefined, 1, 1, 2, 2]);
  assert.equal(gateway.calls[1].text, gateway.calls[2].text);
  assert.equal(gateway.calls[3].text, gateway.calls[4].text);
});

test("unknown statement blocks later commands but low-level exact replay can reconcile", async () => {
  const gateway = mockGateway();
  let drop = true;
  const client = new PolicySqlClient({ ...config, fetchImpl: async (url, init) => {
    const response = await gateway.fetchImpl(url, init);
    if (new URL(url).pathname.endsWith("/statements") && drop) throw new Error("lost");
    return response;
  } });
  const tx = await client.beginTransaction();
  await assert.rejects(tx.execute(select), { code: "POLICYSQL_OUTCOME_UNKNOWN", sequence: 1, phase: "statement" });
  await assert.rejects(tx.execute(select), { code: "POLICYSQL_OUTCOME_UNKNOWN" });
  drop = false;
  const recovered = await tx.retryPending();
  assert.equal(recovered.rows.length, 1);
  await tx.commit();
});

test("unknown commit cannot be reversed by rollback, and identical commit can be confirmed", async () => {
  const gateway = mockGateway();
  let drop = true;
  const client = new PolicySqlClient({ ...config, fetchImpl: async (url, init) => {
    const response = await gateway.fetchImpl(url, init);
    if (new URL(url).pathname.endsWith("/commit") && drop) throw new Error("lost");
    return response;
  } });
  const tx = await client.beginTransaction();
  let original;
  await assert.rejects(tx.commit(), error => { original = error; return error.phase === "commit"; });
  await assert.rejects(tx.rollback(), error => error === original);
  assert.ok(!gateway.calls.some(call => call.path.endsWith("/rollback")));
  drop = false;
  await tx.commit();
  assert.equal(tx.status, "committed");
  await tx.closed;
});

test("HTTP 200 failed commit is unknown rather than success or rolled_back", async () => {
  const gateway = mockGateway();
  const client = new PolicySqlClient({ ...config, fetchImpl: async (url, init) => {
    const response = await gateway.fetchImpl(url, init);
    if (new URL(url).pathname.endsWith("/commit")) return Response.json({ ...(await response.json()), status: "failed" });
    return response;
  } });
  const tx = await client.beginTransaction();
  await assert.rejects(tx.commit(), { code: "POLICYSQL_OUTCOME_UNKNOWN" });
  await assert.rejects(tx.rollback(), { code: "POLICYSQL_OUTCOME_UNKNOWN" });
  await tx.dispose();
});

test("terminal queuing preserves submitted statements and rejects later work", async () => {
  const h = setup();
  const tx = await h.client.beginTransaction();
  const first = tx.execute(select);
  const second = tx.execute(select);
  const commit = tx.commit();
  await assert.rejects(tx.execute(select));
  await Promise.all([first, second, commit]);
  assert.deepEqual(h.calls.map(call => call.body.sequence), [undefined, 1, 2, 3]);
});

test("transaction start rejects unsupported keys and invalid mode without I/O", async () => {
  const h = setup();
  for (const options of [null, { idempotencyKey: "unsupported-start-key" }, { mode: null }, { mode: "read only" }]) {
    await assert.rejects(h.client.beginTransaction(options), TypeError);
  }
  assert.equal(h.calls.length, 0);
});

test("begin retries are finite and malformed begin never yields a session", async () => {
  for (const change of [
    body => ({ ...body, transactionId: "../bad" }),
    body => ({ ...body, status: "committed" }),
    body => ({ ...body, nextSequence: 2 }),
    body => ({ ...body, expiresAt: "2000-01-01T00:00:00Z" }),
  ]) {
    const gateway = mockGateway();
    const client = new PolicySqlClient({ ...config, fetchImpl: async (url, init) => {
      const body = await (await gateway.fetchImpl(url, init)).json();
      return Response.json(change(body));
    } });
    await assert.rejects(client.beginTransaction(), { code: "POLICYSQL_OUTCOME_UNKNOWN", phase: "begin" });
    assert.equal(gateway.calls.length, 2);
    assert.ok(gateway.calls.every(c => c.path === "/v1/transactions"));
  }
});

test("expired sessions close locally and cannot start new work", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const h = setup();
  const tx = await h.client.beginTransaction();
  t.mock.timers.tick(4_001);
  await tx.closed;
  await assert.rejects(tx.execute(select), { code: "POLICYSQL_TRANSACTION_UNAVAILABLE" });
  await assert.rejects(tx.commit(), { code: "POLICYSQL_TRANSACTION_UNAVAILABLE" });
  await tx.dispose();
  assert.equal(h.calls.length, 1);
});

test("a later authorization failure does not replace an uncertain commit or allow rollback", async () => {
  const gateway = mockGateway();
  let attempts = 0;
  const client = new PolicySqlClient({ ...config, fetchImpl: async (url, init) => {
    if (new URL(url).pathname.endsWith("/commit")) {
      attempts++;
      if (attempts > 1) return Response.json({ error: { code: "POLICYSQL_FORBIDDEN" } }, { status: 403 });
      await gateway.fetchImpl(url, init);
      throw new Error("lost commit");
    }
    return gateway.fetchImpl(url, init);
  } });
  const tx = await client.beginTransaction();
  let original;
  await assert.rejects(tx.commit(), error => { original = error; return error.code === "POLICYSQL_OUTCOME_UNKNOWN"; });
  await assert.rejects(tx.rollback(), error => error === original);
  assert.equal([...gateway.transactions.values()][0].status, "committed");
  await tx.dispose();
});

test("a malformed statement sequence cannot advance the client or permit commit", async () => {
  const gateway = mockGateway();
  const client = new PolicySqlClient({ ...config, fetchImpl: async (url, init) => {
    const response = await gateway.fetchImpl(url, init);
    if (!new URL(url).pathname.endsWith("/statements")) return response;
    return Response.json({ ...(await response.json()), nextSequence: 99 });
  } });
  const tx = await client.beginTransaction();
  await assert.rejects(tx.execute(select), { code: "POLICYSQL_OUTCOME_UNKNOWN", phase: "statement", sequence: 1 });
  await assert.rejects(tx.commit(), { code: "POLICYSQL_OUTCOME_UNKNOWN" });
  assert.equal(tx.nextSequence, 1);
  assert.deepEqual(gateway.calls.map(c => c.body.sequence), [undefined, 1, 1]);
  await tx.dispose();
});

test("begin timeout bounds even an unresponsive fetch implementation", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  let calls = 0;
  let signal;
  const client = new PolicySqlClient({ ...config, fetchImpl: async (_url, init) => {
    calls++;
    signal = init.signal;
    return new Promise(() => {});
  } });
  const rejected = assert.rejects(client.beginTransaction(), { code: "POLICYSQL_OUTCOME_UNKNOWN", phase: "begin" });
  t.mock.timers.tick(4_001);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
});
