import { Hono } from "hono";
import { safeError } from "./errors.ts";
import { requestContext } from "./middleware/request-context.ts";
import { jsonResponse } from "./responses.ts";
import { registerCommitCheckRoutes } from "./routes/commit-checks.ts";
import { registerDiscoveryRoutes } from "./routes/discovery.ts";
import { registerExecuteRoutes } from "./routes/execute.ts";
import { registerSystemRoutes } from "./routes/system.ts";
import { registerTransactionRoutes } from "./routes/transactions.ts";
import type { AppDependencies, AppEnv, WorkerBindings } from "./types.ts";
import { databaseRequired, validateDatabaseBinding, validateDatabaseProvider } from "./database.ts";
import type { DatabaseBinding } from "./database.ts";

export type PolicySqlApp = {
  fetch(request: Request, env: WorkerBindings, executionContext: ExecutionContext | undefined, database: DatabaseBinding): Promise<Response>;
  /** Callback capabilities use the database already pinned by the owner. No database selection. */
  fetchCallback(request: Request, env: WorkerBindings, executionContext: ExecutionContext | undefined): Promise<Response>;
};

export const createApp = (dependencies: AppDependencies): PolicySqlApp => {
  if (typeof dependencies?.getRuntime !== "function") {
    throw new TypeError("getRuntime is required");
  }
  validateDatabaseProvider(dependencies.database);
  if ("transportFactory" in dependencies || "costTransportFactory" in dependencies) {
    throw new TypeError("transportFactory overrides were removed; supply database explicitly");
  }

  const app = new Hono<AppEnv>();
  app.use("*", requestContext());

  registerSystemRoutes(app, dependencies);
  registerDiscoveryRoutes(app, dependencies);
  registerExecuteRoutes(app, dependencies);
  registerTransactionRoutes(app, dependencies);
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

  return {
    async fetch(request, env, executionContext, database) {
      try {
        if (database === undefined || database === null) throw databaseRequired();
        const databaseBinding = validateDatabaseBinding(database, database.snapshot);
        return await app.fetch(request, { deployment: env, databaseBinding }, executionContext);
      } catch (error) {
        const response = safeError(error, crypto.randomUUID());
        return Response.json(response.body, { status: response.status, headers: { "cache-control": "no-store" } });
      }
    },
    async fetchCallback(request, env, executionContext) {
      if (request.method !== "POST" || !/^\/v1\/commit-checks\/cval_[a-f0-9]{32}\/query$/.test(new URL(request.url).pathname)) {
        return Response.json({ error: { code: "POLICYSQL_NOT_FOUND", message: "Endpoint not found." } }, { status: 404 });
      }
      return app.fetch(request, { deployment: env }, executionContext);
    },
  };
};

// Compatibility alias for existing embedders while they move to the Hono app name.
export const createHandlerCore = createApp;
