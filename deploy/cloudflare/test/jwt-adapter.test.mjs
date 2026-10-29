// JWT is an identity adapter (ADR 0019, ADR 0020): the wrapper verifies the credential
// and passes a trusted session to the library. These tests cover the adapter itself and
// the reference wrapper and database-routing example that use it.
import { harness } from "./helpers/routing.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createErrorResponse } from "../src/http/responses.ts";
import { createJwtSessionVerifier, JwtAuthenticationError } from "../src/adapters/jwt.ts";
import { createWrapperFetch } from "../wrapper/fetch.ts";
import { createRateLimitedFetch } from "../../../examples/database-routing/rate-limit.ts";
import { createJwtAuthentication } from "../../../examples/database-routing/auth.ts";

const issuer = "https://issuer.test";
const audience = "policysql-test";
const claims = { roles: ["member"], default_role: "member", access: ["catalog", "explain", "debug"], session: { tenant_id: "tenant_a" } };

const keyPair = async (kid = "test-key") => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid, alg: "ES256" });
  return { privateKey, jwks: { keys: [jwk] }, kid };
};

const sign = (key, { policysql = claims, iss = issuer, aud = audience, exp = "5m", sub = "user_1", kid = key.kid } = {}) =>
  new SignJWT(policysql === null ? {} : { policysql })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(iss).setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime(exp)
    .sign(key.privateKey);

const bearer = (token) => new Request("https://worker.test/v1/catalog", { headers: { authorization: `Bearer ${token}` } });

test("adapter verifies the signature and translates the JWT profile into a trusted session", async () => {
  const key = await keyPair();
  for (const jwks of [key.jwks, JSON.stringify(key.jwks)]) {
    const verify = createJwtSessionVerifier({ jwks, issuer, audience });
    assert.deepEqual(await verify(bearer(await sign(key))), {
      principal: '["https://issuer.test","user_1"]',
      subject: "user_1",
      roles: ["member"],
      defaultRole: "member",
      access: ["catalog", "explain", "debug"],
      session: { tenant_id: "tenant_a" },
    });
  }
  const verify = createJwtSessionVerifier({ jwks: key.jwks, issuer, audience });
  const { session } = await verify(bearer(await sign(key, { policysql: { roles: ["member"], default_role: "member", access: ["execute"] } })));
  assert.deepEqual(session, {}, "an absent session claim is an empty session");
});

test("principal is unambiguous even when the issuer or subject contains ':'", async () => {
  const key = await keyPair();
  // A plain `iss:sub` join maps both pairs to "https://a.test:x:y".
  const pairs = [["https://a.test", "x:y"], ["https://a.test:x", "y"]];
  const principals = [];
  for (const [iss, sub] of pairs) {
    const verify = createJwtSessionVerifier({ jwks: key.jwks, issuer: iss, audience });
    const session = await verify(bearer(await sign(key, { iss, sub })));
    assert.equal(session.subject, sub);
    assert.deepEqual(JSON.parse(session.principal), [iss, sub], "principal decodes back to its parts");
    principals.push(session.principal);
  }
  assert.equal(`${pairs[0][0]}:${pairs[0][1]}`, `${pairs[1][0]}:${pairs[1][1]}`, "the naive join collides");
  assert.notEqual(principals[0], principals[1]);
});

test("adapter rejects every unverifiable credential with JwtAuthenticationError", async () => {
  const key = await keyPair();
  const other = await keyPair();
  const verify = createJwtSessionVerifier({ jwks: key.jwks, issuer, audience });
  const valid = await sign(key);
  const requests = [
    new Request("https://worker.test/v1/catalog"),
    new Request("https://worker.test/v1/catalog", { headers: { authorization: valid } }),
    new Request("https://worker.test/v1/catalog", { headers: { authorization: "Bearer " } }),
    new Request("https://worker.test/v1/catalog", { headers: { authorization: `Bearer ${valid}, Bearer ${valid}` } }),
    bearer("invalid"),
    bearer(await sign(other, { kid: key.kid })),
    bearer(await sign(key, { iss: "https://other-issuer.test" })),
    bearer(await sign(key, { aud: "another-app" })),
    bearer(await sign(key, { exp: "-1h" })),
    bearer(await sign(key, { policysql: null })),
    bearer(await sign(key, { policysql: ["member"] })),
    bearer(`${valid.split(".").slice(0, 2).join(".")}.`),
  ];
  for (const [index, request] of requests.entries()) {
    await assert.rejects(verify(request), (error) => {
      assert.ok(error instanceof JwtAuthenticationError, String(index));
      assert.equal(error.status, 401);
      assert.equal(error.code, "POLICYSQL_UNAUTHENTICATED");
      assert.equal(error.message, "Authentication is required.");
      return true;
    }, String(index));
  }
});

test("adapter configuration is validated at construction", async () => {
  const key = await keyPair();
  for (const options of [
    undefined,
    { jwks: key.jwks, audience },
    { jwks: key.jwks, issuer, audience: "" },
    { issuer, audience },
    { jwks: key.jwks, jwksUrl: "https://issuer.test/jwks", issuer, audience },
    { jwks: "{", issuer, audience },
    { jwks: { keys: [] }, issuer, audience },
    // Remote keys must be fetched over TLS; no plaintext exception, even for localhost.
    { jwksUrl: "http://issuer.test/jwks", issuer, audience },
    { jwksUrl: "http://localhost:8787/jwks", issuer, audience },
    { jwksUrl: "file:///etc/jwks.json", issuer, audience },
    { jwksUrl: "not a url", issuer, audience },
  ]) {
    assert.throws(() => createJwtSessionVerifier(options), TypeError, JSON.stringify(options));
  }
  assert.equal(typeof createJwtSessionVerifier({ jwksUrl: "https://issuer.test/jwks", issuer, audience }), "function");
});

