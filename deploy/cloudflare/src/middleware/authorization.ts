import { createMiddleware } from "hono/factory";
import { authenticate } from "../auth.ts";
import { enforceRateLimit } from "../rate-limit.ts";
import type { AppEnv } from "../types.ts";

export const authorize = (access: "catalog" | "explain" | "execute", bucket: string) =>
  createMiddleware<AppEnv>(async (context, next) => {
    const auth = await authenticate(context.req.raw, context.env, access);
    await enforceRateLimit(context.env, auth, bucket, context.req.raw);
    context.set("auth", auth);
    await next();
  });
