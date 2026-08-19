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
