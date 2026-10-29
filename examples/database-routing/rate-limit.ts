import type { createErrorResponse, WorkerBindings } from "@unacowa/policysql/cloudflare";

// Application-owned request-rate limiting. PolicySQL has no limiter (ADR 0018); this
// wrapper decides the key and runs before `app.fetch`, so a rejected request never
// authenticates, initializes WASM, selects a database, or reaches a database.

/** Cloudflare Rate Limiting binding (`ratelimits` in wrangler.jsonc). */
export type RateLimiter = { limit(input: { key: string }): Promise<{ success: boolean }> };

export type FetchHandler<Env> = (
  request: Request,
  env: Env,
  context: ExecutionContext | undefined,
) => Promise<Response>;

export type RateLimitOptions<Env> = {
  /** Returns the binding; a missing binding fails closed. */
  limiter: (env: Env) => RateLimiter | undefined;
  /** Wrapper-chosen key, e.g. the tenant/database this wrapper selected plus the client IP. */
  key: (request: Request, env: Env) => string;
  /** Sent as `Retry-After`; must equal the binding's `simple.period`. */
  retryAfterSeconds: number;
  /** `createErrorResponse` from `@unacowa/policysql/cloudflare`, injected for testability. */
  errorResponse: typeof createErrorResponse;
};

export const withRateLimit = <Env extends WorkerBindings>(
  handler: FetchHandler<Env>,
  options: RateLimitOptions<Env>,
): FetchHandler<Env> => async (request, env, context) => {
  const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
  const internal = (event: string) => {
    console.log(JSON.stringify({ event, requestId }));
    return options.errorResponse(500, "POLICYSQL_INTERNAL", "The request could not be completed.", { requestId });
  };
  const limiter = options.limiter(env);
  if (typeof limiter?.limit !== "function") return internal("rate_limiter_missing");
  let outcome: { success?: unknown } | undefined;
  try {
    outcome = await limiter.limit({ key: options.key(request, env) });
  } catch {
    return internal("rate_limiter_failed");
  }
  if (outcome?.success !== true) {
    return options.errorResponse(429, "POLICYSQL_RATE_LIMITED", "Too many requests.", {
      requestId,
      headers: { "retry-after": String(options.retryAfterSeconds) },
    });
  }
  return handler(request, env, context);
};
