import type { Context } from "hono";
import type { AppEnv } from "./types.ts";

export const jsonResponse = (
  _context: Context<AppEnv>,
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...Object.fromEntries(new Headers(headers)),
  },
});

export const snapshotHeaders = (runtime: { snapshot: string }): HeadersInit => ({
  "cache-control": "private, max-age=0, must-revalidate",
  etag: `"${runtime.snapshot}"`,
});

export const notModified = (request: Request, runtime: { snapshot: string }) =>
  request.headers.get("if-none-match") === `"${runtime.snapshot}"`;
