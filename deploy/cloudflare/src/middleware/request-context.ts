import { createMiddleware } from "hono/factory";
import type { AppDependencies, AppEnv } from "../types.ts";

export const requestContext = () => createMiddleware<AppEnv>(async (context, next) => {
  context.set("requestId", context.req.header("cf-ray") ?? crypto.randomUUID());
  await next();
});

export const runtimeContext = (dependencies: AppDependencies) => createMiddleware<AppEnv>(async (context, next) => {
  context.set("runtime", dependencies.getRuntime());
  await next();
});
