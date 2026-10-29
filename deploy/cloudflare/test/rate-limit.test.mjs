// Request-rate limiting is a wrapper responsibility (ADR 0018, #26). The library has no
// limiter; the reference wrapper and the database-routing example limit every request,
// client requests and commit-check callbacks in separate buckets, before the library runs.
import { harness } from "./helpers/routing.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.ts";
import { createErrorResponse } from "../src/errors.ts";
import { createJwtSessionVerifier } from "../src/adapters/jwt.ts";
import { createJwtAuthentication } from "../../../examples/database-routing/auth.ts";
import { createWrapperFetch } from "../wrapper/fetch.ts";
import { CALLBACK_RATE_LIMIT as REFERENCE_CALLBACK, CLIENT_RATE_LIMIT as REFERENCE_CLIENT } from "../wrapper/rate-limit.ts";
import {
  CALLBACK_RATE_LIMIT as EXAMPLE_CALLBACK, CLIENT_RATE_LIMIT as EXAMPLE_CLIENT, createRateLimitedFetch,
} from "../../../examples/database-routing/rate-limit.ts";

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

test("the commit-check route is served only by fetchCallback, never by fetch", async (t) => {
  const h = await harness(t);
  const owners = countingOwners(h.env);
  const env = { ...h.env, TRANSACTION_OWNER: owners.TRANSACTION_OWNER };
  const id = "0".repeat(32);
  const post = (path) => new Request(`https://worker.test${path}`, {
    method: "POST", headers: { authorization: "Bearer cap", "content-type": "application/json" },
    body: JSON.stringify({ sequence: 1, ...read }),
  });
  for (const path of [`/v1/commit-checks/cval_${id}/query`, `/v1/commit%2Dchecks/cval_${id}/query`, `/v%31/commit-checks/cval_${id}/query`]) {
    const viaFetch = await h.app.fetch(post(path), env, h.ctx, { database: h.binding("a"), session: h.session("a") });
    assert.equal(viaFetch.status, 404, path);
    assert.equal((await viaFetch.json()).error.code, "POLICYSQL_NOT_FOUND");
  }
  for (const path of [`/v1/commit%2Dchecks/cval_${id}/query`, `/v%31/commit-checks/cval_${id}/query`]) {
    assert.equal((await h.app.fetchCallback(post(path), env, h.ctx)).status, 404, path);
  }
  assert.equal(owners.counts.lookups, 0);
  // The canonical path through fetchCallback still reaches the owner.
  await h.app.fetchCallback(post(`/v1/commit-checks/cval_${id}/query`), env, h.ctx);
  assert.ok(owners.counts.lookups > 0);
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

// Both reference wrappers share the same contract; only the client key differs.
const wrappers = [
  {
    name: "reference wrapper",
    create: (app, binding) => createWrapperFetch(app, binding),
    limits: { client: REFERENCE_CLIENT, callback: REFERENCE_CALLBACK },
    wrangler: "../wrangler.jsonc",
    clientKey: "ip:192.0.2.10",
  },
  {
    name: "database-routing example",
    create: (app, binding) => createRateLimitedFetch(app, binding, createErrorResponse, createJwtAuthentication(createJwtSessionVerifier)),
    limits: { client: EXAMPLE_CLIENT, callback: EXAMPLE_CALLBACK },
    wrangler: "../../../examples/database-routing/wrangler.jsonc",
    clientKey: "db_a:192.0.2.10",
  },
];

const VALIDATOR_IP = "198.51.100.7";
const callbackPath = (id = "0".repeat(32)) => `/v1/commit-checks/cval_${id}/query`;
const randomHex = () => crypto.randomUUID().replaceAll("-", "");

// Count every Durable Object lookup the library would make for a callback.
const countingOwners = (env) => {
  const counts = { lookups: 0 };
  const owners = env.TRANSACTION_OWNER;
  return {
    counts,
    TRANSACTION_OWNER: {
      idFromName(name) { counts.lookups++; return owners.idFromName(name); },
      get(id) { counts.lookups++; return owners.get(id); },
    },
  };
};

// JSONC: drop comments outside strings and trailing commas, then parse.
const readJsonc = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")
  .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match, string) => string ?? "")
  .replace(/,(\s*[}\]])/g, "$1"));

