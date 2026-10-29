// Request-rate limiting is a wrapper responsibility (ADR 0018, #26). The library has no
// limiter; the reference wrapper and the database-routing example limit before app.fetch.
import { harness } from "./helpers/routing.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.ts";
import { createErrorResponse } from "../src/errors.ts";
import { createWrapperFetch } from "../wrapper/fetch.ts";
import { RATE_LIMIT_PERIOD_SECONDS, rateLimitKey } from "../wrapper/rate-limit.ts";
import { withRateLimit as exampleRateLimit } from "../../../examples/database-routing/rate-limit.ts";

const schemaVersion = "schema_routing_1";
const policyVersion = "policy_routing_1";
const limits = { maxRows: 100, maxResultBytes: 64_000, timeoutMs: 1_000, maxStatements: 8 };
const read = { sql: "SELECT id, name FROM projects ORDER BY id", params: {} };
const envelope = (...statements) => ({ statements });

const limiter = (success) => {
  const keys = [];
  return { keys, async limit({ key }) { keys.push(key); return { success }; } };
};

// The wrapper's binding() reads getRuntime().snapshot, which is where WASM is compiled and
// the runtime constructed. Count runtime factory calls as the WASM-compile probe.
const lazyApp = (h) => {
  let runtimeCalls = 0;
  const getRuntime = () => { runtimeCalls++; return h.runtime; };
  const app = createApp({ getRuntime, database: h.database, publicConfig: { schemaVersion, policyVersion, limits } });
  const binding = () => { getRuntime(); return h.binding("a"); };
  return { app, binding, runtimeCalls: () => runtimeCalls };
};

const call = async (fetch, env, h, path, body, headers = {}) => {
  const response = await fetch(new Request(`https://worker.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${await h.token("a")}`, "content-type": "application/json",
      "cf-connecting-ip": "192.0.2.10", "cf-ray": "req_rate", ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, h.ctx);
  return { status: response.status, headers: response.headers, body: await response.json() };
};

const assertRateLimited = (result, retryAfter) => {
  assert.equal(result.status, 429);
  assert.deepEqual(result.body, {
    error: { code: "POLICYSQL_RATE_LIMITED", message: "Too many requests.", path: null, requestId: "req_rate" },
  });
  assert.equal(result.headers.get("retry-after"), retryAfter);
  assert.equal(result.headers.get("cache-control"), "no-store");
};

test("library source has no rate limiter, tenant claim, or client-IP dependency", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const files = readdirSync(root, { recursive: true }).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 10);
  for (const name of files) {
    const source = readFileSync(join(root, name), "utf8");
    for (const forbidden of ["tenant_id", "cf-connecting-ip", "POLICYSQL_RATE_LIMITER", "RATE_LIMIT_UNAVAILABLE", "POLICYSQL_RATE_LIMITED"]) {
      assert.equal(source.includes(forbidden), false, `${name} references ${forbidden}`);
    }
  }
});

test("every library endpoint works without any rate limiting binding", async (t) => {
  const h = await harness(t);
  for (const key of Object.keys(h.env)) assert.doesNotMatch(key, /RATE/);
  assert.equal((await h.request("a", "/v1/capabilities")).status, 200);
  assert.equal((await h.request("a", "/v1/catalog")).status, 200);
  assert.equal((await h.request("a", "/v1/transactions:explain", envelope(read))).status, 200);
  const executed = await h.request("a", "/v1/transactions:execute", envelope(read));
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  const start = await h.request("a", "/v1/transactions", { mode: "write" }, null);
  assert.equal(start.status, 201, JSON.stringify(start.body));
  const path = `/v1/transactions/${start.body.transactionId}`;
  const insert = { sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id: "no_limiter", name: "x" } };
  assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert }, null)).status, 200);
  // The commit runs the policy's commit check, whose validator calls fetchCallback.
  assert.equal((await h.request("a", `${path}/commit`, { sequence: 2 }, null)).status, 200);
  await h.flush();
  assert.equal(h.hooksSeen.length, 1);
  assert.equal(h.hooksSeen[0].status, 200);
  assert.ok(h.rows("a").some((row) => row.id === "no_limiter"));
});

