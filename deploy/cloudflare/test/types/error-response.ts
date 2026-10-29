// Compile-only regressions: wrappers build PolicySQL-shaped errors from the public entrypoint (ADR 0018).
import { createErrorResponse } from "../../src/package.ts";
import type { ErrorResponseOptions } from "../../src/package.ts";

const checkTypes = () => {
  const options: ErrorResponseOptions = { requestId: "req_1", headers: { "retry-after": "60" } };
  const response: Response = createErrorResponse(429, "POLICYSQL_RATE_LIMITED", "Too many requests.", options);
  void response;
  // @ts-expect-error The message is required.
  createErrorResponse(429, "POLICYSQL_RATE_LIMITED");
};
void checkTypes;
