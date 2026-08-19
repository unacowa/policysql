import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";

const runtime = {
  abi_version: 1,
  profile: "sqlite-turso-v1",
  snapshot: "sqlite-turso-v1:schema_dev_2:policy_dev_2:abi-1",
  commit_checks_enabled: false,
};

const env = {
  POLICYSQL_ENVIRONMENT: "test",
  POLICYSQL_JWKS_JSON: "{}",
  POLICYSQL_JWT_ISSUER: "https://issuer.test",
  POLICYSQL_JWT_AUDIENCE: "policysql-test",
};

test("Hono health route preserves the public response and security headers", async () => {
  const app = createApp({ getRuntime: () => runtime });
  const response = await app.request("https://worker.test/healthz", {}, env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(body.ready, true);
  assert.equal(body.snapshot, runtime.snapshot);
  assert.equal(typeof body.requestId, "string");
});

test("Hono not-found handler preserves the safe error contract", async () => {
  let runtimeCalls = 0;
  const app = createApp({ getRuntime: () => {
    runtimeCalls += 1;
    return runtime;
  } });
  const response = await app.request("https://worker.test/not-a-route", {}, env);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, "POLICYSQL_NOT_FOUND");
  assert.equal(body.error.path, null);
  assert.equal(typeof body.error.requestId, "string");
  assert.equal(runtimeCalls, 0, "routes that do not compile SQL must not initialize Wasm");
});
