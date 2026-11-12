// Operation errors (ADR 0019). An error carries a stable `POLICYSQL_*` code, a message that
// is safe to show an untrusted client, and an RFC 6901 pointer into the request body. It
// carries no transport status: the HTTP adapter maps the code to a status in its single
// table (src/http/status.ts), and a non-HTTP caller reads the code.
import type { ErrorDetail } from "./error-detail.ts";

/** An operation's failure as data: what every engine operation returns instead of a value. */
export type OperationError = {
  code: string;
  message: string;
  /** RFC 6901 pointer into the request body, or null when no field is at fault. */
  path: string | null;
  /** Machine-readable values fixed per code (ADR 0030). */
  detail?: ErrorDetail;
};

export class EngineError extends Error {
  readonly code: string;
  readonly path: string | null;
  readonly detail?: ErrorDetail;

  constructor(code: string, message: string, path: string | null = null, detail?: ErrorDetail) {
    super(message);
    this.code = code;
    this.path = path;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * Core denied the trusted session's requested role or the endpoint's access. It is the
 * caller's request, not a fault, but it is not a definite rejection for a keyed execute: the
 * request may be the retry of a write that committed before a deployment changed the
 * wrapper's session policy (ADR 0007, #85), so the engine answers the unknown outcome instead.
 */
export class AccessDeniedError extends EngineError {}

/**
 * A failure that happened before any byte of COMMIT was sent (#54): the transport re-checked
 * the binding or the deadline immediately before the send and the transaction was rolled back,
 * or the deadline had passed when the send was about to start. Thrown only from there, so an
 * executor may report it as `not_committed` (a definite rejection). A failure of the COMMIT
 * request itself, or of anything after its send began, never uses it (ADR 0007). `cause` is the
 * underlying failure; it is never shown to a client.
 */
export class CommitNotSentError extends Error {
  constructor(cause: unknown) {
    super("COMMIT was not sent.", { cause });
  }
}

export const internalError = () => new EngineError("POLICYSQL_INTERNAL", "The request could not be completed.");

/**
 * A keyed execute refused before core (the session gate or a body limit) whose retry may be of
 * a write that committed under an earlier deployment: the unknown outcome, with the refusal as
 * `detail.cause` (ADR 0007 #85 and #100, ADR 0030). The message is the same fixed text as core's
 * (`Code::KeyedOutcomeUnknown`).
 */
export const outcomeUnknownError = (causeCode: string) => new EngineError(
  "POLICYSQL_OUTCOME_UNKNOWN",
  "This request was not executed. The outcome of an earlier request with the same Idempotency-Key is unknown.",
  null,
  // Both callers refuse before any statement is read, so there is no path to give.
  { cause: Object.freeze({ code: causeCode, path: null }) },
);

// A well-formed BLOB over the per-value limit is a permanent limit condition, not a
// transient database failure; both database transports use this same category. The
// HTTP transport also uses it for statement responses over its response-size bound.
export const binaryLimitExceeded = () => new EngineError(
  "POLICYSQL_LIMIT_EXCEEDED", "The request or result exceeded a configured limit.",
);

/** The public form of any thrown value: an EngineError as is, anything else as INTERNAL. */
export const operationError = (error: unknown): OperationError => error instanceof EngineError
  ? { code: error.code, message: error.message, path: error.path, ...(error.detail === undefined ? {} : { detail: error.detail }) }
  : { code: "POLICYSQL_INTERNAL", message: "The request could not be completed.", path: null };

/** Core's `{ error: { code, message, path } }` result as an EngineError, or null for a success. */
export const wasmError = (body: unknown): EngineError | null => {
  const envelope = (body as { error?: { code?: unknown; message?: unknown; path?: unknown } } | null)?.error;
  const code = envelope?.code;
  if (typeof code !== "string" || !code) return null;
  return new EngineError(
    code,
    typeof envelope?.message === "string" ? envelope.message : "The request could not be completed.",
    typeof envelope?.path === "string" ? envelope.path : null,
  );
};
