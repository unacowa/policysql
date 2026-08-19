import { readFile } from "node:fs/promises";
import { importJWK, SignJWT } from "jose";

const key = JSON.parse(
  await readFile(new URL("../.deployment/dev-issuer-private.jwk", import.meta.url), "utf8"),
);
const privateKey = await importJWK(key, "ES256");
const token = await new SignJWT({
  policysql: {
    roles: ["member"],
    default_role: "member",
    access: ["catalog", "explain", "execute"],
    session: { tenant_id: process.env.POLICYSQL_DEV_TENANT ?? "tenant_a" },
  },
})
  .setProtectedHeader({ alg: "ES256", kid: key.kid })
  .setIssuer("https://policysql.local/development")
  .setAudience("policysql-development")
  .setSubject(process.env.POLICYSQL_DEV_SUBJECT ?? "user_1")
  .setIssuedAt()
  .setExpirationTime("10m")
  .sign(privateKey);
process.stdout.write(`${token}\n`);
