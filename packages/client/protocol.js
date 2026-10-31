export class PolicySqlError extends Error {
  constructor(message, code, status, options) {
    super(message, options);
    this.name = "PolicySqlError";
    this.code = code;
    if (status !== undefined) this.status = status;
    if (options?.response !== undefined) this.response = options.response;
  }
}

export class PolicySqlOutcomeUnknownError extends PolicySqlError {
  constructor({ transactionId, phase, sequence }, options) {
    super("The outcome of the PolicySQL request is unknown.", "POLICYSQL_OUTCOME_UNKNOWN", undefined, options);
    this.name = "PolicySqlOutcomeUnknownError";
    this.phase = phase;
    if (transactionId !== undefined) this.transactionId = transactionId;
    if (sequence !== undefined) this.sequence = sequence;
  }
}

export const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const protocolError = (options) => new PolicySqlError("Invalid PolicySQL response.", "POLICYSQL_INVALID_RESPONSE", undefined, options);
export const unavailable = () => new PolicySqlError("The transaction is no longer active.", "POLICYSQL_TRANSACTION_UNAVAILABLE");
export const required = (value, name) => {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
};
export const validateKey = (key) => {
  if (key !== undefined && (typeof key !== "string" || !/^[A-Za-z0-9._:+\/=-]{16,128}$/.test(key))) {
    throw new TypeError("idempotencyKey must be 16-128 characters from letters, digits, and . _ : - + / =");
  }
  return key;
};
export const validateExpect = (expect) => {
  if (expect === undefined) return undefined;
  if (!object(expect) || Object.keys(expect).length === 0 ||
    Object.keys(expect).some((key) => !["affectedRows", "rowCount"].includes(key) ||
      !Number.isSafeInteger(expect[key]) || expect[key] < 0)) throw new TypeError("invalid expect");
  return Object.freeze({ ...expect });
};

// Do not let JSON.stringify silently drop invalid values or invoke application toJSON hooks.
export const copyJson = (value, depth = 0) => {
  if (depth > 64) throw new TypeError("JSON value is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from(value, (item) => copyJson(item, depth + 1));
  if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyJson(item, depth + 1)]));
  }
  throw new TypeError("parameters must contain only JSON values");
};
export const statement = (sql, params, expect) => {
  required(sql, "sql");
  if (!object(params)) throw new TypeError("params must be an object");
  const expectation = validateExpect(expect);
  return { sql, params: copyJson(params), ...(expectation === undefined ? {} : { expect: expectation }) };
};
export const validateResult = (result) => {
  if (!object(result) || !Array.isArray(result.rows) || !result.rows.every(object) || !object(result.meta) ||
    (result.columns !== undefined && (!Array.isArray(result.columns) ||
      !result.columns.every((column) => typeof column === "string" && column.length > 0) ||
      new Set(result.columns).size !== result.columns.length)) ||
    (result.rowCount !== undefined && result.rowCount !== result.rows.length) ||
    (result.affectedRows !== undefined && (!Number.isSafeInteger(result.affectedRows) || result.affectedRows < 0))) {
    throw protocolError();
  }
  return result;
};
export const validateRole = (role) => {
  if (role !== undefined && (typeof role !== "string" || !/^[a-z][a-z0-9_]*$/.test(role))) {
    throw new TypeError("role must be a valid role identifier");
  }
  return role;
};

export const validateOptions = (options, keys) => {
  if (!object(options) || Object.keys(options).some((key) => !keys.includes(key))) throw new TypeError("invalid options");
};

