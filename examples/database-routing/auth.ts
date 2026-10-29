import type {
  createErrorResponse, createJwtSessionVerifier, TrustedSession, WorkerBindings,
} from "@unacowa/policysql/cloudflare";

// Application-owned authentication. PolicySQL never sees a credential (ADR 0019): this
// wrapper verifies the JWT with the library's optional identity adapter, reading its own
// configuration names, and passes the resulting trusted session to `app.fetch`.

export type JwtEnv = WorkerBindings & {
  POLICYSQL_JWKS_JSON?: string;
  POLICYSQL_JWKS_URL?: string;
  POLICYSQL_JWT_ISSUER?: string;
  POLICYSQL_JWT_AUDIENCE?: string;
};

export type Authenticate<Env> = (request: Request, env: Env) => Promise<TrustedSession>;

/** `createJwtSessionVerifier` from `@unacowa/policysql/cloudflare`, injected for testability. */
export const createJwtAuthentication = <Env extends JwtEnv>(
  createVerifier: typeof createJwtSessionVerifier,
): Authenticate<Env> => {
  const verifiers = new Map<string, (request: Request) => Promise<TrustedSession>>();
  return (request, env) => {
    const jwks = env.POLICYSQL_JWKS_JSON || undefined;
    const jwksUrl = jwks === undefined ? env.POLICYSQL_JWKS_URL || undefined : undefined;
    const key = JSON.stringify([jwks, jwksUrl, env.POLICYSQL_JWT_ISSUER, env.POLICYSQL_JWT_AUDIENCE]);
    let verify = verifiers.get(key);
    if (!verify) {
      verify = createVerifier({ jwks, jwksUrl, issuer: env.POLICYSQL_JWT_ISSUER, audience: env.POLICYSQL_JWT_AUDIENCE });
      verifiers.set(key, verify);
    }
    return verify(request);
  };
};

/**
 * Runs `authenticate`. A verification failure (the adapter's `JwtAuthenticationError`,
 * status 401) becomes a 401 response; anything else, such as missing configuration,
 * becomes 500. Every client request is authenticated, including every interactive
 * command and commit, so an expired or revoked token stops the transaction.
 */
export const authenticateRequest = async <Env>(
  authenticate: Authenticate<Env>,
  request: Request,
  env: Env,
  requestId: string,
  errorResponse: typeof createErrorResponse,
): Promise<{ session: TrustedSession } | { response: Response }> => {
  try {
    return { session: await authenticate(request, env) };
  } catch (error) {
    if (error?.name === "JwtAuthenticationError" && error.status === 401) {
      return { response: errorResponse(401, error.code, error.message, { requestId }) };
    }
    console.log(JSON.stringify({ event: "authentication_unavailable", requestId }));
    return { response: errorResponse(500, "POLICYSQL_INTERNAL", "The request could not be completed.", { requestId }) };
  }
};
