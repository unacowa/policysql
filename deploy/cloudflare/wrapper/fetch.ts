// Deployment-owned request entry point. Not part of the published library.
import type { PolicySqlApp } from "../src/app.ts";
import type { DatabaseBinding } from "../src/database.ts";
import { withRateLimit, type FetchHandler, type RateLimitedBindings } from "./rate-limit.ts";

const COMMIT_CHECK_CALLBACK = "/v1/commit-checks/";

/**
 * Commit-check callbacks come from the validator during a commit, are protected by an
 * opaque per-transaction capability, and use the owner's pinned database; they are not
 * rate limited so a busy validator cannot turn a commit into a spurious failure.
 * Every other request is limited before the database binding is computed, because
 * computing it initializes the WASM runtime.
 */
export const createWrapperFetch = (
  app: PolicySqlApp,
  binding: (env: RateLimitedBindings) => DatabaseBinding,
): FetchHandler => {
  const limited = withRateLimit((request, env, context) => app.fetch(request, env, context, binding(env)));
  return (request, env, context) => new URL(request.url).pathname.startsWith(COMMIT_CHECK_CALLBACK)
    ? app.fetchCallback(request, env, context)
    : limited(request, env, context);
};
