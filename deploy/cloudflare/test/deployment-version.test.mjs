// The reference wrapper's release identification (#42) and the development commit-check
// validator the release smoke deploys. Both are deployment code, not library code.
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import {
  DEPLOYMENT_VERSION_HEADER, deploymentVersion, isOwnerVersionProbe, OWNER_VERSION_PATH, ownerVersionReply,
  ownerVersionRoute, withDeploymentVersion,
} from "../wrapper/deployment-version.ts";
import { createWrapperFetch } from "../wrapper/fetch.ts";
import validator from "../dev-validator/index.ts";

const VERSION = "0b5e3c2a-1111-4222-8333-944445555666";
const OTHER = "9f9f9f9f-1111-4222-8333-944445555666";
const allow = { limit: async () => ({ success: true }) };

const ownerNamespace = (version) => {
  const calls = [];
  return {
    calls,
    newUniqueId: () => ({ id: `unique-${calls.length}` }),
    get: (id) => ({
      fetch: async (url, init) => {
        calls.push({ id, url, method: init?.method });
        const request = new Request(url, init);
        assert.ok(isOwnerVersionProbe(request));
        return ownerVersionReply({ CF_VERSION_METADATA: { id: version } });
      },
    }),
  };
};

test("deploymentVersion reads only a well-formed binding id", () => {
  assert.equal(deploymentVersion({ CF_VERSION_METADATA: { id: VERSION } }), VERSION);
  for (const env of [undefined, {}, { CF_VERSION_METADATA: {} }, { CF_VERSION_METADATA: { id: 1 } }, { CF_VERSION_METADATA: { id: "x y" } }]) {
    assert.equal(deploymentVersion(env), "unknown");
  }
});

test("every wrapper response names the version that produced it, the library's untouched otherwise", async () => {
  const handler = withDeploymentVersion(async () => new Response("{\"ready\":true}", {
    status: 418, headers: { "content-type": "application/json", "x-kept": "1" },
  }));
  const response = await handler(new Request("https://worker.test/healthz"), { CF_VERSION_METADATA: { id: VERSION } }, undefined);
  assert.equal(response.status, 418);
  assert.equal(response.headers.get(DEPLOYMENT_VERSION_HEADER), VERSION);
  assert.equal(response.headers.get("x-kept"), "1");
  assert.equal(await response.text(), "{\"ready\":true}");
});

test("/healthz/owner is authenticated and reports the Worker's and a fresh owner's versions", async () => {
  const namespace = ownerNamespace(OTHER);
  const env = { RATE_LIMITER: allow, CF_VERSION_METADATA: { id: VERSION }, TRANSACTION_OWNER: namespace };
  const app = { fetch: async () => { throw new Error("the library must not see the wrapper route"); } };
  let authenticated = 0;
  const authenticate = async (request) => {
    authenticated += 1;
    if (request.headers.get("authorization") !== "Bearer good") {
      const { JwtAuthenticationError } = await import("../src/adapters/jwt.ts");
      throw new JwtAuthenticationError();
    }
    return { principal: "p", subject: "s", roles: ["member"], defaultRole: "member", access: ["execute"], session: {} };
  };
  const fetch = createWrapperFetch(app, () => ({}), authenticate, { [OWNER_VERSION_PATH]: (request, env) => ownerVersionRoute(request, env) });
  const denied = await fetch(new Request(`https://worker.test${OWNER_VERSION_PATH}`), env, undefined);
  assert.equal(denied.status, 401);
  assert.equal(namespace.calls.length, 0, "no Durable Object is reached before authentication");
  const response = await fetch(new Request(`https://worker.test${OWNER_VERSION_PATH}`, { headers: { authorization: "Bearer good" } }), env, undefined);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { worker: VERSION, owner: OTHER });
  assert.equal(namespace.calls.length, 1);
  assert.equal(authenticated, 2);
  const post = await fetch(new Request(`https://worker.test${OWNER_VERSION_PATH}`, { method: "POST", headers: { authorization: "Bearer good" } }), env, undefined);
  assert.equal(post.status, 404);
});

test("an owner probe message is only the exact internal GET", () => {
  assert.equal(isOwnerVersionProbe(new Request("https://owner/deployment-version")), true);
  assert.equal(isOwnerVersionProbe(new Request("https://owner/deployment-version", { method: "POST" })), false);
  assert.equal(isOwnerVersionProbe(new Request("https://owner/begin")), false);
  assert.equal(isOwnerVersionProbe(new Request("https://owner/deployment-version?x=1")), false);
});

// The development validator (dev-validator/index.ts).
const SECRET = "dev-validator-test-secret-0123456789";
const ORIGIN = "https://policysql.test";
const validatorEnv = { HOOK_SECRET: SECRET, POLICYSQL_ORIGIN: ORIGIN, CF_VERSION_METADATA: { id: VERSION } };
const callbackUrl = `${ORIGIN}/v1/commit-checks/cval_${"a".repeat(32)}/query`;

