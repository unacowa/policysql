// Operation errors (ADR 0019). An error carries a stable `POLICYSQL_*` code, a message that
// is safe to show an untrusted client, and an RFC 6901 pointer into the request body. It
// carries no transport status: the HTTP adapter maps the code to a status in its single
// table (src/http/status.ts), and a non-HTTP caller reads the code.

/** An operation's failure as data: what every engine operation returns instead of a value. */
export type OperationError = {
  code: string;
  message: string;
  /** RFC 6901 pointer into the request body, or null when no field is at fault. */
  path: string | null;
};

export class EngineError extends Error {
  readonly code: string;
  readonly path: string | null;

  constructor(code: string, message: string, path: string | null = null) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

export const internalError = () => new EngineError("POLICYSQL_INTERNAL", "The request could not be completed.");

// A well-formed BLOB over the per-value limit is a permanent limit condition, not a
// transient database failure; both database transports use this same category. The
// HTTP transport also uses it for statement responses over its response-size bound.
export const binaryLimitExceeded = () => new EngineError(
  "POLICYSQL_LIMIT_EXCEEDED", "The request or result exceeded a configured limit.",
);

/** The public form of any thrown value: an EngineError as is, anything else as INTERNAL. */
export const operationError = (error: unknown): OperationError => error instanceof EngineError
  ? { code: error.code, message: error.message, path: error.path }
  : { code: "POLICYSQL_INTERNAL", message: "The request could not be completed.", path: null };

/** Core's `{ error: { code, message, path } }` result as an EngineError, or null for a success. */
export const wasmError = (body: any): EngineError | null => {
  const code = body?.error?.code;
  if (!code) return null;
  return new EngineError(
    code,
    body.error.message ?? "The request could not be completed.",
    typeof body.error.path === "string" ? body.error.path : null,
  );
};
