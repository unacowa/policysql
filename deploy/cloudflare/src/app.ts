import { Hono } from "hono";
import { safeError } from "./errors.ts";
import { requestContext } from "./middleware/request-context.ts";
import { jsonResponse } from "./responses.ts";
import { registerCommitCheckRoutes } from "./routes/commit-checks.ts";
import { registerDiscoveryRoutes } from "./routes/discovery.ts";
import { registerExecuteRoutes } from "./routes/execute.ts";
import { registerSystemRoutes } from "./routes/system.ts";
import { registerTransactionRoutes } from "./routes/transactions.ts";
import type { AppDependencies, AppEnv } from "./types.ts";

export const createApp = (dependencies: AppDependencies) => {
  if (typeof dependencies?.getRuntime !== "function") {
    throw new TypeError("getRuntime is required");
  }

  const app = new Hono<AppEnv>();
  app.use("*", requestContext());

  registerSystemRoutes(app, dependencies);
  registerDiscoveryRoutes(app, dependencies);
  registerExecuteRoutes(app, dependencies);
  registerTransactionRoutes(app);
  registerCommitCheckRoutes(app);

  app.notFound((context) => jsonResponse(context, {
    error: {
      code: "POLICYSQL_NOT_FOUND",
      message: "Endpoint not found.",
      path: null,
      requestId: context.get("requestId"),
    },
  }, 404));

  app.onError((error, context) => {
    const requestId = context.get("requestId") ?? crypto.randomUUID();
    const response = safeError(error, requestId);
    const codedError = error as unknown as { code?: unknown };
    console.log(JSON.stringify({
      event: "request_rejected",
      requestId,
      code: response.body.error.code,
      internalClass: error?.constructor?.name ?? "UnknownError",
      internalCode: typeof codedError.code === "string"
        ? codedError.code
        : null,
    }));
    return jsonResponse(context, response.body, response.status);
  });

  return app;
};

// Compatibility alias for existing embedders while they move to the Hono app name.
export const createHandlerCore = createApp;
