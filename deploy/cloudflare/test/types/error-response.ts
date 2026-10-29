// Compile-only regressions: wrappers build PolicySQL-shaped errors from the public entrypoint (ADR 0018).
import { createErrorResponse } from "../../src/package.ts";
import type { ErrorResponseOptions, PlatformBindings } from "../../src/package.ts";

declare const env: PlatformBindings;

const checkTypes = () => {
  const options: ErrorResponseOptions = { requestId: "req_1", headers: { "retry-after": "60" } };
  const response: Response = createErrorResponse(429, "POLICYSQL_RATE_LIMITED", "Too many requests.", options);
  void response;
  // @ts-expect-error The message is required.
  createErrorResponse(429, "POLICYSQL_RATE_LIMITED");
  // @ts-expect-error The library no longer declares a rate limiter binding.
  const limiter: { limit: unknown } = env.POLICYSQL_RATE_LIMITER;
  void limiter;
};
void checkTypes;
