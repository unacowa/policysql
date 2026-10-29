import test from "node:test";
import assert from "node:assert/strict";
import { testBinding } from "./helpers/database.mjs";
import { authFingerprint, mutationIdempotency } from "../src/idempotency.ts";

const keyed = () => "request-key-0001";

test("binds the idempotency digest to principal, session and canonical payload", async () => {
  const auth = { principal: "https://issuer.test:user_1", subject: "user_1", role: "member", session: { tenant_id: "tenant_a" } };
  const first = await mutationIdempotency(keyed(), auth, { b: 2, a: 1 }, testBinding());
  const reordered = await mutationIdempotency(keyed(), auth, { a: 1, b: 2 }, testBinding());
  assert.deepEqual(first, reordered);
  const changed = await mutationIdempotency(keyed(), { ...auth, session: { tenant_id: "tenant_b" } }, { a: 1, b: 2 }, testBinding());
  assert.notEqual(first.keyHash, changed.keyHash);
});

test("a different principal with the same subject, role and session has its own key space and fingerprint", async () => {
  const auth = { principal: "https://issuer-a.test:user_1", subject: "user_1", role: "member", session: { tenant_id: "tenant_a" } };
  const other = { ...auth, principal: "https://issuer-b.test:user_1" };
  const first = await mutationIdempotency(keyed(), auth, { a: 1 }, testBinding());
  const second = await mutationIdempotency(keyed(), other, { a: 1 }, testBinding());
  assert.notEqual(first.keyHash, second.keyHash);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.notEqual(await authFingerprint(auth, testBinding()), await authFingerprint(other, testBinding()));
  assert.equal(await authFingerprint(auth, testBinding()), await authFingerprint({ ...auth }, testBinding()));
});
