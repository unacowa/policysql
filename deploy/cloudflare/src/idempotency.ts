import { EngineError } from "./errors.ts";

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

/**
 * The replay identity of a request with an optional idempotency key (`undefined` when the
 * caller sent none). A transport that can repeat a field (HTTP joins repeated headers with a
 * comma) passes the joined value, which never matches the key syntax.
 */
export const requestIdempotency = async (key: unknown, auth, body, endpoint, databaseBinding) => {
  if (!databaseBinding) throw new EngineError("POLICYSQL_DATABASE_REQUIRED", "A database must be supplied by the application wrapper.");
  if (key === undefined) return null;
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(key)) {
    throw new EngineError("POLICYSQL_IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key must contain 16-128 letters, digits, dots, underscores, colons, or hyphens when provided.",
    );
  }
  // `principal` is the wrapper-namespaced caller identity (ADR 0019); it replaces the JWT issuer.
  const identity = stableJson({
    principal: auth.principal,
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

export const mutationIdempotency = (key: unknown, auth, body, databaseBinding) =>
  requestIdempotency(key, auth, body, "execute", databaseBinding);

export const authFingerprint = (auth, databaseBinding) => {
  if (!databaseBinding) throw new EngineError("POLICYSQL_DATABASE_REQUIRED", "A database must be supplied by the application wrapper.");
  return sha256(stableJson({
    principal: auth.principal,
    subject: auth.subject,
    role: auth.role,
    session: auth.session,
    databaseBinding,
  }));
};
