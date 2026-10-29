import { createMiddleware } from "hono/factory";
import { HttpError } from "../errors.ts";
import { isOwnerHandle, OWNER_NAME } from "../transaction-owner-port.ts";
import type { TransactionOwnerHandle } from "../transaction-owner-port.ts";
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
 * The handle of the one owner for `name`, through the wrapper's TransactionOwner port
 * (ADR 0022). A malformed name or handle is a library or wrapper fault: 500, no command sent.
 */
export const transactionOwner = (dependencies: EngineDependencies, name: string): TransactionOwnerHandle => {
  if (!OWNER_NAME.test(name)) throw new HttpError(500, "POLICYSQL_INTERNAL", "The request could not be completed.");
  const handle = dependencies.transactionOwners.route(name);
  if (!isOwnerHandle(handle)) throw new HttpError(500, "POLICYSQL_INTERNAL", "The request could not be completed.");
  return handle;
};
