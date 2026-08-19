import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import { HttpError } from "./errors.ts";

const ALGORITHMS = ["RS256", "ES256"];
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const remoteSets = new Map();

const authenticationFailed = () =>
  new HttpError(401, "POLICYSQL_UNAUTHENTICATED", "Authentication is required.");

const keySet = (env) => {
  if (env.POLICYSQL_JWKS_JSON) {
    let jwks;
    try {
      jwks = JSON.parse(env.POLICYSQL_JWKS_JSON);
    } catch {
      throw authenticationFailed();
    }
    if (!Array.isArray(jwks?.keys) || jwks.keys.length === 0) {
      throw authenticationFailed();
    }
    return createLocalJWKSet(jwks);
  }
  if (!env.POLICYSQL_JWKS_URL) throw authenticationFailed();
  let set = remoteSets.get(env.POLICYSQL_JWKS_URL);
  if (!set) {
    set = createRemoteJWKSet(new URL(env.POLICYSQL_JWKS_URL), {
      timeoutDuration: 1_500,
      cooldownDuration: 30_000,
      cacheMaxAge: 300_000,
    });
    remoteSets.set(env.POLICYSQL_JWKS_URL, set);
  }
  return set;
};

const singleHeader = (headers, name) => {
  const value = headers.get(name);
  if (value?.includes(",")) throw authenticationFailed();
  return value;
};

const uniqueIdentifiers = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  new Set(value).size === value.length &&
  value.every((item) => typeof item === "string" && IDENTIFIER.test(item));

export const authenticate = async (request, env, requiredAccess) => {
  const authorization = singleHeader(request.headers, "authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) {
    throw authenticationFailed();
  }
  if (!env.POLICYSQL_JWT_ISSUER || !env.POLICYSQL_JWT_AUDIENCE) {
    throw authenticationFailed();
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(authorization.slice(7), keySet(env), {
      algorithms: ALGORITHMS,
      issuer: env.POLICYSQL_JWT_ISSUER,
      audience: env.POLICYSQL_JWT_AUDIENCE,
      clockTolerance: 5,
      requiredClaims: ["sub", "iat", "exp", "policysql"],
    }));
  } catch {
    throw authenticationFailed();
  }
  const claims = payload.policysql;
  if (
    typeof payload.sub !== "string" ||
    payload.sub.length === 0 ||
    !claims ||
    !uniqueIdentifiers(claims.roles) ||
    typeof claims.default_role !== "string" ||
    !claims.roles.includes(claims.default_role) ||
    !uniqueIdentifiers(claims.access) ||
    !claims.access.every((value) => ["catalog", "explain", "execute"].includes(value)) ||
    !claims.access.includes(requiredAccess)
  ) {
    throw authenticationFailed();
  }
  const selectedRole = singleHeader(request.headers, "policysql-role") ?? claims.default_role;
  if (!claims.roles.includes(selectedRole)) {
    throw new HttpError(403, "POLICYSQL_FORBIDDEN_ACCESS", "The authenticated session cannot use this endpoint.");
  }
  const session = claims.session ?? {};
  if (
    !session ||
    Array.isArray(session) ||
    typeof session !== "object" ||
    Object.entries(session).some(
      ([name, value]) =>
        !IDENTIFIER.test(name) ||
        name === "subject_id" ||
        name === "role" ||
        typeof value !== "string",
    )
  ) {
    throw authenticationFailed();
  }
  return {
    subject: payload.sub,
    role: selectedRole,
    roles: claims.roles,
    access: claims.access,
    session,
  };
};
