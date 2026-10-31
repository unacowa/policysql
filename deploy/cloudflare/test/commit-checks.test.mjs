// The executor side of commit checks (ADR 0007, ADR 0021, ADR 0024): the owner runs core's
// `callValidator` effect through the signed hook adapter with the endpoint and secret looked up
// by check id. Which checks run, the capability, the callback queries, and the verdict are
// core's (`crates/policysql-transaction/tests/commit_checks.rs`, and the scenarios of
// step-differential.test.mjs against the recorded TypeScript reference). Before ADR 0024 pull
// request 9 these cases tested `src/commit-checks.ts`, the TypeScript decision path.
import assert from "node:assert/strict";
import test from "node:test";
import { callCommitCheckHook } from "../src/adapters/commit-check-hook.ts";
import { TransactionOwnerCore } from "../src/transaction-owner.ts";
import { validateConfig } from "../src/engine-config.ts";
import { redirectResponses } from "./helpers/redirects.mjs";

const VALIDATOR_URL = "https://validator.example.test/check";
const VALIDATOR_SECRET = "0123456789abcdef0123456789abcdef";
const VALIDATION = `cval_${"a".repeat(32)}`;
const TOKEN = "A".repeat(43);

const hmacHex = async (secret, text) => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

// The hook body without `query`, in its wire key order, as core's `callValidator` carries it.
const payload = (check) => ({
  version: "1", validationId: VALIDATION, check, requestId: "req_1", policyVersion: "policy_1", schemaVersion: "schema_1",
  role: "admin", session: { tenant_id: "tenant_1" }, statements: [{ index: 0, type: "update", resource: "projects" }],
});
const effect = (check, id = 7) => ({
  type: "callValidator", id, check, payload: payload(check),
  capability: { token: TOKEN, expiresAtMs: Date.UTC(2026, 0, 1) }, timeoutMs: 1_000,
});
const hookCall = (fetchImpl) => ({
  url: new URL(VALIDATOR_URL), hmacSecret: VALIDATOR_SECRET, publicBaseUrl: new URL("https://gateway.example.test"),
  validationId: VALIDATION, payload: payload("project_consistency"),
  capability: { token: TOKEN, expiresAtMs: Date.UTC(2026, 0, 1) }, timeoutMs: 1_000, fetchImpl,
});

/** A production owner whose only use here is running `callValidator` effects. */
const owner = (config, fetchImpl) => new TransactionOwnerCore({
  store: { async get() { return undefined; }, async put() { assert.fail("nothing is stored"); } },
  timer: { async schedule() { assert.fail("no timer"); } },
  background: { run() {} },
  name: `tx_${"a".repeat(32)}`,
}, { getRuntime: () => assert.fail("no step"), database: { streamedReadCap: true, check() {}, connect() {} }, config, fetchImpl });

test("signs the hook body with the check's secret, adds the callback capability, and reads the decision", async () => {
  const seen = [];
  const reply = await callCommitCheckHook(hookCall(async (url, init) => {
    seen.push({ url: String(url), init });
    return Response.json({ version: "1", allowed: true });
  }));
  assert.deepEqual(reply, { ok: true, decision: { version: "1", allowed: true } });
  const [{ url, init }] = seen;
  assert.equal(url, VALIDATOR_URL);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");
  const timestamp = init.headers["policysql-hook-timestamp"];
  assert.match(timestamp, /^\d+$/u);
  assert.equal(init.headers["policysql-hook-version"], "1");
  assert.equal(init.headers["policysql-hook-signature"], `v1=${await hmacHex(VALIDATOR_SECRET, `${timestamp}.${init.body}`)}`);
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body), [...Object.keys(payload("project_consistency")), "query"], "the wire key order");
  assert.deepEqual(body.query, {
    token: TOKEN, url: `https://gateway.example.test/v1/commit-checks/${VALIDATION}/query`, expiresAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(init.body.includes(VALIDATOR_SECRET), false, "the secret never enters the body");
  assert.equal(init.body.includes("database"), false);
  // A non-2xx reply or a body that is not JSON is reported as such; core judges it.
  assert.deepEqual(await callCommitCheckHook(hookCall(async () => new Response("allowed", { status: 503 }))), { ok: false, decision: null });
});

