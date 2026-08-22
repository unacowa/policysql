import assert from "node:assert/strict";
import test from "node:test";
import { PolicySqlClient } from "./index.js";

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
      return new Response(JSON.stringify({ results: [{ rows: [{ id: "1" }], rowCount: 1, affectedRows: 1, meta: {} }], meta: {} }));
    },
  });
  const result = await client.execute("SELECT id FROM posts WHERE id = :id", { id: "1" });
  assert.deepEqual(result.rows, [{ id: "1" }]);
  assert.equal(result.rowCount, 1);
  assert.equal(result.affectedRows, 1);
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
