import test from "node:test";
import assert from "node:assert/strict";
import { testBinding } from "./helpers/database.mjs";
import { authIdentity, requestIdentity } from "../src/core-identity.ts";
import { identityRuntime as runtime } from "./helpers/identity.mjs";

const key = "request-key-0001";
const identity = (auth, bodyText, binding = testBinding()) =>
  requestIdentity(runtime, { key, auth, bodyText, endpoint: "execute", databaseBinding: binding });

test("binds the idempotency digest to principal, session and canonical payload", () => {
  const auth = { principal: "https://issuer.test:user_1", subject: "user_1", role: "member", session: { tenant_id: "tenant_a" } };
  const first = identity(auth, "{\"b\":2,\"a\":1}");
  const reordered = identity(auth, " { \"a\" : 1.0 , \"b\" : 2 } ");
  assert.deepEqual(first, reordered);
  const changed = identity({ ...auth, session: { tenant_id: "tenant_b" } }, "{\"a\":1,\"b\":2}");
  assert.notEqual(first.keyHash, changed.keyHash);
  assert.equal(requestIdentity(runtime, { key: undefined, auth, bodyText: "{}", endpoint: "execute", databaseBinding: testBinding() }), null);
});

test("a different principal with the same subject, role and session has its own key space and fingerprint", () => {
  const auth = { principal: "https://issuer-a.test:user_1", subject: "user_1", role: "member", session: { tenant_id: "tenant_a" } };
  const other = { ...auth, principal: "https://issuer-b.test:user_1" };
  const first = identity(auth, "{\"a\":1}");
  const second = identity(other, "{\"a\":1}");
  assert.notEqual(first.keyHash, second.keyHash);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.notEqual(authIdentity(runtime, auth, testBinding()), authIdentity(runtime, other, testBinding()));
  assert.equal(authIdentity(runtime, auth, testBinding()), authIdentity(runtime, { ...auth }, testBinding()));
});

test("key syntax is core's: a bad key is POLICYSQL_IDEMPOTENCY_KEY_REQUIRED, before any hash is used", () => {
  const auth = { principal: "p", subject: "s", role: "member", session: {} };
  for (const bad of [null, 1, "", "a".repeat(15), "a".repeat(129), `${key},${key}`, `${key}\n`, "request key 00001", "request-key-00\u00e91"]) {
    assert.throws(
      () => requestIdentity(runtime, { key: bad, auth, bodyText: "{}", endpoint: "execute", databaseBinding: testBinding() }),
      { code: "POLICYSQL_IDEMPOTENCY_KEY_REQUIRED", message: /^Idempotency-Key must contain 16-128 letters/ },
      JSON.stringify(bad),
    );
  }
  for (const good of ["a".repeat(16), "A.b_c:d-0123456789", "z".repeat(128)]) {
    assert.match(requestIdentity(runtime, { key: good, auth, bodyText: "{}", endpoint: "execute", databaseBinding: testBinding() }).keyHash, /^[a-f0-9]{64}$/u);
  }
});

test("an identity input core rejects is POLICYSQL_INTERNAL, never a hash", () => {
  const auth = { principal: "p", subject: "s", role: "member", session: {} };
  for (const broken of [{ ...auth, principal: undefined }, { ...auth, subject: 1 }, { ...auth, session: { tenant_id: 1 } }]) {
    assert.throws(() => authIdentity(runtime, broken, testBinding()), { code: "POLICYSQL_INTERNAL" });
    assert.throws(() => identity(broken, "{}"), { code: "POLICYSQL_INTERNAL" });
  }
  // A runtime whose answer is not core's shape fails closed too.
  for (const output of ["", "{}", "{\"fingerprint\":\"ABC\"}", "{\"idempotency\":{\"keyHash\":1}}"]) {
    const fake = { identity_json: () => output };
    assert.throws(() => authIdentity(fake, auth, testBinding()), { code: "POLICYSQL_INTERNAL" }, output);
    assert.throws(() => requestIdentity(fake, { key, auth, bodyText: "{}", endpoint: "execute", databaseBinding: testBinding() }),
      { code: "POLICYSQL_INTERNAL" }, output);
  }
});
