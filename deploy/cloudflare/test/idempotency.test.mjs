import test from "node:test";
import assert from "node:assert/strict";
import { testBinding } from "./helpers/database.mjs";
import { mutationIdempotency } from "../src/idempotency.ts";

test("binds the idempotency digest to identity session and canonical payload", async () => {
  const auth = { subject: "user_1", role: "member", session: { tenant_id: "tenant_a" } };
  const env = { POLICYSQL_JWT_ISSUER: "issuer" };
  const first = await mutationIdempotency(
    new Request("https://worker.test", { headers: { "idempotency-key": "request-key-0001" } }),
    env,
    auth,
    { b: 2, a: 1 },
    testBinding(),
  );
  const reordered = await mutationIdempotency(
    new Request("https://worker.test", { headers: { "idempotency-key": "request-key-0001" } }),
    env,
    auth,
    { a: 1, b: 2 },
    testBinding(),
  );
  assert.deepEqual(first, reordered);
  const changed = await mutationIdempotency(
    new Request("https://worker.test", { headers: { "idempotency-key": "request-key-0001" } }),
    env,
    { ...auth, session: { tenant_id: "tenant_b" } },
    { a: 1, b: 2 },
    testBinding(),
  );
  assert.notEqual(first.keyHash, changed.keyHash);
});