// Regression (#36): workerd throws on `redirect: "error"`, so every commit check on the real
// Worker was rejected. The hook call asks for "manual" and treats a redirect as no answer,
// without following it or reading its body.
test("a redirect from the validator is no answer: not followed, not read, released", async () => {
  for (const { label, response, state } of redirectResponses()) {
    let calls = 0;
    await assert.rejects(callCommitCheckHook(hookCall(async (_url, init) => {
      calls += 1;
      assert.equal(init.redirect, "manual");
      return response;
    })), undefined, label);
    assert.equal(calls, 1, `${label}: the redirect is not followed`);
    assert.equal(state.read, false, `${label}: the redirect body is not read`);
    assert.equal(state.cancelled, true, `${label}: the redirect body is released`);
  }
  // On an owner, no answer is a failed validator call, which core rejects before COMMIT.
  for (const { label, response } of redirectResponses()) {
    const configured = validateConfig({
      environment: "test", publicBaseUrl: "https://gateway.example.test",
      commitChecks: { project_consistency: { url: VALIDATOR_URL, hmacSecret: VALIDATOR_SECRET } },
    });
    const outcome = await owner(configured, async () => response).callValidator(effect("project_consistency"));
    assert.deepEqual(outcome, { type: "validatorFailed", id: 7, class: "unavailable" }, label);
  }
});

// ADR 0021: endpoints are resolved by check id from the wrapper's configuration; the effect
// carries no URL or secret, and nothing else selects the validator.
test("the owner resolves each check's URL and secret by check id from the configuration", async () => {
  const endpoints = {
    alpha_check: { url: "https://alpha.example.test/hook", hmacSecret: "alpha-secret-0123456789" },
    beta_check: { url: "https://beta.example.test/hook", hmacSecret: "beta-secret-0123456789ab" },
  };
  const configured = validateConfig({ environment: "test", publicBaseUrl: "https://gateway.example.test", commitChecks: endpoints });
  const seen = [];
  const run = owner(configured, async (url, init) => {
    const body = JSON.parse(init.body);
    const expected = endpoints[body.check];
    assert.equal(String(url), expected.url, body.check);
    const timestamp = init.headers["policysql-hook-timestamp"];
    assert.equal(init.headers["policysql-hook-signature"], `v1=${await hmacHex(expected.hmacSecret, `${timestamp}.${init.body}`)}`);
    assert.equal(init.body.includes(expected.hmacSecret), false);
    seen.push(body.check);
    return Response.json({ version: "1", allowed: body.check === "alpha_check" });
  });
  assert.deepEqual(await run.callValidator(effect("alpha_check", 1)),
    { type: "validatorReplied", id: 1, ok: true, decision: { version: "1", allowed: true } });
  assert.deepEqual(await run.callValidator(effect("beta_check", 2)),
    { type: "validatorReplied", id: 2, ok: true, decision: { version: "1", allowed: false } });
  assert.deepEqual(seen, ["alpha_check", "beta_check"]);
});

// A check core asks for whose endpoint is not usable at the exit (no endpoint for its id, or
// no commit checks configured at all) is a rejected call, and no validator is contacted. Core checks the configured ids before
// any capability (`HostFacts.configuredChecks`), so this is the executor's second line.
test("a check without a usable endpoint is rejected at the exit, and no validator is contacted", async (t) => {
  t.mock.method(console, "log", () => {});
  const partial = validateConfig({
    environment: "test", publicBaseUrl: "https://gateway.example.test",
    commitChecks: { alpha_check: { url: VALIDATOR_URL, hmacSecret: VALIDATOR_SECRET } },
  });
  for (const [configured, check] of [[partial, "unconfigured"], [validateConfig({ environment: "test" }), "alpha_check"]]) {
    let calls = 0;
    const outcome = await owner(configured, async () => { calls += 1; return new Response("{}"); }).callValidator(effect(check));
    assert.deepEqual(outcome, { type: "validatorFailed", id: 7, class: "rejected" });
    assert.equal(calls, 0, "no validator, not even a configured one, is contacted");
  }
});

test("a validator call that times out or fails in transport is classified for core", async () => {
  const configured = validateConfig({
    environment: "test", publicBaseUrl: "https://gateway.example.test",
    commitChecks: { project_consistency: { url: VALIDATOR_URL, hmacSecret: VALIDATOR_SECRET } },
  });
  for (const [error, expected] of [
    [new DOMException("The operation timed out.", "TimeoutError"), "timeout"],
    [new DOMException("aborted", "AbortError"), "timeout"],
    [new TypeError("fetch failed"), "unavailable"],
  ]) {
    const outcome = await owner(configured, async () => { throw error; }).callValidator(effect("project_consistency"));
    assert.deepEqual(outcome, { type: "validatorFailed", id: 7, class: expected }, error.name);
  }
});