test("the library ignores a limiter binding left in env", async (t) => {
  const h = await harness(t);
  const legacy = limiter(false);
  h.env.POLICYSQL_RATE_LIMITER = legacy;
  assert.equal((await h.request("a", "/v1/transactions:execute", envelope(read))).status, 200);
  assert.equal(legacy.keys.length, 0);
});

test("createErrorResponse builds the public error shape for wrapper-emitted errors", async () => {
  const response = createErrorResponse(429, "POLICYSQL_RATE_LIMITED", "Too many requests.", {
    requestId: "req_1", headers: { "retry-after": "60", "content-type": "text/html", "cache-control": "public" },
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), {
    error: { code: "POLICYSQL_RATE_LIMITED", message: "Too many requests.", path: null, requestId: "req_1" },
  });
  const generated = await createErrorResponse(503, "POLICYSQL_EXAMPLE_UNAVAILABLE", "Unavailable.", { path: "/statements/0" }).json();
  assert.equal(generated.error.path, "/statements/0");
  assert.match(generated.error.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(createErrorResponse(400, "POLICYSQL_INVALID_REQUEST", "Bad.").headers.has("retry-after"), false);
  for (const args of [
    [200, "POLICYSQL_RATE_LIMITED", "m"], [429.5, "POLICYSQL_RATE_LIMITED", "m"], [600, "POLICYSQL_RATE_LIMITED", "m"],
    [429, "RATE_LIMITED", "m"], [429, "POLICYSQL_rate", "m"], [429, "POLICYSQL_RATE_LIMITED", ""],
    [429, "POLICYSQL_RATE_LIMITED", "m", { requestId: "" }], [429, "POLICYSQL_RATE_LIMITED", "m", { path: 1 }],
  ]) assert.throws(() => createErrorResponse(...args), TypeError, JSON.stringify(args));
});

test("reference wrapper: an exhausted limit returns 429 before WASM, authentication, or the database", async (t) => {
  const h = await harness(t);
  const { app, binding, runtimeCalls } = lazyApp(h);
  const fetch = createWrapperFetch(app, binding);
  const exhausted = limiter(false);
  const env = { ...h.env, RATE_LIMITER: exhausted };
  for (const [path, body] of [
    ["/v1/transactions:execute", envelope(read)], ["/v1/transactions", { mode: "write" }],
    ["/v1/transactions/tx_any/statements", { sequence: 1, ...read }], ["/v1/catalog", undefined],
    ["/v1/capabilities", undefined], ["/healthz", undefined],
  ]) assertRateLimited(await call(fetch, env, h, path, body), String(RATE_LIMIT_PERIOD_SECONDS));
  // An unverifiable token is rejected by the limiter first, not by JWT verification.
  assertRateLimited(await call(fetch, env, h, "/v1/transactions:execute", envelope(read), { authorization: "Bearer invalid" }), "60");
  assert.equal(runtimeCalls(), 0, "WASM runtime never initialized");
  assert.deepEqual(h.counts(), { checks: 0, connects: 0 });
  assert.equal(h.events.length, 0);
  assert.deepEqual(new Set(exhausted.keys), new Set(["ip:192.0.2.10"]));
});

test("reference wrapper: requests under the limit pass through to the library", async (t) => {
  const h = await harness(t);
  const { app, binding, runtimeCalls } = lazyApp(h);
  const fetch = createWrapperFetch(app, binding);
  const allowed = limiter(true);
  const env = { ...h.env, RATE_LIMITER: allowed };
  const result = await call(fetch, env, h, "/v1/transactions:execute", envelope(read));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.results[0].rows, [{ id: "seed", name: "database_a" }]);
  assert.equal(result.headers.has("retry-after"), false);
  assert.ok(runtimeCalls() > 0);
  assert.ok(h.counts().connects > 0);
  // Library errors still come from the library, unchanged by the wrapper.
  const denied = await call(fetch, env, h, "/v1/transactions:execute", envelope(read), { authorization: "Bearer invalid" });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.has("retry-after"), false);
  assert.deepEqual(allowed.keys, ["ip:192.0.2.10", "ip:192.0.2.10"]);
  assert.equal(rateLimitKey(new Request("https://worker.test/")), "ip:unknown");
});

