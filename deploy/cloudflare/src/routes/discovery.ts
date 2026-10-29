import type { Hono } from "hono";
import { authorize } from "../middleware/authorization.ts";
import { runtimeContext } from "../middleware/request-context.ts";
import { capabilities, parsedRuntimeCall } from "../presenters.ts";
import { jsonResponse, notModified, snapshotHeaders } from "../responses.ts";
import type { AppDependencies, AppEnv } from "../types.ts";
import { checkDatabaseBinding } from "../database.ts";

export const registerDiscoveryRoutes = (app: Hono<AppEnv>, dependencies: AppDependencies) => {
  app.get("/v1/capabilities", authorize(dependencies, "catalog"), runtimeContext(dependencies), async (context) => {
    const runtime = context.get("runtime");
    await checkDatabaseBinding(dependencies.database, context.env.databaseBinding, context.env.deployment, runtime.snapshot);
    const headers = snapshotHeaders(runtime);
    if (notModified(context.req.raw, runtime)) return new Response(null, { status: 304, headers });
    return jsonResponse(context, capabilities(runtime, dependencies.publicConfig), 200, headers);
  });

  app.get("/v1/catalog", authorize(dependencies, "catalog"), runtimeContext(dependencies), async (context) => {
    const runtime = context.get("runtime");
    await checkDatabaseBinding(dependencies.database, context.env.databaseBinding, context.env.deployment, runtime.snapshot);
    const headers = snapshotHeaders(runtime);
    if (notModified(context.req.raw, runtime)) return new Response(null, { status: 304, headers });
    const catalog = parsedRuntimeCall(runtime.catalog_json(JSON.stringify(context.get("auth"))));
    return jsonResponse(context, catalog, 200, headers);
  });
};
