// The engine decides before the body is read whether a request can be the retry of a keyed
// write (`validIdempotencyKey`, src/core-identity.ts). That predicate must agree exactly with
// core's `valid_idempotency_key`, which remains the authority that answers
// POLICYSQL_IDEMPOTENCY_KEY_INVALID: a disagreement would turn a definite client error into an
// unknown outcome, or let a key that can never have committed be answered as unknown (#100).
import assert from "node:assert/strict";
import test from "node:test";
import { validIdempotencyKey } from "../src/core-identity.ts";
import { harness } from "./helpers/routing.mjs";

test("the engine's Idempotency-Key predicate agrees with core's identity_json", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = await harness(t, { hooks: false });
  const auth = JSON.parse(h.runtime.authorize_session_json(JSON.stringify(h.session("a")), undefined, "execute")).auth;
  const binding = h.binding("a");
  const keys = [
    // The boundaries and every class from core's own key test (identity.rs).
    "a".repeat(15), "a".repeat(16), "a".repeat(128), "a".repeat(129), "request-key-0001",
    "=".repeat(16), `${"a".repeat(126)}==`, `${"a".repeat(127)}==`,
    "dGhpcyBpcyBhIGtleSE=", "dGhpcyBpcyBhIGtleQ==", "ab+cd/ef0123456789==", "a-b_c-d_e-f_g-h_",
    "", "request-key-0001,request-key-0002", "request key 0001", "request-key-00é1",
    "request-key-0001\n", "request-key-0001\t", " request-key-0001", "request-key-0001 ",
    "request-key-0001\0", "request-key-0001\u007f", "request-key-000!", "request-key-00?1",
    "request-key-00\"1", "request-key-00\\1", "request-key-000;", "Ａ".repeat(16),
    "request-key-0001​",
  ];
  for (const key of keys) {
    const result = JSON.parse(h.runtime.identity_json(JSON.stringify({
      op: "request", endpoint: "execute", auth, binding, body: "{}", key,
    })));
    assert.equal(validIdempotencyKey(key), result.idempotency !== undefined, JSON.stringify(key));
    if (result.error) {
      assert.equal(result.error.code, "POLICYSQL_IDEMPOTENCY_KEY_INVALID", JSON.stringify(key));
    }
  }
  // Anything but a string is sent to core as null and rejected; the predicate says false too.
  for (const key of [null, 123, 0, true, {}, [], ["request-key-0001"]]) {
    assert.equal(validIdempotencyKey(key), false, JSON.stringify(key));
  }
});
