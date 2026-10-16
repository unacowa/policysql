import { HttpError } from "./errors.ts";

export const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export const sha256 = async (value) => {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const requestIdempotency = async (request, env, auth, body, endpoint, databaseBinding) => {
  if (!databaseBinding) throw new HttpError(500, "POLICYSQL_DATABASE_REQUIRED", "A database must be supplied by the application wrapper.");
  const key = request.headers.get("idempotency-key");
  if (key === null) return null;
  if (key.includes(",") || !/^[A-Za-z0-9._:-]{16,128}$/.test(key)) {
    throw new HttpError(
      400,
      "POLICYSQL_IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key must contain 16-128 letters, digits, dots, underscores, colons, or hyphens when provided.",
    );
  }
  const identity = stableJson({
    issuer: env.POLICYSQL_JWT_ISSUER,
    subject: auth.subject,
    role: auth.role,
    session: auth.session,
    endpoint,
    database: { scope: databaseBinding.scope, databaseId: databaseBinding.databaseId },
  });
  return {
    keyHash: await sha256(`${identity}:${key}`),
    fingerprint: await sha256(`${identity}:${stableJson(body)}:${stableJson(databaseBinding)}`),
  };
};

export const mutationIdempotency = (request, env, auth, body, databaseBinding) =>
  requestIdempotency(request, env, auth, body, "execute", databaseBinding);

export const authFingerprint = (env, auth, databaseBinding) => {
  if (!databaseBinding) throw new HttpError(500, "POLICYSQL_DATABASE_REQUIRED", "A database must be supplied by the application wrapper.");
  return sha256(stableJson({
    issuer: env.POLICYSQL_JWT_ISSUER,
    subject: auth.subject,
    role: auth.role,
    session: auth.session,
    databaseBinding,
  }));
};