// Preserve public information without filling in missing fields to manufacture
// evidence about execution from an invalid response.
export const readResponse = (response) => {
  if (!object(response) || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw protocolError();
  let body;
  try { body = copyJson(response.body); } catch (cause) { throw protocolError({ cause }); }
  const snapshot = { status: response.status, body };
  if (!object(body)) throw protocolError({ response: snapshot });
  if (response.status >= 200 && response.status < 300) return snapshot;
  const error = body.error;
  if (!object(error) || typeof error.code !== "string" || !/^POLICYSQL_[A-Z0-9_]+$/.test(error.code) ||
    typeof error.message !== "string" || !(error.path === null || typeof error.path === "string") ||
    typeof error.requestId !== "string") throw protocolError({ response: snapshot });
  return { ...snapshot, error: new PolicySqlError(error.message, error.code, response.status, { response: snapshot }) };
};

// Only documented code/status pairs establish rejection. Status alone, unknown
// errors and exceptions thrown by a Transport cannot establish execution outcome.
// Every pair is the one in the public status table (website/api/errors.md); a server test
// checks that.
export const REJECTIONS = new Map([
  [401, ["UNAUTHENTICATED", "AUTHENTICATION_FAILED"]],
  [403, ["FORBIDDEN_ACCESS", "MISSING_POLICY", "FORBIDDEN_OPERATION", "FORBIDDEN_COLUMN",
    "FORBIDDEN_COLUMN_CONTEXT", "PRESET_COLUMN", "TRANSACTION_MODE_VIOLATION"]],
  [400, ["INVALID_REQUEST", "INVALID_SQL", "MULTIPLE_STATEMENTS", "UNSUPPORTED_SQL", "DUPLICATE_RESULT_COLUMN",
    "INVALID_PARAMETER", "AMBIGUOUS_PARAMETER_TYPE", "RESERVED_PARAMETER", "IDEMPOTENCY_KEY_INVALID"]],
  [409, ["STALE_OPERATION", "IDEMPOTENCY_CONFLICT", "TRANSACTION_CONFLICT", "TRANSACTION_UNAVAILABLE", "COMMIT_CHECK_REJECTED"]],
  [413, ["LIMIT_EXCEEDED", "REQUEST_TOO_LARGE", "TRANSACTION_LIMIT_EXCEEDED"]],
  [422, ["EXPECTATION_FAILED", "SCHEMA_MISMATCH"]],
]);

const sqlRejections = new Set([
  "MISSING_POLICY", "FORBIDDEN_OPERATION", "FORBIDDEN_COLUMN", "FORBIDDEN_COLUMN_CONTEXT",
  "INVALID_SQL", "MULTIPLE_STATEMENTS", "UNSUPPORTED_SQL", "DUPLICATE_RESULT_COLUMN", "INVALID_PARAMETER",
  "AMBIGUOUS_PARAMETER_TYPE", "RESERVED_PARAMETER", "PRESET_COLUMN", "EXPECTATION_FAILED", "SCHEMA_MISMATCH",
]);
const rejectsCommand = ({ error, status }, kind) => {
  const code = error.code.slice("POLICYSQL_".length);
  if (!REJECTIONS.get(status)?.includes(code)) return false;
  if (sqlRejections.has(code)) return kind === "execute" || kind === "statement";
  if (code === "IDEMPOTENCY_CONFLICT") return kind === "execute";
  // A key rejected before any database work: the client sends a key only on execute (default deny for other kinds).
  if (code === "IDEMPOTENCY_KEY_INVALID") return kind === "execute";
  if (code === "COMMIT_CHECK_REJECTED") return kind === "execute" || kind === "commit";
  if (code === "TRANSACTION_MODE_VIOLATION") return kind === "statement";
  // Atomic commit checks also run through a transaction owner.
  // The server sends this only for an interactive statement (a callback's limit reaches the validator,
  // and the commit answers 409 COMMIT_CHECK_REJECTED), so it proves nothing for any other command.
  if (code === "TRANSACTION_LIMIT_EXCEEDED") return kind === "statement";
  if (code.startsWith("TRANSACTION_")) return ["execute", "statement", "commit", "rollback"].includes(kind);
  return true;
};

export const sendCommand = async (transport, request, context, validate, signal) => {
  signal?.throwIfAborted();
  const uncertain = (cause) => new PolicySqlOutcomeUnknownError(context, { cause });
  let response;
  try { response = readResponse(await transport(request, { signal })); }
  catch (cause) { throw uncertain(cause); }
  if (response.error) {
    if (rejectsCommand(response, request.kind)) throw response.error;
    throw uncertain(response.error);
  }
  try {
    if (response.status !== (request.kind === "begin" ? 201 : 200)) throw protocolError({ response });
    validate(response.body);
  } catch (cause) {
    if (cause instanceof PolicySqlError && cause.response === undefined) {
      cause.response = { status: response.status, body: response.body };
    }
    throw uncertain(cause);
  }
  return response.body;
};
