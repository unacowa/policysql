import { Hono } from "hono";
import { safeError } from "./errors.ts";
import { requestContext } from "./middleware/request-context.ts";
import { jsonResponse } from "./responses.ts";
import { registerCommitCheckRoutes } from "./routes/commit-checks.ts";
import { registerDiscoveryRoutes } from "./routes/discovery.ts";
import { registerExecuteRoutes } from "./routes/execute.ts";
import { registerSystemRoutes } from "./routes/system.ts";
import { registerTransactionRoutes } from "./routes/transactions.ts";
import { HttpError } from "./errors.ts";
import type { AppDependencies, AppEnv, RequestContext, WorkerBindings } from "./types.ts";
import { databaseRequired, validateDatabaseBinding, validateDatabaseProvider } from "./database.ts";

export type PolicySqlApp = {
  /**
   * Serves one client request. The wrapper has already authenticated the caller and
   * selected the database; `context` carries both as data (ADR 0014, ADR 0019).
   */
  fetch(request: Request, env: WorkerBindings, executionContext: ExecutionContext | undefined, context: RequestContext): Promise<Response>;
  /** Callback capabilities use the database already pinned by the owner. No database selection. */
  fetchCallback(request: Request, env: WorkerBindings, executionContext: ExecutionContext | undefined): Promise<Response>;
};

const REQUEST_CONTEXT_KEYS = new Set(["database", "session", "requestId"]);
// Echoed in response bodies and forwarded as a header to the transaction owner.
const REQUEST_ID = /^[\x21-\x7e]{1,128}$/u;

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
    async fetch(request, env, executionContext, context) {
      try {
        const database = context === null || typeof context !== "object" ? undefined : context.database;
        if (database === undefined || database === null) throw databaseRequired();
        const unknownKey = Object.keys(context).find((key) => !REQUEST_CONTEXT_KEYS.has(key));
        if (unknownKey !== undefined || (context.requestId !== undefined &&
          (typeof context.requestId !== "string" || !REQUEST_ID.test(context.requestId)))) {
          console.log(JSON.stringify({ event: "request_context_rejected", field: unknownKey ?? "requestId" }));
          throw new HttpError(500, "POLICYSQL_INTERNAL", "The request could not be completed.");
        }
        const databaseBinding = validateDatabaseBinding(database, database.snapshot);
        return await app.fetch(request, {
          deployment: env, databaseBinding, session: context.session, requestId: context.requestId,
        }, executionContext);
      } catch (error) {
        const response = safeError(error, crypto.randomUUID());
        return Response.json(response.body, { status: response.status, headers: { "cache-control": "no-store" } });
      }
    },
    async fetchCallback(request, env, executionContext) {
      if (request.method !== "POST" || !/^\/v1\/commit-checks\/cval_[a-f0-9]{32}\/query$/.test(new URL(request.url).pathname)) {
        return Response.json({ error: { code: "POLICYSQL_NOT_FOUND", message: "Endpoint not found." } }, { status: 404 });
      }
      return app.fetch(request, { deployment: env, callback: true }, executionContext);
    },
  };
};

// Compatibility alias for existing embedders while they move to the Hono app name.
export const createHandlerCore = createApp;
