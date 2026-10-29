import assert from "node:assert/strict";
import test from "node:test";
import { runCommitChecks, verifyCapabilityToken } from "../src/commit-checks.ts";
import { validateConfig } from "../src/engine-config.ts";
import { redirectResponses } from "./helpers/redirects.mjs";

const compiled = {
  policyVersion: "policy_1",
  schemaVersion: "schema_1",
  statements: [{ operation: "update", resource: "projects" }],
  commitChecks: [{
    id: "project_consistency",
    triggeredBy: ["projects"],
    role: "admin",
    timeoutMs: 1000,
  }],
};

const VALIDATOR_URL = "https://validator.example.test/check";
const VALIDATOR_SECRET = "0123456789abcdef0123456789abcdef";
// The wrapper resolves the endpoint per policy check id (ADR 0021).
const config = validateConfig({
  environment: "test",
  publicBaseUrl: "https://gateway.example.test",
  commitChecks: { project_consistency: { url: VALIDATOR_URL, hmacSecret: VALIDATOR_SECRET } },
});

const auth = {
  principal: "test:u1",
  subject: "u1",
  role: "member",
  roles: ["member"],
  access: ["execute"],
  session: { tenant_id: "tenant_1" },
};

test("signs a triggered hook, grants one opaque query capability, and accepts allow", async () => {
  let session;
  let deactivated = false;
  const result = await runCommitChecks({
    compiled,
    results: [{ affectedRows: 1 }],
    auth,
    config,
    requestId: "req_1",
    validationId: `cval_${"a".repeat(32)}`,
    activate: async (value) => { session = value; },
    deactivate: async () => { deactivated = true; },
    fetchImpl: async (url, init) => {
      assert.equal(url.toString(), VALIDATOR_URL);
      assert.match(init.headers["policysql-hook-signature"], /^v1=[a-f0-9]{64}$/u);
      const body = JSON.parse(init.body);
      assert.equal(body.role, "admin");
      assert.equal(body.statements[0].resource, "projects");
      assert.equal(body.query.url, `https://gateway.example.test/v1/commit-checks/${body.validationId}/query`);
      assert.equal(await verifyCapabilityToken(`Bearer ${body.query.token}`, session), true);
      assert.equal(JSON.stringify(body).includes("database"), false);
      return new Response(JSON.stringify({ version: "1", allowed: true }), { status: 200 });
    },
  });
  assert.equal(result, "passed");
  assert.equal(session.auth.role, "admin");
  assert.equal(deactivated, true);
});

test("does not call a hook for a zero-row mutation and rejects deny or malformed decisions", async () => {
  let calls = 0;
  const notTriggered = await runCommitChecks({
    compiled,
    results: [{ affectedRows: 0 }],
    auth,
    config,
    requestId: "req_0",
    validationId: `cval_${"b".repeat(32)}`,
    activate: async () => {},
    deactivate: async () => {},
    fetchImpl: async () => { calls += 1; },
  });
  assert.equal(notTriggered, "not_triggered");
  assert.equal(calls, 0);

  for (const decision of [
    { version: "1", allowed: false, error: { code: "NO" } },
    { version: "2", allowed: true },
  ]) {
    await assert.rejects(
      runCommitChecks({
        compiled,
        results: [{ affectedRows: 1 }],
        auth,
        config,
        requestId: "req_deny",
        validationId: `cval_${"c".repeat(32)}`,
        activate: async () => {},
        deactivate: async () => {},
        fetchImpl: async () => new Response(JSON.stringify(decision), { status: 200 }),
      }),
      (error) => error.code === "POLICYSQL_COMMIT_CHECK_REJECTED",
    );
  }
});

