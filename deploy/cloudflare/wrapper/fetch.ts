// Deployment-owned request entry point. Not part of the published library.
import type { PolicySqlApp } from "../src/app.ts";
import type { DatabaseBinding } from "../src/database.ts";
import {
  CALLBACK_RATE_LIMIT, CLIENT_RATE_LIMIT, withRateLimit, type FetchHandler, type RateLimitedBindings,
} from "./rate-limit.ts";

const COMMIT_CHECK_CALLBACK = "/v1/commit-checks/";

/**
 * Every request is rate limited before it reaches the library.
 * - Client requests use the client bucket, before the database binding is computed,
 *   because computing it initializes the WASM runtime.
 * - Commit-check callbacks use a separate bucket, before `fetchCallback` parses the body
 *   or reaches a Durable Object; their capability is only checked inside the owner.
 */
export const createWrapperFetch = (
  app: PolicySqlApp,
  binding: (env: RateLimitedBindings) => DatabaseBinding,
): FetchHandler => {
  const client = withRateLimit((request, env, context) => app.fetch(request, env, context, binding(env)), CLIENT_RATE_LIMIT);
  const callback = withRateLimit((request, env, context) => app.fetchCallback(request, env, context), CALLBACK_RATE_LIMIT);
  return (request, env, context) => new URL(request.url).pathname.startsWith(COMMIT_CHECK_CALLBACK)
    ? callback(request, env, context)
    : client(request, env, context);
};