for (const wrapper of wrappers) {
  const setup = async (t, { client = limiter(true), callback = limiter(true) } = {}) => {
    const h = await harness(t);
    const lazy = lazyApp(h);
    const owners = countingOwners(h.env);
    const env = {
      ...h.env, APPLICATION_DATABASE_ID: "db_a", TRANSACTION_OWNER: owners.TRANSACTION_OWNER,
      RATE_LIMITER: client, CALLBACK_RATE_LIMITER: callback,
    };
    return { h, env, fetch: wrapper.create(lazy.app, lazy.binding), runtimeCalls: lazy.runtimeCalls, owners: owners.counts };
  };

  test(`${wrapper.name}: wrangler.jsonc declares both bindings with the periods the code sends`, () => {
    const declared = new Map(readJsonc(wrapper.wrangler).ratelimits.map((entry) => [entry.name, entry]));
    for (const limit of Object.values(wrapper.limits)) {
      const entry = declared.get(limit.binding);
      assert.ok(entry, `${limit.binding} is declared`);
      assert.equal(entry.simple.period, limit.periodSeconds, `${limit.binding} period equals Retry-After`);
    }
    assert.deepEqual([wrapper.limits.client.binding, wrapper.limits.callback.binding], ["RATE_LIMITER", "CALLBACK_RATE_LIMITER"]);
    assert.notEqual(declared.get("RATE_LIMITER").namespace_id, declared.get("CALLBACK_RATE_LIMITER").namespace_id);
  });

  test(`${wrapper.name}: an exhausted client limit returns 429 before WASM, authentication, or the database`, async (t) => {
    const exhausted = limiter(false);
    const { h, env, fetch, runtimeCalls, owners } = await setup(t, { client: exhausted });
    for (const [path, body] of [
      ["/v1/transactions:execute", envelope(read)], ["/v1/transactions", { mode: "write" }],
      ["/v1/transactions/tx_any/statements", { sequence: 1, ...read }], ["/v1/catalog", undefined],
      ["/v1/capabilities", undefined], ["/healthz", undefined],
    ]) assertRateLimited(await call(fetch, env, h, path, body), String(wrapper.limits.client.periodSeconds));
    // An unverifiable token is rejected by the limiter first, not by JWT verification.
    assertRateLimited(await call(fetch, env, h, "/v1/transactions:execute", envelope(read), { authorization: "Bearer invalid" }), "60");
    assert.equal(runtimeCalls(), 0, "WASM runtime never initialized");
    assert.deepEqual(h.counts(), { checks: 0, connects: 0 });
    assert.equal(h.events.length, 0);
    assert.equal(owners.lookups, 0);
    assert.deepEqual(new Set(exhausted.keys), new Set([wrapper.clientKey]));
  });

  test(`${wrapper.name}: requests under the limit pass through to the library`, async (t) => {
    const allowed = limiter(true);
    const { h, env, fetch, runtimeCalls } = await setup(t, { client: allowed });
    const result = await call(fetch, env, h, "/v1/transactions:execute", envelope(read));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.results[0].rows, [{ id: "seed", name: "database_a" }]);
    assert.equal(result.headers.has("retry-after"), false);
    assert.ok(runtimeCalls() > 0);
    assert.ok(h.counts().connects > 0);
    // An unverifiable token is rejected by the wrapper after the limiter, before the library.
    const denied = await call(fetch, env, h, "/v1/transactions:execute", envelope(read), { authorization: "Bearer invalid" });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.has("retry-after"), false);
    assert.deepEqual(allowed.keys, [wrapper.clientKey, wrapper.clientKey]);
    const anonymous = limiter(true);
    await fetch(new Request("https://worker.test/healthz"), { ...env, RATE_LIMITER: anonymous }, h.ctx);
    assert.match(anonymous.keys[0], /:unknown$/);
  });

  test(`${wrapper.name}: a missing, failing, or malformed limiter fails closed on both routes`, async (t) => {
    const { h, env, fetch, runtimeCalls, owners } = await setup(t);
    const logs = [];
    t.mock.method(console, "log", (line) => logs.push(JSON.parse(line)));
    for (const [binding, path, body] of [
      ["RATE_LIMITER", "/v1/transactions:execute", envelope(read)],
      ["CALLBACK_RATE_LIMITER", callbackPath(), { sequence: 1, ...read }],
    ]) {
      for (const [value, event] of [
        [undefined, "rate_limiter_missing"], [{}, "rate_limiter_missing"],
        [{ async limit() { throw new Error("limiter down"); } }, "rate_limiter_failed"],
      ]) {
        const result = await call(fetch, { ...env, [binding]: value }, h, path, body);
        assert.equal(result.status, 500);
        assert.deepEqual(result.body.error, { code: "POLICYSQL_INTERNAL", message: "The request could not be completed.", path: null, requestId: "req_rate" });
        assert.deepEqual([logs.at(-1).event, logs.at(-1).binding], [event, binding]);
      }
      for (const outcome of [{}, { success: "true" }, { success: 1 }, null]) {
        assertRateLimited(await call(fetch, { ...env, [binding]: { async limit() { return outcome; } } }, h, path, body), "60");
      }
    }
    assert.equal(runtimeCalls(), 0);
    assert.equal(owners.lookups, 0);
    assert.deepEqual(h.counts(), { checks: 0, connects: 0 });
  });

  test(`${wrapper.name}: callback spam is limited in its own bucket before any body parse or Durable Object work`, async (t) => {
    const callback = limiter(false);
    const client = limiter(true);
    const { h, env, fetch, runtimeCalls, owners } = await setup(t, { client, callback });
    for (let index = 0; index < 20; index++) {
      // Fresh capability IDs and an unparseable body: neither may reach the library.
      const response = await fetch(new Request(`https://worker.test${callbackPath(randomHex())}`, {
        method: "POST", headers: { "cf-connecting-ip": "203.0.113.9", "cf-ray": "req_rate", "content-type": "application/json" },
        body: "{".repeat(1024),
      }), env, h.ctx);
      assertRateLimited(
        { status: response.status, headers: response.headers, body: await response.json() },
        String(wrapper.limits.callback.periodSeconds),
      );
    }
    assert.equal(owners.lookups, 0, "no Durable Object lookup");
    assert.equal(runtimeCalls(), 0);
    assert.deepEqual(h.counts(), { checks: 0, connects: 0 });
    assert.equal(callback.keys.length, 20);
    assert.deepEqual(new Set(callback.keys), new Set(["callback:203.0.113.9"]));
    assert.equal(client.keys.length, 0, "callback traffic does not spend the client bucket");
    // The client bucket is independent: client requests still succeed.
    const result = await call(fetch, env, h, "/v1/transactions:execute", envelope(read));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(callback.keys.length, 20, "client traffic does not spend the callback bucket");
  });

  test(`${wrapper.name}: encoded callback paths are client requests and never reach the callback handler`, async (t) => {
    const client = limiter(true);
    const callback = limiter(true);
    const { h, env, fetch, owners } = await setup(t, { client, callback });
    const id = "0".repeat(32);
    // Encoded before the callback prefix: the wrapper sees a client path, so the client
    // bucket counts it, and app.fetch, which does not serve callbacks, returns 404.
    const clientVariants = [
      `/v1/commit%2Dchecks/cval_${id}/query`, `/v1/commit%2dchecks/cval_${id}/query`,
      `/v%31/commit-checks/cval_${id}/query`, `/%761/commit-checks/cval_${id}/query`,
      `/V1/Commit-Checks/cval_${id}/query`,
    ];
    // Encoded after the prefix: the callback bucket counts it, and fetchCallback's exact
    // route check rejects it before reading the body.
    const callbackVariants = [`/v1/commit-checks/%63val_${id}/query`, `/v1/commit-checks/cval_${id}/%71uery`];
    for (const path of [...clientVariants, ...callbackVariants]) {
      const result = await call(fetch, env, h, path, { sequence: 1, ...read });
      assert.equal(result.status, 404, `${path}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.error.code, "POLICYSQL_NOT_FOUND");
    }
    assert.equal(owners.lookups, 0, "no Durable Object lookup or callback body handling");
    assert.equal(client.keys.length, clientVariants.length);
    assert.deepEqual(new Set(client.keys), new Set([wrapper.clientKey]));
    assert.equal(callback.keys.length, callbackVariants.length);
  });

  test(`${wrapper.name}: a legitimate callback under its limit succeeds while the client bucket is exhausted`, async (t) => {
    const client = limiter(true);
    const callback = limiter(true);
    const { h, env, fetch, owners } = await setup(t, { client, callback });
    // The validator calls back through the wrapper from its own address.
    h.setValidator(async (hook) => {
      const response = await fetch(new Request(hook.query.url, {
        method: "POST",
        headers: { authorization: `Bearer ${hook.query.token}`, "content-type": "application/json", "cf-connecting-ip": VALIDATOR_IP },
        body: JSON.stringify({ sequence: 1, ...read }),
      }), env, h.ctx);
      h.hooksSeen.push({ hook, status: response.status, result: await response.json() });
      return response.ok;
    });
    const start = await call(fetch, env, h, "/v1/transactions", { mode: "write" });
    assert.equal(start.status, 201, JSON.stringify(start.body));
    const path = `/v1/transactions/${start.body.transactionId}`;
    const insert = { sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id: "via_wrapper", name: "x" } };
    assert.equal((await call(fetch, env, h, `${path}/statements`, { sequence: 1, ...insert })).status, 200);
    // Admit the commit request itself, then exhaust the client bucket: the validator
    // callback that the commit triggers must not depend on the client bucket.
    let admit = true;
    env.RATE_LIMITER = { async limit({ key }) { client.keys.push(key); const success = admit; admit = false; return { success }; } };
    const committed = await call(fetch, env, h, `${path}/commit`, { sequence: 2 });
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    await h.flush();
    assert.equal(h.hooksSeen.length, 1);
    assert.equal(h.hooksSeen[0].status, 200, JSON.stringify(h.hooksSeen[0].result));
    assert.ok(h.rows("a").some((row) => row.id === "via_wrapper"));
    assert.deepEqual(callback.keys, [`callback:${VALIDATOR_IP}`]);
    assert.ok(owners.lookups > 0);
    assert.equal(client.keys.some((key) => key.startsWith("callback:")), false);
    assertRateLimited(await call(fetch, env, h, "/v1/catalog"), "60");
  });
}