const hook = (payload, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000), version = "1" } = {}) => {
  const body = JSON.stringify(payload);
  const signature = `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  return new Request("https://validator.test/check", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "policysql-hook-version": version,
      "policysql-hook-timestamp": String(timestamp),
      "policysql-hook-signature": signature,
    },
    body,
  });
};

const payload = (url = callbackUrl) => ({
  version: "1", validationId: `cval_${"a".repeat(32)}`, check: "smoke_check", requestId: "r",
  policyVersion: "p", schemaVersion: "s", role: "member", session: {}, statements: [],
  query: { token: "T".repeat(43), url, expiresAt: new Date().toISOString() },
});

const withCallback = async (rows, run, status = 200) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(status === 200 ? { sequence: 1, rows, rowCount: rows.length } : { error: { code: "POLICYSQL_FORBIDDEN_COLUMN" } }), { status });
  };
  try { return { result: await run(), calls }; } finally { globalThis.fetch = original; }
};

test("the dev validator decides from the newest probe row its callback query returns", async () => {
  for (const [rows, expected] of [
    [[{ id: "ccp_2", verdict: "allow" }], { version: "1", allowed: true }],
    [[{ id: "ccp_2", verdict: "deny" }], { version: "1", allowed: false, error: { code: "SMOKE_DENIED" } }],
    [[], { version: "1", allowed: false, error: { code: "NO_PROBE" } }],
  ]) {
    const { result, calls } = await withCallback(rows, () => validator.fetch(hook(payload()), validatorEnv));
    assert.equal(result.status, 200);
    assert.equal(result.headers.get(DEPLOYMENT_VERSION_HEADER), VERSION);
    assert.deepEqual(await result.json(), expected);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, callbackUrl);
    assert.equal(calls[0].init.redirect, "manual", "the callback goes through fetchNoFollow");
    assert.equal(calls[0].init.headers.authorization, `Bearer ${"T".repeat(43)}`);
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      sequence: 1, sql: "SELECT id, verdict FROM smoke_checks ORDER BY id DESC LIMIT :limit", params: { limit: 1 },
    });
  }
  const { result } = await withCallback([], () => validator.fetch(hook(payload()), validatorEnv), 403);
  assert.deepEqual(await result.json(), { version: "1", allowed: false, error: { code: "CALLBACK_FAILED" } });
});

test("the dev validator rejects unsigned, stale or foreign hooks before any callback", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const [request, status] of [
    [hook(payload(), { secret: "another-secret-0123456789abcdef" }), 401],
    [hook(payload(), { timestamp: now - 3600 }), 401],
    [hook(payload(), { version: "2" }), 400],
  ]) {
    const { result, calls } = await withCallback([], () => validator.fetch(request, validatorEnv));
    assert.equal(result.status, status);
    assert.equal(calls.length, 0);
  }
  for (const url of ["https://attacker.test/v1/commit-checks/cval_" + "a".repeat(32) + "/query", `${ORIGIN}/v1/transactions:execute`]) {
    const { result, calls } = await withCallback([], () => validator.fetch(hook(payload(url)), validatorEnv));
    assert.deepEqual(await result.json(), { version: "1", allowed: false, error: { code: "CALLBACK_URL" } });
    assert.equal(calls.length, 0, "the capability is never sent to another origin or path");
  }
  const misconfigured = await validator.fetch(hook(payload()), { ...validatorEnv, HOOK_SECRET: "short" });
  assert.equal(misconfigured.status, 500);
});

// The release smoke's readiness wait (scripts/release-readiness.mjs).
test("the readiness wait needs consecutive rounds of the new Worker, owner and validator versions", async () => {
  const { versionTracker, waitForRelease } = await import("../scripts/release-readiness.mjs");
  // Answers in order: old Worker, new Worker with an old owner, then only new versions,
  // except one old-validator round that must reset the count.
  const owners = [[OTHER, OTHER], [VERSION, OTHER], [VERSION, VERSION], [VERSION, VERSION], [VERSION, VERSION], [VERSION, VERSION], [VERSION, VERSION], [VERSION, VERSION]];
  const validators = [VERSION, OTHER, VERSION, VERSION, VERSION];
  const log = [];
  const fetchImpl = async (url) => {
    const { pathname } = new URL(url);
    log.push(pathname);
    if (url.startsWith("https://validator.test")) {
      return new Response("{}", { headers: { [DEPLOYMENT_VERSION_HEADER]: validators.shift() ?? VERSION } });
    }
    if (pathname === "/healthz/owner") {
      const [worker, owner] = owners.shift() ?? [VERSION, VERSION];
      return new Response(JSON.stringify({ worker, owner }), { headers: { [DEPLOYMENT_VERSION_HEADER]: worker } });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { [DEPLOYMENT_VERSION_HEADER]: VERSION } });
  };
  let clock = 0;
  const result = await waitForRelease({
    baseUrl: "https://worker.test", token: "t", version: VERSION, validator: { url: "https://validator.test", version: VERSION },
    capabilitiesMatch: (body) => body?.ok === true, required: 3, fetchImpl, now: () => clock, wait: async (ms) => { clock += ms; },
  });
  // Rounds 1-2 stale owners, 3 fresh, 4 stale validator, 5-7 fresh.
  assert.deepEqual({ rounds: result.rounds, staleAnswers: result.staleAnswers }, { rounds: 7, staleAnswers: 3 });
  assert.equal(log.at(-1), "/v1/capabilities");
  await assert.rejects(waitForRelease({
    baseUrl: "https://worker.test", token: "t", version: VERSION, capabilitiesMatch: () => true, required: 2, timeoutMs: 5_000,
    fetchImpl: async () => new Response("{}", { status: 404, headers: { [DEPLOYMENT_VERSION_HEADER]: OTHER } }),
    now: () => clock, wait: async (ms) => { clock += ms; },
  }), /did not answer 2 consecutive rounds/);

  const tracker = versionTracker(VERSION, async (url) => new Response("{}", {
    status: url.endsWith("limited") ? 429 : 200,
    headers: url.endsWith("old") ? { [DEPLOYMENT_VERSION_HEADER]: OTHER } : { [DEPLOYMENT_VERSION_HEADER]: VERSION },
  }));
  for (const path of ["a", "old", "limited", "b"]) await tracker.call(`https://worker.test/${path}`);
  assert.equal(tracker.responses, 4);
  assert.deepEqual(tracker.skewed, [{ version: OTHER, count: 1 }]);
  assert.equal(tracker.rateLimited, 1);
});
