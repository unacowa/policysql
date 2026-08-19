import test from "node:test";
import assert from "node:assert/strict";
import { enforceRateLimit } from "../src/rate-limit.ts";

test("hashes issuer IP subject role tenant and endpoint into the rate key", async () => {
  let key;
  await enforceRateLimit(
    { POLICYSQL_JWT_ISSUER: "issuer", POLICYSQL_RATE_LIMITER: { async limit(input) { key = input.key; return { success: true }; } } },
    { subject: "user_1", role: "member", session: { tenant_id: "tenant_a" } },
    "execute",
    new Request("https://example.test", { headers: { "cf-connecting-ip": "192.0.2.1" } }),
  );
  assert.match(key, /^[a-f0-9]{64}$/);
});

test("fails closed when the binding is unavailable or exhausted", async () => {
  await assert.rejects(
    enforceRateLimit({}, { subject: "u", role: "r", session: {} }, "execute"),
    (error) => error.code === "POLICYSQL_RATE_LIMIT_UNAVAILABLE",
  );
  await assert.rejects(
    enforceRateLimit(
      { POLICYSQL_RATE_LIMITER: { async limit() { return { success: false }; } } },
      { subject: "u", role: "r", session: {} },
      "execute",
    ),
    (error) => error.code === "POLICYSQL_RATE_LIMITED",
  );
});
