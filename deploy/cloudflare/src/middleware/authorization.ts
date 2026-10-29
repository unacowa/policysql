import { createMiddleware } from "hono/factory";
import { authorizeSession, requestedRole, type RequiredAccess } from "../session.ts";
import type { AppDependencies, AppEnv } from "../types.ts";

// The wrapper authenticates the caller and passes the trusted session as data (ADR 0019).
// This runs before any body read, Durable Object lookup, or database work.
// Request-rate limiting is also a wrapper responsibility (ADR 0018); the library has no limiter.
export const authorize = (dependencies: AppDependencies, access: RequiredAccess) =>
  createMiddleware<AppEnv>(async (context, next) => {
    const role = requestedRole(context.req.raw.headers);
    const auth = authorizeSession(dependencies.getRuntime(), context.env.session, role, access, context.get("requestId"));
    context.set("auth", auth);
    await next();
  });
