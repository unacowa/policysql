import { EngineError, binaryLimitExceeded } from "./errors.ts";
import { remainingDatabaseTime } from "./database.ts";
import type { DatabaseTransportOptions } from "./database.ts";
import { BinaryLimitError, bytesLimit, decodeBlob, encodeBlob } from "./binary.ts";
import { discardBody, fetchNoFollow } from "./redirects.ts";
import type { OutboundFetch } from "./redirects.ts";

const MAX_RESPONSE_BYTES = 2_097_152;
const databaseFailure = () =>
  new EngineError("POLICYSQL_DATABASE_UNAVAILABLE", "The database is temporarily unavailable.");

// `maxBytes` comes from the runtime through DatabaseTransportOptions. Without it the
// transport validates BLOB encoding only, inside the bounded HTTP response, and
// PolicySQL classifies size with the runtime limit before WASM (rawDriverValue).
const encodeValue = (value, maxBytes: number) => {
  if (value === null) return { type: "null" };
  if (typeof value === "string") return { type: "text", value };
  if (typeof value === "boolean") return { type: "integer", value: value ? "1" : "0" };
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return { type: "integer", value: String(value) };
  }
  if (typeof value === "number" && Number.isFinite(value)) return { type: "float", value };
  if (value instanceof Uint8Array) {
    return { type: "blob", base64: encodeBlob(value, maxBytes) };
  }
  throw new EngineError("POLICYSQL_INTERNAL", "The request could not be completed.");
};

// Hrana may omit padding in database BLOB responses. Keep that protocol rule
// here; the public contract and private WASM ABI still require canonical padding.
const decodeHranaBlob = (value: string, maxBytes: number): Uint8Array => {
  const remainder = value.length % 4;
  if (remainder !== 0) {
    if (remainder === 1 || value.includes("=")) throw databaseFailure();
    value += "=".repeat(4 - remainder);
  }
  return decodeBlob(value, maxBytes);
};

const decodeValue = (value, maxBytes: number) => {
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
    try { return decodeHranaBlob(value.base64, maxBytes); } catch (error) {
      if (error instanceof BinaryLimitError) throw binaryLimitExceeded();
      throw databaseFailure();
    }
  }
  throw databaseFailure();
};

const executeRequest = ({ sql, args = {} }, maxBytes: number) => ({
  type: "execute",
  stmt: {
    sql,
    named_args: Object.entries(args).map(([name, value]) => ({ name, value: encodeValue(value, maxBytes) })),
  },
});

const decodeResult = (entry, maxBytes: number) => {
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
    return row.map((value) => decodeValue(value, maxBytes));
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
  readonly fetchImpl?: OutboundFetch;

  constructor(connection: { url: string; authToken: string }, requestId, fetchImpl: OutboundFetch | undefined = undefined) {
    if (!connection?.url || !connection?.authToken) throw databaseFailure();
    const url = new URL(connection.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw databaseFailure();
    }
    this.url = new URL("/v2/pipeline", url).toString();
    this.token = connection.authToken;
    this.requestId = requestId;
    // Omitted: fetchNoFollow uses the host fetch with its required receiver.
    this.fetchImpl = fetchImpl;
  }

  // `oversized` classifies a successful response over MAX_RESPONSE_BYTES. Statement
  // execution passes a 413 limit error: only result rows (for example stored BLOBs)
  // make it that large, and retrying cannot shrink stored data. BEGIN and
  // COMMIT/ROLLBACK keep the 503 default, because an oversized control response is
  // a transport anomaly and a COMMIT outcome must not be reported as a limit error.
  async pipeline(requests, baton = undefined, timeoutMs = 1_000, oversized = databaseFailure) {
    // fetchNoFollow never follows a redirect (it would forward the bearer token) and
    // rejects one unread; that rejection is a 503 like any other transport failure.
    const response = await fetchNoFollow(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-turso-request-identity": this.requestId,
      },
      body: JSON.stringify({ ...(baton ? { baton } : {}), requests }),
      signal: AbortSignal.timeout(timeoutMs),
    }, this.fetchImpl).catch((error) => {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new EngineError("POLICYSQL_DATABASE_TIMEOUT", "The database operation timed out.");
      }
      throw databaseFailure();
    });
    if (!response.ok) {
      await discardBody(response);
      throw databaseFailure();
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await discardBody(response);
      throw oversized();
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw oversized();
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

  async begin(mode, timeoutMs, deadlineMs: number | undefined, options: DatabaseTransportOptions) {
    // The runtime's per-value limit is required. An omitted or malformed limit fails
    // closed before any request, so a direct caller cannot disable the BLOB bound.
    const maxBytes = bytesLimit(options?.maxBytesPerValue);
    const body = await this.pipeline(
      [executeRequest({ sql: mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED" }, maxBytes)],
      undefined,
      Math.min(timeoutMs, remainingDatabaseTime(deadlineMs)),
    );
    const beginResult = decodeResult(body.results[0], maxBytes);
    if (!body.baton) throw databaseFailure();
    return new TursoHttpTransaction(this, body.baton, timeoutMs, beginResult.usage, deadlineMs, maxBytes);
  }
}

class TursoHttpTransaction {
  readonly transport: TursoHttpTransport;
  baton: string;
  readonly timeoutMs: number;
  readonly deadlineMs?: number;
  readonly maxBytes: number;
  open: boolean;
  readonly usage: any[];

  constructor(transport, baton, timeoutMs, beginUsage, deadlineMs: number | undefined, maxBytes: number) {
    this.transport = transport;
    this.baton = baton;
    this.timeoutMs = timeoutMs;
    this.deadlineMs = deadlineMs;
    this.maxBytes = maxBytes;
    this.open = true;
    this.usage = [beginUsage];
  }

  async execute(statements) {
    if (!this.open) throw databaseFailure();
    const body = await this.transport.pipeline(
      statements.map((statement) => executeRequest(statement, this.maxBytes)),
      this.baton,
      Math.min(this.timeoutMs, remainingDatabaseTime(this.deadlineMs)),
      binaryLimitExceeded,
    );
    if (!body.baton) throw databaseFailure();
    this.baton = body.baton;
    const results = body.results.map((entry) => decodeResult(entry, this.maxBytes));
    this.usage.push(...results.map((result) => result.usage));
    return results;
  }

  async finish(sql) {
    if (!this.open) return;
    const body = await this.transport.pipeline(
      [executeRequest({ sql }, this.maxBytes), { type: "close" }],
      this.baton,
      // Cleanup still gets a bounded attempt after the execution deadline expires.
      sql === "ROLLBACK" ? this.timeoutMs : Math.min(this.timeoutMs, remainingDatabaseTime(this.deadlineMs)),
    );
    const terminal = decodeResult(body.results[0], this.maxBytes);
    this.usage.push(terminal.usage);
    if (body.results[1]?.type !== "ok" || body.results[1].response?.type !== "close") {
      throw databaseFailure();
    }
    this.open = false;
  }

  commit() { return this.finish("COMMIT"); }
  rollback() { return this.finish("ROLLBACK"); }
}
