import { HttpError } from "./errors.ts";

const MAX_RESPONSE_BYTES = 2_097_152;
const databaseFailure = () =>
  new HttpError(503, "POLICYSQL_DATABASE_UNAVAILABLE", "The database is temporarily unavailable.");

const encodeValue = (value) => {
  if (value === null) return { type: "null" };
  if (typeof value === "string") return { type: "text", value };
  if (typeof value === "boolean") return { type: "integer", value: value ? "1" : "0" };
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return { type: "integer", value: String(value) };
  }
  if (typeof value === "number" && Number.isFinite(value)) return { type: "float", value };
  if (value instanceof Uint8Array) {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return { type: "blob", base64: btoa(binary) };
  }
  throw new HttpError(500, "POLICYSQL_INTERNAL", "The request could not be completed.");
};

const decodeValue = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw databaseFailure();
  if (value.type === "null") return null;
  if (value.type === "text" && typeof value.value === "string") return value.value;
  if (value.type === "integer" && typeof value.value === "string" && /^-?\d+$/.test(value.value)) {
    const number = Number(value.value);
    if (!Number.isSafeInteger(number)) throw databaseFailure();
    return number;
  }
  if (value.type === "float" && typeof value.value === "number" && Number.isFinite(value.value)) {
    return value.value;
  }
  if (value.type === "blob" && typeof value.base64 === "string") {
    let binary;
    try { binary = atob(value.base64); } catch { throw databaseFailure(); }
    return Uint8Array.from(binary, (character: string) => character.charCodeAt(0));
  }
  throw databaseFailure();
};

const executeRequest = ({ sql, args = {} }) => ({
  type: "execute",
  stmt: {
    sql,
    named_args: Object.entries(args).map(([name, value]) => ({ name, value: encodeValue(value) })),
  },
});

const decodeResult = (entry) => {
  if (entry?.type !== "ok" || entry.response?.type !== "execute") throw databaseFailure();
  const result = entry.response.result;
  if (
    !result ||
    !Array.isArray(result.cols) ||
    !Array.isArray(result.rows) ||
    !Number.isSafeInteger(result.affected_row_count) ||
    result.affected_row_count < 0 ||
    !Number.isSafeInteger(result.rows_read) ||
    result.rows_read < 0 ||
    !Number.isSafeInteger(result.rows_written) ||
    result.rows_written < 0 ||
    typeof result.query_duration_ms !== "number" ||
    !Number.isFinite(result.query_duration_ms) ||
    result.query_duration_ms < 0
  ) throw databaseFailure();
  const columns = result.cols.map((column) => {
    if (!column || typeof column.name !== "string") throw databaseFailure();
    return column.name;
  });
  if (new Set(columns).size !== columns.length) throw databaseFailure();
  const rows = result.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) throw databaseFailure();
    return row.map(decodeValue);
  });
  return {
    columns,
    rows,
    rowsAffected: result.affected_row_count,
    usage: {
      rowsRead: result.rows_read,
      rowsWritten: result.rows_written,
      queryDurationMs: result.query_duration_ms,
    },
  };
};

export class TursoHttpTransport {
  readonly url: string;
  readonly token: string;
  readonly requestId: string;
  readonly fetchImpl: typeof fetch;

  constructor(env, requestId, fetchImpl = undefined) {
    if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) throw databaseFailure();
    const url = new URL(env.TURSO_DATABASE_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw databaseFailure();
    }
    this.url = new URL("/v2/pipeline", url).toString();
    this.token = env.TURSO_AUTH_TOKEN;
    this.requestId = requestId;
    // Cloudflare requires its host fetch receiver; test adapters remain ordinary functions.
    this.fetchImpl = fetchImpl
      ? (input, init) => fetchImpl(input, init)
      : (input, init) => globalThis.fetch(input, init);
  }

  async pipeline(requests, baton = undefined, timeoutMs = 1_000) {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-turso-request-identity": this.requestId,
      },
      body: JSON.stringify({ ...(baton ? { baton } : {}), requests }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error) => {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new HttpError(504, "POLICYSQL_DATABASE_TIMEOUT", "The database operation timed out.");
      }
      throw databaseFailure();
    });
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw databaseFailure();
    const text = await response.text();
    if (!response.ok || text.length > MAX_RESPONSE_BYTES) throw databaseFailure();
    let body;
    try { body = JSON.parse(text); } catch { throw databaseFailure(); }
    if (
      !body ||
      !Array.isArray(body.results) ||
      body.results.length !== requests.length ||
      !(body.baton === null || typeof body.baton === "string")
    ) throw databaseFailure();
    return body;
  }

  async begin(mode, timeoutMs) {
    const body = await this.pipeline(
      [executeRequest({ sql: mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED" })],
      undefined,
      timeoutMs,
    );
    const beginResult = decodeResult(body.results[0]);
    if (!body.baton) throw databaseFailure();
    return new TursoHttpTransaction(this, body.baton, timeoutMs, beginResult.usage);
  }
}

class TursoHttpTransaction {
  readonly transport: TursoHttpTransport;
  baton: string;
  readonly timeoutMs: number;
  open: boolean;
  readonly usage: any[];

  constructor(transport, baton, timeoutMs, beginUsage) {
    this.transport = transport;
    this.baton = baton;
    this.timeoutMs = timeoutMs;
    this.open = true;
    this.usage = [beginUsage];
  }

  async execute(statements) {
    if (!this.open) throw databaseFailure();
    const body = await this.transport.pipeline(
      statements.map(executeRequest),
      this.baton,
      this.timeoutMs,
    );
    if (!body.baton) throw databaseFailure();
    this.baton = body.baton;
    const results = body.results.map(decodeResult);
    this.usage.push(...results.map((result) => result.usage));
    return results;
  }

  async finish(sql) {
    if (!this.open) return;
    const body = await this.transport.pipeline(
      [executeRequest({ sql }), { type: "close" }],
      this.baton,
      this.timeoutMs,
    );
    const terminal = decodeResult(body.results[0]);
    this.usage.push(terminal.usage);
    if (body.results[1]?.type !== "ok" || body.results[1].response?.type !== "close") {
      throw databaseFailure();
    }
    this.open = false;
  }

  commit() { return this.finish("COMMIT"); }
  rollback() { return this.finish("ROLLBACK"); }
}
