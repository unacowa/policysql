import { createMiddleware } from "hono/factory";
import { authenticate } from "../auth.ts";
import type { AppEnv } from "../types.ts";

// Request-rate limiting is a wrapper responsibility (ADR 0018); the library has no limiter.
export const authorize = (access: "catalog" | "explain" | "execute") =>
  createMiddleware<AppEnv>(async (context, next) => {
    const auth = await authenticate(context.req.raw, context.env.deployment, access);
    context.set("auth", auth);
    await next();
  });
