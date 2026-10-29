import type { Hono } from "hono";
import { runtimeContext } from "../middleware/request-context.ts";
import { jsonResponse } from "../responses.ts";
import type { AppDependencies, AppEnv } from "../types.ts";

export const registerSystemRoutes = (app: Hono<AppEnv>, dependencies: AppDependencies) => {
  app.get("/healthz", runtimeContext(dependencies), (context) => {
    const runtime = context.get("runtime");
    return jsonResponse(context, {
      status: "ok",
      live: true,
      // The runtime loaded. Identity configuration belongs to the wrapper (ADR 0019).
      ready: true,
      environment: context.env.deployment.POLICYSQL_ENVIRONMENT,
      abiVersion: runtime.abi_version,
      profile: runtime.profile,
      snapshot: runtime.snapshot,
      requestId: context.get("requestId"),
    });
  });
};