// Regression (#36): workerd throws on `redirect: "error"`, so every commit check on
// the real Worker was rejected. The hook call now asks for "manual" and treats a
// redirect as a rejection, without following it or reading its body.
test("calls the validator with manual redirects and rejects redirect responses unread", async () => {
  const passed = await runCommitChecks({
    compiled,
    results: [{ affectedRows: 1 }],
    auth,
    config,
    requestId: "req_redirect_ok",
    validationId: `cval_${"d".repeat(32)}`,
    activate: async () => {},
    deactivate: async () => {},
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, "manual");
      return new Response(JSON.stringify({ version: "1", allowed: true }), { status: 200 });
    },
  });
  assert.equal(passed, "passed");

  for (const { label, response, state } of redirectResponses()) {
    let calls = 0;
    let deactivated = false;
    await assert.rejects(
      runCommitChecks({
        compiled,
        results: [{ affectedRows: 1 }],
        auth,
        config,
        requestId: "req_redirect",
        validationId: `cval_${"e".repeat(32)}`,
        activate: async () => {},
        deactivate: async () => { deactivated = true; },
        fetchImpl: async (_url, init) => {
          calls += 1;
          assert.equal(init.redirect, "manual");
          return response;
        },
      }),
      (error) => error.status === 409 && error.code === "POLICYSQL_COMMIT_CHECK_REJECTED",
      label,
    );
    assert.equal(calls, 1, `${label}: the redirect is not followed`);
    assert.equal(state.read, false, `${label}: the redirect body is not read`);
    assert.equal(state.cancelled, true, `${label}: the redirect body is released`);
    assert.equal(deactivated, true, `${label}: the query capability is revoked`);
  }
});

const hmacHex = async (secret, text) => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

// ADR 0021: endpoints are resolved by check id from the wrapper's configuration; the
// compiled check carries no env name, and nothing else selects the validator.
test("resolves each triggered check's URL and secret by check id from the configuration", async () => {
  const two = {
    ...compiled,
    commitChecks: [
      { id: "beta_check", triggeredBy: ["projects"], timeoutMs: 1000 },
      { id: "alpha_check", triggeredBy: ["projects"], timeoutMs: 1000 },
    ],
  };
  const endpoints = {
    alpha_check: { url: "https://alpha.example.test/hook", hmacSecret: "alpha-secret-0123456789" },
    beta_check: { url: "https://beta.example.test/hook", hmacSecret: "beta-secret-0123456789ab" },
  };
  const configured = validateConfig({ environment: "test", publicBaseUrl: "https://gateway.example.test", commitChecks: endpoints });
  const seen = [];
  const result = await runCommitChecks({
    compiled: two,
    results: [{ affectedRows: 1 }],
    auth,
    config: configured,
    requestId: "req_ids",
    validationId: `cval_${"f".repeat(32)}`,
    activate: async () => {},
    deactivate: async () => {},
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      const expected = endpoints[body.check];
      assert.equal(url.toString(), expected.url, body.check);
      const timestamp = init.headers["policysql-hook-timestamp"];
      assert.equal(init.headers["policysql-hook-signature"], `v1=${await hmacHex(expected.hmacSecret, `${timestamp}.${init.body}`)}`);
      assert.equal(init.body.includes(expected.hmacSecret), false);
      seen.push(body.check);
      return new Response(JSON.stringify({ version: "1", allowed: true }), { status: 200 });
    },
  });
  assert.equal(result, "passed");
  // Checks run in id order, each against its own endpoint.
  assert.deepEqual(seen, ["alpha_check", "beta_check"]);
});

test("a triggered check without a configured endpoint rejects before any capability or hook", async (t) => {
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(line));
  const two = {
    ...compiled,
    commitChecks: [
      { id: "alpha_check", triggeredBy: ["projects"], timeoutMs: 1000 },
      { id: "unconfigured", triggeredBy: ["projects"], timeoutMs: 1000 },
    ],
  };
  const partial = validateConfig({
    environment: "test",
    publicBaseUrl: "https://gateway.example.test",
    commitChecks: { alpha_check: { url: VALIDATOR_URL, hmacSecret: VALIDATOR_SECRET } },
  });
  for (const configured of [partial, config, validateConfig({ environment: "test" })]) {
    let activated = 0;
    let calls = 0;
    await assert.rejects(
      runCommitChecks({
        compiled: two,
        results: [{ affectedRows: 1 }],
        auth,
        config: configured,
        requestId: "req_missing",
        validationId: `cval_${"0".repeat(32)}`,
        activate: async () => { activated += 1; },
        deactivate: async () => {},
        fetchImpl: async () => { calls += 1; return new Response("{}"); },
      }),
      (error) => error.status === 409 && error.code === "POLICYSQL_COMMIT_CHECK_REJECTED",
    );
    assert.equal(activated, 0, "no capability is granted");
    assert.equal(calls, 0, "no validator, not even a configured one, is contacted");
  }
  assert.ok(logs.some((line) => JSON.parse(line).event === "commit_check_unconfigured"));
  assert.equal(logs.join("\n").includes(VALIDATOR_SECRET), false);
});
