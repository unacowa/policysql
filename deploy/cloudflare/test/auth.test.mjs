import test from "node:test";
import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { authenticate } from "../src/auth.ts";

const issuer = "https://issuer.test";
const audience = "policysql-test";

const fixture = async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "ES256";
  const token = await new SignJWT({
    policysql: {
      roles: ["member"],
      default_role: "member",
      access: ["catalog", "explain"],
      session: { tenant_id: "tenant_a" },
    },
  })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("user_1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return {
    token,
    env: {
      POLICYSQL_JWKS_JSON: JSON.stringify({ keys: [publicJwk] }),
      POLICYSQL_JWT_ISSUER: issuer,
      POLICYSQL_JWT_AUDIENCE: audience,
    },
  };
};

test("verifies signature and canonicalizes the trusted session", async () => {
  const { token, env } = await fixture();
  const request = new Request("https://worker.test/v1/catalog", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.deepEqual(await authenticate(request, env, "catalog"), {
    subject: "user_1",
    role: "member",
    roles: ["member"],
    access: ["catalog", "explain"],
    session: { tenant_id: "tenant_a" },
  });
});

test("rejects missing access and ambiguous authorization before compilation", async () => {
  const { token, env } = await fixture();
  await assert.rejects(
    authenticate(
      new Request("https://worker.test/v1", { headers: { authorization: `Bearer ${token}` } }),
      env,
      "execute",
    ),
    (error) => error.status === 401,
  );
  await assert.rejects(
    authenticate(
      new Request("https://worker.test/v1", {
        headers: { authorization: `Bearer ${token}, Bearer ${token}` },
      }),
      env,
      "catalog",
    ),
    (error) => error.status === 401,
  );
});
