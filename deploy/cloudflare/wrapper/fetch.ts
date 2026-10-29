// Deployment-owned request entry point. Not part of the published library.
import type { PolicySqlWorkerApp } from "../src/package.ts";
import type { DatabaseBinding } from "../src/database.ts";
import { authenticateJwt, authenticateRequest, type Authenticate } from "./auth.ts";
import {
  CALLBACK_RATE_LIMIT, CLIENT_RATE_LIMIT, withRateLimit, type FetchHandler, type RateLimitedBindings,
} from "./rate-limit.ts";

const COMMIT_CHECK_CALLBACK = "/v1/commit-checks/";
const HEALTH = "/healthz";

/**
 * Every request is rate limited before it reaches the library.
 * - Client requests use the client bucket, then are authenticated (every request,
 *   including every interactive command and commit, so an expired or revoked token stops
 *   a transaction), and only then is the database binding computed, because computing it
 *   initializes the WASM runtime. `/healthz` is public and is not authenticated.
 * - Commit-check callbacks use a separate bucket, before `fetchCallback` parses the body
 *   or reaches a Durable Object; their capability is only checked inside the owner.
 */
export const createWrapperFetch = (
  app: PolicySqlWorkerApp<RateLimitedBindings>,
  binding: (env: RateLimitedBindings) => DatabaseBinding,
  authenticate: Authenticate = authenticateJwt,
): FetchHandler => {
  const client = withRateLimit(async (request, env, context) => {
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    let session;
    if (new URL(request.url).pathname !== HEALTH) {
      const outcome = await authenticateRequest(authenticate, request, env, requestId);
      if ("response" in outcome) return outcome.response;
      session = outcome.session;
    }
    // The library reads no platform header; this wrapper passes Cloudflare's ray id.
    return app.fetch(request, env, context, { database: binding(env), session, requestId });
  }, CLIENT_RATE_LIMIT);
  const callback = withRateLimit((request, env, context) => app.fetchCallback(request, env, context, {
    requestId: request.headers.get("cf-ray") ?? crypto.randomUUID(),
  }), CALLBACK_RATE_LIMIT);
  return (request, env, context) => new URL(request.url).pathname.startsWith(COMMIT_CHECK_CALLBACK)
    ? callback(request, env, context)
    : client(request, env, context);
};