test("reference wrapper: a missing, failing, or malformed limiter fails closed", async (t) => {
  const h = await harness(t);
  const { app, binding, runtimeCalls } = lazyApp(h);
  const fetch = createWrapperFetch(app, binding);
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(JSON.parse(line)));
  for (const [RATE_LIMITER, event] of [
    [undefined, "rate_limiter_missing"], [{}, "rate_limiter_missing"],
    [{ async limit() { throw new Error("limiter down"); } }, "rate_limiter_failed"],
  ]) {
    const result = await call(fetch, { ...h.env, RATE_LIMITER }, h, "/v1/transactions:execute", envelope(read));
    assert.equal(result.status, 500);
    assert.deepEqual(result.body.error, { code: "POLICYSQL_INTERNAL", message: "The request could not be completed.", path: null, requestId: "req_rate" });
    assert.equal(logs.at(-1).event, event);
  }
  for (const outcome of [{}, { success: "true" }, { success: 1 }, null]) {
    const result = await call(fetch, { ...h.env, RATE_LIMITER: { async limit() { return outcome; } } }, h, "/v1/catalog");
    assertRateLimited(result, "60");
  }
  assert.equal(runtimeCalls(), 0);
  assert.deepEqual(h.counts(), { checks: 0, connects: 0 });
});

test("reference wrapper: commit-check callbacks bypass the limiter and use fetchCallback", async (t) => {
  const h = await harness(t);
  const { app, binding, runtimeCalls } = lazyApp(h);
  const fetch = createWrapperFetch(app, binding);
  const env = { ...h.env, RATE_LIMITER: { async limit() { throw new Error("must not be called"); } } };
  const result = await call(fetch, env, h, `/v1/commit-checks/cval_${"0".repeat(32)}/query`, { sequence: 1, ...read });
  assert.notEqual(result.status, 429);
  assert.notEqual(result.status, 500);
  assert.equal(runtimeCalls(), 0, "callbacks do not compute a new database binding");
});

const exampleFetch = (h, handler) => exampleRateLimit(handler, {
  limiter: (env) => env.RATE_LIMITER,
  key: (request, env) => `${env.APPLICATION_DATABASE_ID}:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
  retryAfterSeconds: 60,
  errorResponse: createErrorResponse,
});

test("database-routing example: an exhausted limit returns 429 before WASM or the database", async (t) => {
  const h = await harness(t);
  const { app, binding, runtimeCalls } = lazyApp(h);
  const fetch = exampleFetch(h, (request, env, context) => app.fetch(request, env, context, binding(env)));
  const exhausted = limiter(false);
  const env = { ...h.env, APPLICATION_DATABASE_ID: "db_a", RATE_LIMITER: exhausted };
  assertRateLimited(await call(fetch, env, h, "/v1/transactions:execute", envelope(read)), "60");
  assertRateLimited(await call(fetch, env, h, "/v1/transactions", { mode: "write" }), "60");
  assert.equal(runtimeCalls(), 0, "WASM runtime never initialized");
  assert.deepEqual(h.counts(), { checks: 0, connects: 0 });
  assert.equal(h.events.length, 0);
  assert.deepEqual(exhausted.keys, ["db_a:192.0.2.10", "db_a:192.0.2.10"]);
});

test("database-routing example: under the limit passes through; a missing binding fails closed", async (t) => {
  const h = await harness(t);
  const { app, binding, runtimeCalls } = lazyApp(h);
  const fetch = exampleFetch(h, (request, env, context) => app.fetch(request, env, context, binding(env)));
  const env = { ...h.env, APPLICATION_DATABASE_ID: "db_a", RATE_LIMITER: limiter(true) };
  const result = await call(fetch, env, h, "/v1/transactions:execute", envelope(read));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.results[0].rows, [{ id: "seed", name: "database_a" }]);
  assert.ok(runtimeCalls() > 0);
  assert.ok(h.counts().connects > 0);
  const calls = runtimeCalls();
  const connects = h.counts().connects;
  t.mock.method(console, "log", () => {});
  const missing = await call(fetch, { ...h.env, APPLICATION_DATABASE_ID: "db_a" }, h, "/v1/transactions:execute", envelope(read));
  assert.equal(missing.status, 500);
  assert.equal(missing.body.error.code, "POLICYSQL_INTERNAL");
  assert.equal(runtimeCalls(), calls);
  assert.equal(h.counts().connects, connects);
});
