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

// The accepted key alphabet: letters, digits, `. _ : -` and the standard and URL-safe base64
// characters `+ / =`, 16-128 bytes. Rejected: anything else, a comma (a repeated header is
// comma-joined), whitespace, controls, non-ASCII.
const BAD_KEYS = [
  null, 1, "", "a".repeat(15), "a".repeat(129), `${key},${key}`, `${key}\n`, `${key}\t`, ` ${key}`, `${key} `,
  "request key 00001", "request-key-00\u00e91", "request-key-0001\u0000", "request-key-0001\u007f",
  "request-key-000!", "request-key-000?", "request-key-00\"1", "request-key-000;", "request-key-00\\1",
  "\uff21".repeat(16), "request-key-0001\u200b",
];
const GOOD_KEYS = [
  "a".repeat(16), "A.b_c:d-0123456789", "z".repeat(128),
  "dGhpcyBpcyBhIGtleSE=", "dGhpcyBpcyBhIGtleQ==", "ab+cd/ef0123456789+/==", "AAAAAAAAAAAAAAAA", "a-b_c-d_e-f_g-h_",
  `${"a".repeat(126)}==`, "=".repeat(16), "+".repeat(16), "/".repeat(16),
];

test("key syntax is core's: a malformed key is POLICYSQL_IDEMPOTENCY_KEY_INVALID, before any hash is used", () => {
  const auth = { principal: "p", subject: "s", role: "member", session: {} };
  for (const bad of BAD_KEYS) {
    assert.throws(
      () => requestIdentity(runtime, { key: bad, auth, bodyText: "{}", endpoint: "execute", databaseBinding: testBinding() }),
      { code: "POLICYSQL_IDEMPOTENCY_KEY_INVALID", message: /^Idempotency-Key must be 16-128 characters/ },
      JSON.stringify(bad),
    );
  }
  for (const good of GOOD_KEYS) {
    assert.match(requestIdentity(runtime, { key: good, auth, bodyText: "{}", endpoint: "execute", databaseBinding: testBinding() }).keyHash, /^[a-f0-9]{64}$/u, good);
  }
});

test("a base64 key and its URL-safe form are different keys with different hashes", () => {
  const auth = { principal: "p", subject: "s", role: "member", session: {} };
  const hash = (k) => requestIdentity(runtime, { key: k, auth, bodyText: "{}", endpoint: "execute", databaseBinding: testBinding() }).keyHash;
  assert.notEqual(hash("ab+cd/ef0123456789=="), hash("ab-cd_ef0123456789=="));
  assert.notEqual(hash("dGhpcyBpcyBhIGtleQ=="), hash("dGhpcyBpcyBhIGtleQ"));
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
