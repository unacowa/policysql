import type { createErrorResponse, DatabaseBinding, PolicySqlWorkerApp } from "@unacowa/policysql/cloudflare";
import { authenticateRequest, type Authenticate, type JwtEnv } from "./auth.ts";

// Application-owned request-rate limiting. PolicySQL has no limiter (ADR 0018); this
// wrapper decides the keys and runs before `app.fetch` / `app.fetchCallback`, so a rejected
// request never authenticates, initializes WASM, reaches a Durable Object, selects a
// database, or reaches a database.

/** Cloudflare Rate Limiting binding (`ratelimits` in wrangler.jsonc). */
export type RateLimiter = { limit(input: { key: string }): Promise<{ success: boolean }> };

export type FetchHandler<Env> = (
  request: Request,
  env: Env,
  context: ExecutionContext | undefined,
) => Promise<Response>;

export type RateLimitEnv = JwtEnv & {
  RATE_LIMITER?: RateLimiter;
  CALLBACK_RATE_LIMITER?: RateLimiter;
  APPLICATION_DATABASE_ID?: string;
};

export type RateLimit<Env> = Readonly<{
  /** Name of the `ratelimits` binding in wrangler.jsonc; a missing binding fails closed. */
  binding: "RATE_LIMITER" | "CALLBACK_RATE_LIMITER";
  /** Must equal that binding's `simple.period`; sent as `Retry-After`. */
  periodSeconds: number;
  /** Wrapper-chosen counter key. Never an unverified JWT claim. */
  key: (request: Request, env: Env) => string;
}>;

const clientIp = (request: Request) => request.headers.get("cf-connecting-ip") ?? "unknown";

/** Client API requests: the DB this wrapper selected plus the client IP. */
export const CLIENT_RATE_LIMIT: RateLimit<RateLimitEnv> = Object.freeze({
  binding: "RATE_LIMITER",
  periodSeconds: 60,
  key: (request: Request, env: RateLimitEnv) => `${env.APPLICATION_DATABASE_ID}:${clientIp(request)}`,
});

/**
 * Commit-check callbacks: a separate binding and key space, so client traffic cannot starve
 * the validator. The callback capability is only verified inside the transaction owner,
 * after a body parse and a Durable Object lookup, so this bound limits unauthenticated cost.
 */
export const CALLBACK_RATE_LIMIT: RateLimit<RateLimitEnv> = Object.freeze({
  binding: "CALLBACK_RATE_LIMITER",
  periodSeconds: 60,
  key: (request: Request) => `callback:${clientIp(request)}`,
});

export const withRateLimit = <Env extends RateLimitEnv>(
  handler: FetchHandler<Env>,
  rateLimit: RateLimit<Env>,
  /** `createErrorResponse` from `@unacowa/policysql/cloudflare`, injected for testability. */
  errorResponse: typeof createErrorResponse,
): FetchHandler<Env> => async (request, env, context) => {
  const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
  const internal = (event: string) => {
    console.log(JSON.stringify({ event, binding: rateLimit.binding, requestId }));
    return errorResponse(500, "POLICYSQL_INTERNAL", "The request could not be completed.", { requestId });
  };
  const limiter = env[rateLimit.binding];
  if (typeof limiter?.limit !== "function") return internal("rate_limiter_missing");
  let outcome: { success?: unknown } | undefined;
  try {
    outcome = await limiter.limit({ key: rateLimit.key(request, env) });
  } catch {
    return internal("rate_limiter_failed");
  }
  if (outcome?.success !== true) {
    return errorResponse(429, "POLICYSQL_RATE_LIMITED", "Too many requests.", {
      requestId,
      headers: { "retry-after": String(rateLimit.periodSeconds) },
    });
  }
  return handler(request, env, context);
};

/**
 * The example's whole request entry point. Every request is limited before the library:
 * callbacks in their own bucket before `fetchCallback`, everything else in the client
 * bucket. A client request is then authenticated (except the public `/healthz`), and only
 * then is `binding(env)` computed, which reads the runtime snapshot and so initializes WASM.
 */
export const createRateLimitedFetch = <Env extends RateLimitEnv>(
  app: PolicySqlWorkerApp<Env>,
  binding: (env: Env) => DatabaseBinding,
  errorResponse: typeof createErrorResponse,
  authenticate: Authenticate<Env>,
): FetchHandler<Env> => {
  const client = withRateLimit<Env>(async (request, env, context) => {
    let session;
    if (new URL(request.url).pathname !== "/healthz") {
      const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
      const outcome = await authenticateRequest(authenticate, request, env, requestId, errorResponse);
      if ("response" in outcome) return outcome.response;
      session = outcome.session;
    }
    return app.fetch(request, env, context, { database: binding(env), session });
  }, CLIENT_RATE_LIMIT, errorResponse);
  const callback = withRateLimit<Env>(
    (request, env, context) => app.fetchCallback(request, env, context), CALLBACK_RATE_LIMIT, errorResponse,
  );
  return (request, env, context) => new URL(request.url).pathname.startsWith("/v1/commit-checks/")
    ? callback(request, env, context)
    : client(request, env, context);
};
