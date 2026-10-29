// Deployment-owned authentication (ADR 0019). Not part of the published library.
// This wrapper uses the library's JWT identity adapter with the development JWT profile
// and reads its configuration from these env names; the library itself reads none of them.
import { createJwtSessionVerifier, JwtAuthenticationError } from "../src/adapters/jwt.ts";
import { createErrorResponse } from "../src/errors.ts";
import type { TrustedSession } from "../src/types.ts";
import type { WrapperBindings } from "./config.ts";

export type JwtBindings = WrapperBindings & {
  POLICYSQL_JWKS_JSON?: string;
  POLICYSQL_JWKS_URL?: string;
  POLICYSQL_JWT_ISSUER?: string;
  POLICYSQL_JWT_AUDIENCE?: string;
};

export type Authenticate = (request: Request, env: JwtBindings) => Promise<TrustedSession>;

type Verifier = (request: Request) => Promise<TrustedSession>;
const verifiers = new Map<string, Verifier>();

/** One verifier per configuration, so a remote JWKS cache survives across requests. */
const verifierFor = (env: JwtBindings): Verifier => {
  const jwks = env.POLICYSQL_JWKS_JSON || undefined;
  const jwksUrl = jwks === undefined ? env.POLICYSQL_JWKS_URL || undefined : undefined;
  const key = JSON.stringify([jwks, jwksUrl, env.POLICYSQL_JWT_ISSUER, env.POLICYSQL_JWT_AUDIENCE]);
  let verifier = verifiers.get(key);
  if (!verifier) {
    verifier = createJwtSessionVerifier({
      jwks, jwksUrl, issuer: env.POLICYSQL_JWT_ISSUER, audience: env.POLICYSQL_JWT_AUDIENCE,
    });
    verifiers.set(key, verifier);
  }
  return verifier;
};

export const authenticateJwt: Authenticate = (request, env) => verifierFor(env)(request);

/**
 * Authenticates one client request. Resolves to the trusted session, or to the response the
 * wrapper returns instead of calling the library: 401 for a credential that cannot be
 * verified, 500 for missing or invalid identity configuration.
 */
export const authenticateRequest = async (
  authenticate: Authenticate,
  request: Request,
  env: JwtBindings,
  requestId: string,
): Promise<{ session: TrustedSession } | { response: Response }> => {
  try {
    return { session: await authenticate(request, env) };
  } catch (error) {
    if (error instanceof JwtAuthenticationError) {
      return { response: createErrorResponse(error.status, error.code, error.message, { requestId }) };
    }
    console.log(JSON.stringify({ event: "authentication_unavailable", requestId, errorClass: error?.constructor?.name ?? "UnknownError" }));
    return { response: createErrorResponse(500, "POLICYSQL_INTERNAL", "The request could not be completed.", { requestId }) };
  }
};
