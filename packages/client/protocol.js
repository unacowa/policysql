import { validReply, safeErrorDetails } from '../transport/index.js';

export class PolicySqlError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "PolicySqlError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export class PolicySqlOutcomeUnknownError extends PolicySqlError {
  constructor({ transactionId, phase, sequence }) {
    super("The outcome of the PolicySQL request is unknown.", "POLICYSQL_OUTCOME_UNKNOWN");
    this.name = "PolicySqlOutcomeUnknownError";
    this.phase = phase;
    if (transactionId !== undefined) this.transactionId = transactionId;
    if (sequence !== undefined) this.sequence = sequence;
  }
}

export const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const protocolError = () => new PolicySqlError("Invalid PolicySQL response.", "POLICYSQL_INVALID_RESPONSE");
export const unavailable = () => new PolicySqlError("The transaction is no longer active.", "POLICYSQL_TRANSACTION_UNAVAILABLE");
export const required = (value, name) => {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
};
export const validateKey = (key) => {
  if (key !== undefined && (typeof key !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(key))) {
    throw new TypeError("idempotencyKey must contain 16-128 letters, digits, dots, underscores, colons, or hyphens");
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
export const retryable = (error) => error?.code === "POLICYSQL_TRANSPORT_ERROR" ||
  error?.code === "POLICYSQL_TRANSPORT_DISCONNECTED" || error?.code === "POLICYSQL_TRANSPORT_PROTOCOL_ERROR" ||
  error?.code === "POLICYSQL_INVALID_RESPONSE" || error?.status >= 500;
export const unknown = (tx, phase, sequence) => new PolicySqlOutcomeUnknownError({ transactionId: tx, phase, sequence });


export const transportError = (code = 'POLICYSQL_TRANSPORT_ERROR', delivery = 'possibly-sent') => {
  const error = new PolicySqlError('PolicySQL transport failed.', code);
  error.delivery = delivery;
  return error;
};
export const uncertain = error => error?.delivery === 'possibly-sent' ||
  (error?.delivery !== 'not-sent' && (retryable(error) || error?.code === 'POLICYSQL_OUTCOME_UNKNOWN'));

export async function sendOperation(operation, signal) {
  let reply;
  try { reply = await operation.send({ signal }); }
  catch { throw transportError(); }
  try {
    reply = copyJson(reply);
    if (!validReply(reply)) throw 0;
  } catch { throw transportError('POLICYSQL_TRANSPORT_PROTOCOL_ERROR'); }
  if (reply.type === 'failure') throw transportError(reply.code, reply.delivery);
  if (reply.status < 200 || reply.status >= 300) {
    const diagnostic = safeErrorDetails(reply.body?.error);
    const error = new PolicySqlError('PolicySQL request failed.', diagnostic.code, reply.status);
    Object.assign(error, diagnostic);
    throw error;
  }
  if (!object(reply.body)) throw protocolError();
  return reply.body;
}

let nextCommandId = 0;
export const command = (kind, body, transactionId, idempotencyKey) => Object.freeze({
  commandId: `command_${++nextCommandId}`,
  target: Object.freeze({ kind, ...(transactionId === undefined ? {} : { transactionId }) }),
  ...(body === undefined ? {} : { body }),
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
});
export const signalOptions = (options = {}) => {
  if (!object(options) || Object.keys(options).some(key => key !== 'signal')) throw new TypeError('invalid command options');
  return options.signal;
};
