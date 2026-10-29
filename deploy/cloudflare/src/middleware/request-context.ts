import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HttpError } from "../errors.ts";
import type { AppEnv, EngineDependencies } from "../types.ts";

export const requestContext = () => createMiddleware<AppEnv>(async (context, next) => {
  context.set("requestId", context.env.requestId ?? context.req.header("cf-ray") ?? crypto.randomUUID());
  await next();
});

export const runtimeContext = (dependencies: EngineDependencies) => createMiddleware<AppEnv>(async (context, next) => {
  context.set("runtime", dependencies.getRuntime());
  await next();
});

/**
 * The Durable Object namespace `app.fetch` took from the platform bindings. A missing
 * namespace is a wrapper fault, raised before any owner lookup.
 */
export const transactionOwner = (context: Context<AppEnv>, name: string) => {
  const namespace = context.env.transactionOwner;
  if (!namespace || typeof namespace.get !== "function" || typeof namespace.idFromName !== "function") {
    throw new HttpError(500, "POLICYSQL_INTERNAL", "The request could not be completed.");
  }
  return namespace.get(namespace.idFromName(name));
};