const limiter = () => ({ async limit() { return { success: true }; } });

// The reference wrapper and the database-routing example share the authentication
// contract; the example receives its library functions by injection.
const wrappers = [
  { name: "reference wrapper", create: (app, binding) => createWrapperFetch(app, binding) },
  {
    name: "database-routing example",
    create: (app, binding) => createRateLimitedFetch(app, binding, createErrorResponse, createJwtAuthentication(createJwtSessionVerifier)),
  },
];

for (const wrapper of wrappers) {
  const setup = async (t) => {
    const h = await harness(t, { hooks: false });
    let runtimeCalls = 0;
    const getRuntime = () => { runtimeCalls++; return h.runtime; };
    const app = h.workerApp(getRuntime);
    const fetch = wrapper.create(app, () => { getRuntime(); return h.binding("a"); });
    const env = { ...h.env, APPLICATION_DATABASE_ID: "db_a", RATE_LIMITER: limiter(), CALLBACK_RATE_LIMITER: limiter() };
    const call = async (path, body, token, headers = {}) => {
      const response = await fetch(new Request(`https://worker.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          "content-type": "application/json", "cf-connecting-ip": "192.0.2.10", "cf-ray": "req_auth", ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), env, h.ctx);
      return { status: response.status, body: await response.json() };
    };
    return { h, env, call, runtimeCalls: () => runtimeCalls };
  };
  const update = (name) => ({ sql: "UPDATE projects SET name = :name WHERE id = :id RETURNING id, name", params: { id: "seed", name } });

  test(`${wrapper.name}: a valid token reaches the library; an unverifiable one is 401 before it`, async (t) => {
    const { h, call, runtimeCalls } = await setup(t);
    const ok = await call("/v1/transactions:execute", { statements: [{ sql: "SELECT id, name FROM projects ORDER BY id", params: {} }] }, await h.token("a"));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.results[0].rows, [{ id: "seed", name: "database_a" }]);
    const before = runtimeCalls();
    for (const token of [undefined, "invalid", await h.token("a", {}, { issuer: "https://other-issuer.test" }),
      await h.token("a", {}, { audience: "another-app" }), await h.token("a", {}, { expires: "-1h" })]) {
      const denied = await call("/v1/catalog", undefined, token);
      assert.equal(denied.status, 401);
      assert.deepEqual(denied.body.error, { code: "POLICYSQL_UNAUTHENTICATED", message: "Authentication is required.", path: null, requestId: "req_auth" });
    }
    assert.equal(runtimeCalls(), before, "a rejected credential never initializes WASM or reaches the library");
    // A verified token whose claims break the session contract is a wrapper fault in the library.
    const malformed = await call("/v1/catalog", undefined, await h.token("a", { policysql: { roles: ["member"], default_role: "admin", access: ["catalog"] } }));
    assert.equal(malformed.status, 500);
    assert.equal(malformed.body.error.code, "POLICYSQL_INTERNAL");
    // Health is public and needs no token.
    assert.equal((await call("/healthz")).status, 200);
  });

  test(`${wrapper.name}: missing identity configuration is 500, never a pass-through`, async (t) => {
    const { env, call, h } = await setup(t);
    const logs = [];
    t.mock.method(console, "log", (line) => logs.push(line));
    for (const name of ["POLICYSQL_JWT_ISSUER", "POLICYSQL_JWT_AUDIENCE", "POLICYSQL_JWKS_JSON"]) {
      const saved = env[name];
      delete env[name];
      const result = await call("/v1/catalog", undefined, await h.token("a"));
      assert.equal(result.status, 500, name);
      assert.equal(result.body.error.code, "POLICYSQL_INTERNAL");
      env[name] = saved;
    }
    assert.ok(logs.some((line) => line.includes("authentication_unavailable")));
    assert.equal(logs.some((line) => line.includes("BEGIN")), false);
  });

  test(`${wrapper.name}: every interactive command and commit is re-authenticated, so expiry or revocation stops them`, async (t) => {
    const { h, env, call } = await setup(t);
    const token = await h.token("a");
    const expired = await h.token("a", {}, { expires: "-1h" });
    const start = await call("/v1/transactions", { mode: "write" }, token);
    assert.equal(start.status, 201, JSON.stringify(start.body));
    const path = `/v1/transactions/${start.body.transactionId}`;
    const statement = await call(`${path}/statements`, { sequence: 1, ...update("Changed") }, token);
    assert.equal(statement.status, 200, JSON.stringify(statement.body));
    await h.flush();
    const eventsBefore = h.events.length;
    // The same caller with an expired token cannot continue or commit.
    assert.equal((await call(`${path}/statements`, { sequence: 2, ...update("Expired") }, expired)).status, 401);
    assert.equal((await call(`${path}/commit`, { sequence: 2 }, expired)).status, 401);
    // Revocation known to the verifier: the signing key is removed from the JWKS.
    const replacement = await exportJWK((await generateKeyPair("ES256")).publicKey);
    Object.assign(replacement, { kid: "rotated-key", alg: "ES256" });
    env.POLICYSQL_JWKS_JSON = JSON.stringify({ keys: [replacement] });
    assert.equal((await call(`${path}/statements`, { sequence: 2, ...update("Revoked") }, token)).status, 401);
    assert.equal((await call(`${path}/commit`, { sequence: 2 }, token)).status, 401);
    assert.equal(h.events.length, eventsBefore, "no rejected command reached the database");
    assert.equal(h.rows("a")[0].name, "database_a", "nothing was committed");
  });
}
