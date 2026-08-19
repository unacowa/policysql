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
      ready: Boolean(
        (context.env.POLICYSQL_JWKS_JSON || context.env.POLICYSQL_JWKS_URL) &&
          context.env.POLICYSQL_JWT_ISSUER &&
          context.env.POLICYSQL_JWT_AUDIENCE,
      ),
      environment: context.env.POLICYSQL_ENVIRONMENT,
      abiVersion: runtime.abi_version,
      profile: runtime.profile,
      snapshot: runtime.snapshot,
      requestId: context.get("requestId"),
    });
  });
};
