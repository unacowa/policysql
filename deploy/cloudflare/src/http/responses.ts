// HTTP response framing (inbound adapter, ADR 0019): the fixed headers, the public error
// shape, the status of every code (src/http/status.ts), and ETag / 304.
import type { OperationError } from "../errors.ts";
import { ERROR_STATUS, statusFor } from "./status.ts";

const FIXED_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
});

/** A JSON response with the fixed headers. `headers` may replace `cache-control` only. */
export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...FIXED_HEADERS, ...headers } });

/** An operation error in the public error shape, with the status from the single table. */
export const errorResponse = (error: OperationError, requestId: string) => jsonResponse({
  error: { code: error.code, message: error.message, path: error.path, requestId },
}, statusFor(error.code));

/** A representation's validator: the active snapshot, quoted as an HTTP entity tag. */
export const entityTag = (snapshot: string) => `"${snapshot}"`;

/** The snapshot an `If-None-Match` header names, if it is exactly one strong entity tag. */
export const ifNoneMatchSnapshot = (header: string | null): string | undefined => {
  const match = header?.match(/^"([^"]*)"$/u);
  return match ? match[1] : undefined;
};

/** Catalog and Capabilities: a private, revalidated representation, or 304 for a match. */
export const snapshotResponse = (
  result: { notModified: boolean; snapshot: string; value?: unknown },
) => {
  const headers = { "cache-control": "private, max-age=0, must-revalidate", etag: entityTag(result.snapshot) };
  if (result.notModified) return new Response(null, { status: 304, headers });
  return jsonResponse(result.value, 200, headers);
};

export type ErrorResponseOptions = {
  /** RFC 6901 pointer into the request body, or null when no field is at fault. */
  path?: string | null;
  /** Correlation ID for the wrapper's logs. Defaults to a fresh UUID. */
  requestId?: string;
  /** Extra response headers such as `retry-after`. Cannot override the fixed JSON/cache headers. */
  headers?: HeadersInit;
};

const ERROR_CODE = /^POLICYSQL_[A-Z0-9_]+$/u;

/**
 * Builds a response in the public PolicySQL error shape for code that runs before or
 * around `app.fetch`, such as a wrapper's authentication or rate limiter (ADR 0018). A code
 * in the public table must use its status there; a wrapper's own code may use any 4xx/5xx.
 */
export const createErrorResponse = (
  status: number,
  code: string,
  message: string,
  options: ErrorResponseOptions = {},
): Response => {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new TypeError("Error response status must be an integer from 400 to 599");
  }
  if (typeof code !== "string" || !ERROR_CODE.test(code)) {
    throw new TypeError("Error response code must match POLICYSQL_[A-Z0-9_]+");
  }
  if (Object.hasOwn(ERROR_STATUS, code) && ERROR_STATUS[code] !== status) {
    throw new TypeError(`${code} is served with status ${ERROR_STATUS[code]}`);
  }
  if (typeof message !== "string" || !message) {
    throw new TypeError("Error response message must be a non-empty string");
  }
  const path = options.path ?? null;
  if (path !== null && typeof path !== "string") throw new TypeError("Error response path must be a string or null");
  const requestId = options.requestId ?? crypto.randomUUID();
  if (typeof requestId !== "string" || !requestId) throw new TypeError("Error response requestId must be a non-empty string");
  const headers = new Headers(options.headers);
  for (const [name, value] of Object.entries(FIXED_HEADERS)) headers.set(name, value);
  return new Response(JSON.stringify({ error: { code, message, path, requestId } }), { status, headers });
};
