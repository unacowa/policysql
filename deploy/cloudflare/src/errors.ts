export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly path: string | null;

  constructor(status, code, message, path = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

// A well-formed BLOB over the per-value limit is a permanent limit condition, not a
// transient database failure; both database transports use this same category. The
// HTTP transport also uses it for statement responses over its response-size bound.
export const binaryLimitExceeded = () => new HttpError(
  413, "POLICYSQL_LIMIT_EXCEEDED", "The request or result exceeded a configured limit.",
);

export const safeError = (error, requestId) => {
  const known = error instanceof HttpError;
  return {
    status: known ? error.status : 500,
    body: {
      error: {
        code: known ? error.code : "POLICYSQL_INTERNAL",
        message: known ? error.message : "The request could not be completed.",
        path: known ? error.path : null,
        requestId,
      },
    },
  };
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
 * around `app.fetch`, such as a wrapper's rate limiter (ADR 0018). Codes that only a
 * wrapper emits, such as the 429 rate-limit code, never originate in the library.
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
  if (typeof message !== "string" || !message) {
    throw new TypeError("Error response message must be a non-empty string");
  }
  const path = options.path ?? null;
  if (path !== null && typeof path !== "string") throw new TypeError("Error response path must be a string or null");
  const requestId = options.requestId ?? crypto.randomUUID();
  if (typeof requestId !== "string" || !requestId) throw new TypeError("Error response requestId must be a non-empty string");
  const headers = new Headers(options.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify({ error: { code, message, path, requestId } }), { status, headers });
};

export const wasmError = (body) => {
  const code = body?.error?.code;
  const statuses = {
    POLICYSQL_UNAUTHENTICATED: 401,
    POLICYSQL_FORBIDDEN_ACCESS: 403,
    POLICYSQL_STALE_OPERATION: 409,
    POLICYSQL_INVALID_SQL: 400,
    POLICYSQL_MULTIPLE_STATEMENTS: 400,
    POLICYSQL_UNSUPPORTED_SQL: 400,
    POLICYSQL_MISSING_POLICY: 403,
    POLICYSQL_FORBIDDEN_OPERATION: 403,
    POLICYSQL_FORBIDDEN_COLUMN: 403,
    POLICYSQL_FORBIDDEN_COLUMN_CONTEXT: 403,
    POLICYSQL_DUPLICATE_RESULT_COLUMN: 400,
    POLICYSQL_INVALID_PARAMETER: 400,
    POLICYSQL_AMBIGUOUS_PARAMETER_TYPE: 400,
    POLICYSQL_RESERVED_PARAMETER: 400,
    POLICYSQL_PRESET_COLUMN: 403,
    POLICYSQL_LIMIT_EXCEEDED: 413,
    POLICYSQL_EXPECTATION_FAILED: 422,
    POLICYSQL_SCHEMA_MISMATCH: 422,
    POLICYSQL_DATABASE_UNAVAILABLE: 503,
    POLICYSQL_AUTHENTICATION_FAILED: 401,
    POLICYSQL_ACCESS_DENIED: 403,
    POLICYSQL_SNAPSHOT_MISMATCH: 412,
    POLICYSQL_INVALID_REQUEST: 400,
    POLICYSQL_STATEMENT_REJECTED: 403,
  };
  if (!code) return null;
  return new HttpError(
    statuses[code] ?? 500,
    code,
    body.error.message ?? "The request could not be completed.",
    typeof body.error.path === "string" ? body.error.path : null,
  );
};
