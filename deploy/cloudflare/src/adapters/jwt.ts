// Identity adapter (ADR 0019): verifies a bearer JWT and translates the PolicySQL JWT
// profile (ADR 0020) into a trusted session. Only a wrapper calls it; the engine never
// imports it and never sees a credential. It makes no authorization decision: core
// validates the resulting session, selects the role, and checks access.
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import type { TrustedSession } from "../types.ts";

const ALGORITHMS = ["RS256", "ES256"];

export type JwtSessionVerifierOptions = {
  /** Local JWKS, as an object or its JSON text. Exactly one of `jwks` and `jwksUrl`. */
  jwks?: JSONWebKeySet | string;
  /** Remote JWKS endpoint. Exactly one of `jwks` and `jwksUrl`. */
  jwksUrl?: string | URL;
  issuer: string;
  audience: string;
};

/** Thrown for any credential that cannot be verified. The wrapper maps it to 401. */
export class JwtAuthenticationError extends Error {
  readonly status = 401;
  readonly code = "POLICYSQL_UNAUTHENTICATED";

  constructor() {
    super("Authentication is required.");
    this.name = "JwtAuthenticationError";
  }
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const keySet = (options: JwtSessionVerifierOptions) => {
  if ((options.jwks === undefined) === (options.jwksUrl === undefined)) {
    throw new TypeError("Exactly one of jwks and jwksUrl is required");
  }
  if (options.jwksUrl !== undefined) {
    return createRemoteJWKSet(new URL(options.jwksUrl), {
      timeoutDuration: 1_500,
      cooldownDuration: 30_000,
      cacheMaxAge: 300_000,
    });
  }
  let jwks: unknown = options.jwks;
  if (typeof jwks === "string") {
    try {
      jwks = JSON.parse(jwks);
    } catch {
      throw new TypeError("jwks must be valid JSON");
    }
  }
  const keys = (jwks as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new TypeError("jwks must contain at least one key");
  return createLocalJWKSet(jwks as JSONWebKeySet);
};

/**
 * Creates a verifier for one issuer, audience, and key source. Invalid configuration
 * throws a `TypeError` here, at construction. The returned function resolves to a trusted
 * session or rejects with `JwtAuthenticationError`.
 *
 * Profile: algorithms RS256/ES256, 5 s clock tolerance, required `sub`, `iat`, `exp` and a
 * `policysql` object claim `{ roles, default_role, access, session? }`. `principal` is
 * `issuer:sub`; `sub` becomes `subject`.
 */
export const createJwtSessionVerifier = (options: JwtSessionVerifierOptions) => {
  if (!nonEmpty(options?.issuer) || !nonEmpty(options?.audience)) {
    throw new TypeError("issuer and audience are required");
  }
  const { issuer, audience } = options;
  const keys = keySet(options);
  return async (request: Request): Promise<TrustedSession> => {
    const authorization = request.headers.get("authorization");
    // A repeated header is joined with a comma and is ambiguous.
    if (!authorization?.startsWith("Bearer ") || authorization.length <= 7 || authorization.includes(",")) {
      throw new JwtAuthenticationError();
    }
    let payload;
    try {
      ({ payload } = await jwtVerify(authorization.slice(7), keys, {
        algorithms: ALGORITHMS,
        issuer,
        audience,
        clockTolerance: 5,
        requiredClaims: ["sub", "iat", "exp", "policysql"],
      }));
    } catch {
      throw new JwtAuthenticationError();
    }
    const claims = payload.policysql as Record<string, unknown> | null;
    if (!nonEmpty(payload.sub) || !claims || typeof claims !== "object" || Array.isArray(claims)) {
      throw new JwtAuthenticationError();
    }
    // Translation only. Core validates every field and rejects a malformed session.
    return {
      principal: `${issuer}:${payload.sub}`,
      subject: payload.sub,
      roles: claims.roles as TrustedSession["roles"],
      defaultRole: claims.default_role as string,
      access: claims.access as TrustedSession["access"],
      session: (claims.session ?? {}) as Record<string, string>,
    };
  };
};
