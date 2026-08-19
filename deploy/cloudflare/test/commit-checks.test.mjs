import assert from "node:assert/strict";
import test from "node:test";
import { runCommitChecks, verifyCapabilityToken } from "../src/commit-checks.ts";

const compiled = {
  policyVersion: "policy_1",
  schemaVersion: "schema_1",
  statements: [{ operation: "update", resource: "projects" }],
  commitChecks: [{
    id: "project_consistency",
    triggeredBy: ["projects"],
    role: "admin",
    urlEnv: "VALIDATOR_URL",
    timeoutMs: 1000,
    hmacSecretEnv: "VALIDATOR_SECRET",
  }],
};

const env = {
  POLICYSQL_PUBLIC_BASE_URL: "https://gateway.example.test",
  VALIDATOR_URL: "https://validator.example.test/check",
  VALIDATOR_SECRET: "0123456789abcdef0123456789abcdef",
};

const auth = {
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
    env,
    requestId: "req_1",
    validationId: `cval_${"a".repeat(32)}`,
    activate: async (value) => { session = value; },
    deactivate: async () => { deactivated = true; },
    fetchImpl: async (url, init) => {
      assert.equal(url.toString(), env.VALIDATOR_URL);
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
    env,
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
        env,
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
