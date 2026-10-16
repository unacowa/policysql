import assert from "node:assert/strict";
import test from "node:test";
import { PolicySqlClient } from "./index.js";
import { Kysely, DummyDriver, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from "kysely";
import { createPolicyKysely, policyMutation } from "../kysely/index.js";
import { createExampleClient, prepareProjectRename } from "../../examples/database-routing/client.mjs";

test("client sends one version-pinned atomic statement without database credentials", async () => {
  let captured;
  const client = new PolicySqlClient({
    endpoint: "https://gateway.example.com",
    token: "build-or-runtime-token",
    role: "author",
    schemaVersion: "schema_1",
    policyVersion: "policy_1",
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({
        results: [{ rows: [{ id: "1" }], rowCount: 1, affectedRows: 1, meta: {} }],
        meta: {},
        debug: { executionTrace: { source: "turso-egress" } },
      }));
    },
  });
  const result = await client.execute("SELECT id FROM posts WHERE id = :id", { id: "1" });
  assert.deepEqual(result.rows, [{ id: "1" }]);
  assert.equal(result.rowCount, 1);
  assert.equal(result.affectedRows, 1);
  assert.deepEqual(result.debug, { executionTrace: { source: "turso-egress" } });
  assert.equal(captured.url, "https://gateway.example.com/v1/transactions:execute");
  assert.deepEqual(JSON.parse(captured.init.body).expected, {
    schemaVersion: "schema_1",
    policyVersion: "policy_1",
  });
  assert.equal(captured.init.headers["x-policysql-role"], "author");
});

test("client binds the platform fetch receiver", async () => {
  const originalFetch = globalThis.fetch;
  let receiver;
  globalThis.fetch = async function () {
    receiver = this;
    return new Response(JSON.stringify({ results: [{ rows: [], meta: {} }], meta: {} }));
  };
  try {
    const client = new PolicySqlClient({
      endpoint: "https://gateway.example.com",
      token: "token",
      role: "viewer",
      schemaVersion: "schema_1",
      policyVersion: "policy_1",
    });
    await client.execute("SELECT id FROM posts");
    assert.equal(receiver, globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kysely options reach HTTP as omitted, generated, or stable explicit headers", async () => {
  const requests = [];
  const client = new PolicySqlClient({
    endpoint: "https://gateway.example.com", token: "token", role: "author",
    schemaVersion: "schema_1", policyVersion: "policy_1",
    fetchImpl: async (_url, init) => {
      requests.push({ headers: init.headers, body: JSON.parse(init.body) });
      return Response.json({ results: [{ rows: [], affectedRows: 1, meta: {} }], meta: {} });
    },
  });
  const rawDb = new Kysely({ dialect: {
    createAdapter: () => new SqliteAdapter(), createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db), createQueryCompiler: () => new SqliteQueryCompiler(),
  } });
  const ordinary = createPolicyKysely({ kysely: rawDb, client });
  const automatic = createPolicyKysely({ kysely: rawDb, client, autoIdempotencyKey: true });
  const update = (db) => db.updateTable("posts").set({ title: "Updated" }).where("id", "=", "post_1");
  await update(ordinary).execute();
  assert.equal(Object.hasOwn(requests[0].headers, "idempotency-key"), false);
  await update(automatic).execute();
  assert.match(requests[1].headers["idempotency-key"], /^[a-f0-9-]{36}$/);
  const operation = policyMutation(update(ordinary), { idempotencyKey: "stable-request-key-01", expect: { affectedRows: 1 } });
  await operation.execute();
  await operation.execute();
  assert.deepEqual(requests[2], requests[3]);
  assert.equal(requests[2].headers["idempotency-key"], "stable-request-key-01");
  assert.deepEqual(requests[2].body.statements[0].expect, { affectedRows: 1 });
  for (const idempotencyKey of ["", null, false, "short", "a".repeat(129), "first-request-key,second-request-key"]) {
    await assert.rejects(policyMutation(update(automatic), { idempotencyKey }).execute(), /idempotencyKey must contain/);
  }
  assert.equal(requests.length, 4, "invalid explicit keys are never omitted or replaced by generated keys");
  await rawDb.destroy();
});

test("the database-routing client example preserves an operation's key and payload on retry", async () => {
  const requests = [];
  const db = createExampleClient({
    endpoint: "https://gateway.example.com", token: "token", role: "member",
    schemaVersion: "schema_routing_1", policyVersion: "policy_routing_1",
    fetchImpl: async (_url, init) => {
      requests.push({ headers: init.headers, body: JSON.parse(init.body) });
      return Response.json({ results: [{ rows: [{ id: "demo_1", name: "Changed" }], meta: {} }], meta: {} });
    },
  });
  await db.updateTable("projects").set({ name: "Changed" }).where("id", "=", "demo_1").execute();
  assert.equal(Object.hasOwn(requests[0].headers, "idempotency-key"), false);
  const operation = prepareProjectRename(db, { id: "demo_1", name: "Changed" });
  await operation.send();
  await operation.send();
  assert.equal(requests[1].headers["idempotency-key"], operation.idempotencyKey);
  assert.deepEqual(requests[1], requests[2]);
  assert.notEqual(prepareProjectRename(db, { id: "demo_1", name: "Another" }).idempotencyKey, operation.idempotencyKey);
  await db.destroy();
});
