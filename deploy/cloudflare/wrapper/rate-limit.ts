// Deployment-owned request-rate limiting (ADR 0018). Not part of the published library.
// The wrapper runs this before `app.fetch` / `app.fetchCallback`, so a rejected request
// never authenticates, compiles SQL, initializes WASM, reaches a Durable Object, selects a
// database, or reaches a database.
import { createErrorResponse } from "../src/errors.ts";
import type { WorkerBindings } from "../src/types.ts";

/** Cloudflare Rate Limiting binding (`ratelimits` in wrangler.jsonc). */
export type RateLimiter = { limit(input: { key: string }): Promise<{ success: boolean }> };

export type RateLimitedBindings = WorkerBindings & {
  RATE_LIMITER?: RateLimiter;
  CALLBACK_RATE_LIMITER?: RateLimiter;
};

export type FetchHandler = (
  request: Request,
  env: RateLimitedBindings,
  context: ExecutionContext | undefined,
) => Promise<Response>;

export type RateLimit = Readonly<{
  /** Name of the `ratelimits` binding in wrangler.jsonc. */
  binding: "RATE_LIMITER" | "CALLBACK_RATE_LIMITER";
  /** Must equal that binding's `simple.period`; sent as `Retry-After`. */
  periodSeconds: number;
  /** Counter key. Decided before authentication from values a caller cannot rotate freely. */
  key: (request: Request) => string;
}>;

const clientIp = (request: Request) => request.headers.get("cf-connecting-ip") ?? "unknown";

/**
 * Client API requests: one counter per client IP. Cloudflare always sets
 * `cf-connecting-ip` at the edge; requests without it share a bucket.
 */
export const CLIENT_RATE_LIMIT: RateLimit = Object.freeze({
  binding: "RATE_LIMITER",
  periodSeconds: 60,
  key: (request: Request) => `ip:${clientIp(request)}`,
});

/**
 * Commit-check callbacks: a separate binding and key space, so client traffic cannot
 * starve the validator and callback spam cannot spend the client budget. The capability
 * is only verified inside the transaction owner (after a body parse, a Durable Object
 * lookup and a storage read), so this bound is what limits unauthenticated callback cost.
 */
export const CALLBACK_RATE_LIMIT: RateLimit = Object.freeze({
  binding: "CALLBACK_RATE_LIMITER",
  periodSeconds: 60,
  key: (request: Request) => `callback:${clientIp(request)}`,
});

const requestIdOf = (request: Request) => request.headers.get("cf-ray") ?? crypto.randomUUID();

const internal = (request: Request, requestId: string, event: string, binding: string) => {
  console.log(JSON.stringify({ event, binding, requestId, path: new URL(request.url).pathname }));
  return createErrorResponse(500, "POLICYSQL_INTERNAL", "The request could not be completed.", { requestId });
};

/**
 * Fails closed: a missing binding, a throwing binding, or any outcome other than an
 * explicit `success: true` never reaches `handler`. A deployment that limits elsewhere
 * (WAF, API gateway) removes this wrapper step instead of removing the binding.
 */
export const withRateLimit = (handler: FetchHandler, rateLimit: RateLimit = CLIENT_RATE_LIMIT): FetchHandler =>
  async (request, env, context) => {
    const requestId = requestIdOf(request);
    const limiter = env[rateLimit.binding];
    if (typeof limiter?.limit !== "function") return internal(request, requestId, "rate_limiter_missing", rateLimit.binding);
    let outcome: { success?: unknown } | undefined;
    try {
      outcome = await limiter.limit({ key: rateLimit.key(request) });
    } catch {
      return internal(request, requestId, "rate_limiter_failed", rateLimit.binding);
    }
    if (outcome?.success !== true) {
      return createErrorResponse(429, "POLICYSQL_RATE_LIMITED", "Too many requests.", {
        requestId,
        headers: { "retry-after": String(rateLimit.periodSeconds) },
      });
    }
    return handler(request, env, context);
  };
