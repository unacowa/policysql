// Deployment-owned request-rate limiting (ADR 0018). Not part of the published library.
// The wrapper runs this before `app.fetch`, so a rejected request never authenticates,
// compiles SQL, initializes WASM, selects a database, or reaches a database.
import { createErrorResponse } from "../src/errors.ts";
import type { WorkerBindings } from "../src/types.ts";

/** Cloudflare Rate Limiting binding (`ratelimits` in wrangler.jsonc). */
export type RateLimiter = { limit(input: { key: string }): Promise<{ success: boolean }> };

export type RateLimitedBindings = WorkerBindings & { RATE_LIMITER?: RateLimiter };

export type FetchHandler = (
  request: Request,
  env: RateLimitedBindings,
  context: ExecutionContext | undefined,
) => Promise<Response>;

/** Must equal `simple.period` of the `RATE_LIMITER` binding in wrangler.jsonc. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/**
 * One counter per client IP. The key is decided before authentication, so it does not
 * trust an unverified token, tenant, or path segment that a caller could rotate.
 * Cloudflare always sets `cf-connecting-ip` at the edge; requests without it share a bucket.
 */
export const rateLimitKey = (request: Request) => `ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`;

const requestIdOf = (request: Request) => request.headers.get("cf-ray") ?? crypto.randomUUID();

const internal = (request: Request, requestId: string, event: string) => {
  console.log(JSON.stringify({ event, requestId, path: new URL(request.url).pathname }));
  return createErrorResponse(500, "POLICYSQL_INTERNAL", "The request could not be completed.", { requestId });
};

/**
 * Fails closed: a missing binding, a throwing binding, or any outcome other than an
 * explicit `success: true` never reaches `handler`. A deployment that limits elsewhere
 * (WAF, API gateway) removes this wrapper step instead of removing the binding.
 */
export const withRateLimit = (handler: FetchHandler): FetchHandler => async (request, env, context) => {
  const requestId = requestIdOf(request);
  const limiter = env.RATE_LIMITER;
  if (typeof limiter?.limit !== "function") return internal(request, requestId, "rate_limiter_missing");
  let outcome: { success?: unknown } | undefined;
  try {
    outcome = await limiter.limit({ key: rateLimitKey(request) });
  } catch {
    return internal(request, requestId, "rate_limiter_failed");
  }
  if (outcome?.success !== true) {
    return createErrorResponse(429, "POLICYSQL_RATE_LIMITED", "Too many requests.", {
      requestId,
      headers: { "retry-after": String(RATE_LIMIT_PERIOD_SECONDS) },
    });
  }
  return handler(request, env, context);
};
