import { CommitNotSentError, EngineError, binaryLimitExceeded } from "./errors.ts";
import { remainingDatabaseTime } from "./database.ts";
import type { DatabaseTransportOptions } from "./database.ts";
import { BinaryLimitError, bytesLimit, decodeBlob, encodeBlob } from "./binary.ts";
import { discardBody, fetchNoFollow } from "./redirects.ts";
import type { OutboundFetch } from "./redirects.ts";
import { BodyTooLargeError, readBoundedText } from "./bounded-body.ts";
import { SqlComplexityError, statementFailure } from "./database-complexity.ts";

// Statement replies carry result rows: the result-side bound, replaced by the compiled raw
// bound in ADR 0027 pull request 6. Control replies (BEGIN, COMMIT, ROLLBACK, close) carry no
// result data, so their bound is a fixed protocol constant (ADR 0027 "Fixed protocol constants").
const STATEMENT_RESPONSE_BYTES = 2_097_152;
const CONTROL_RESPONSE_BYTES = 65_536;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
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
  // An integer beyond 2^53 - 1 that the step machine bound (ADR 0024 pull request 7, #70)
  // arrives as a BigInt and keeps its digits. SQLite integers are signed 64-bit.
  if (typeof value === "bigint" && value >= INT64_MIN && value <= INT64_MAX) {
    return { type: "integer", value: value.toString() };
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

  // `oversized` classifies a successful response over `maxResponseBytes`. Statement
  // execution passes a 413 limit error: only result rows (for example stored BLOBs)
  // make it that large, and retrying cannot shrink stored data. BEGIN and
  // COMMIT/ROLLBACK keep the 503 default and the 65,536-byte control bound, because an
  // oversized control response is a transport anomaly (a limit never applies to it) and a
  // COMMIT outcome must not be reported as a limit error or as not committed.
  //
  // The body is streamed and counted in bytes as it arrives (#53, src/bounded-body.ts):
  // a declared or received size over the bound cancels the stream instead of buffering
  // the rest. A read failure or malformed UTF-8 is a transport failure (503), and the
  // request's timeout also bounds the body read (504). None of these is a rejection, so a
  // COMMIT whose reply fails here is never reported as not committed (ADR 0007).
  async pipeline(requests, baton = undefined, timeoutMs = 1_000, oversized = databaseFailure, maxResponseBytes = CONTROL_RESPONSE_BYTES) {
    const signal = AbortSignal.timeout(timeoutMs);
    const timedOut = () => new EngineError("POLICYSQL_DATABASE_TIMEOUT", "The database operation timed out.");
    const isAbort = (error) => error?.name === "TimeoutError" || error?.name === "AbortError";
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
      signal,
    }, this.fetchImpl).catch((error) => {
      if (isAbort(error)) throw timedOut();
      throw databaseFailure();
    });
    if (!response.ok) {
      await discardBody(response);
      throw databaseFailure();
    }
    const text = await readBoundedText(response, maxResponseBytes, signal).catch((error) => {
      if (error instanceof BodyTooLargeError) throw oversized();
      if (isAbort(error)) throw timedOut();
      throw databaseFailure();
    });
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
  commitAttempted = false;
  readonly maxBytes: number;
  open: boolean;
  /** The reply to the last request on the stream was not read, so its baton is unknown (#96). */
  unusable = false;
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
    // Nothing is sent yet: an expired deadline or an unencodable value fails here, and the stream
    // stays usable (the baton is still the server's current one).
    const timeoutMs = Math.min(this.timeoutMs, remainingDatabaseTime(this.deadlineMs));
    const requests = statements.map((statement) => executeRequest(statement, this.maxBytes));
    let body;
    try {
      body = await this.transport.pipeline(
        requests,
        this.baton,
        timeoutMs,
        binaryLimitExceeded,
        STATEMENT_RESPONSE_BYTES,
      );
    } catch (error) {
      // The request may have run, but its reply, and with it the stream's next baton, was never
      // read (reply over the bound, malformed, wrong count, timeout, transport failure). The baton
      // held here is stale: a ROLLBACK sent with it is refused and would leave the transaction
      // open. The stream is unusable; the server expires it (#96).
      this.unusable = true;
      throw error;
    }
    if (!body.baton) { this.unusable = true; throw databaseFailure(); }
    // The stream's next baton comes first, even when a statement was refused: the rollback that
    // follows a refusal must continue this stream with the baton of this reply, or the server
    // keeps the transaction (and its write lock) open until the stream expires.
    this.baton = body.baton;
    // The Hrana error object of a refused statement is read here, and only for statement
    // requests (never BEGIN, COMMIT, or ROLLBACK): the first refused statement decides, and its
    // message is read only to classify it (src/database-complexity.ts).
    const errors = body.results.flatMap((entry, index) => (entry?.type === "error" ? [index] : []));
    if (errors.length > 0) {
      // Hrana runs the rest of the pipeline after an error. The refusal is a complexity refusal
      // only when it is the one error and the last statement: then nothing ran after it, so no
      // statement could have committed or rolled the transaction back behind the client's back.
      // Anything else (a second error, or a statement that ran after the refused one) keeps the
      // unclassified 503, whose outcome is not a definite rejection.
      const [refused] = errors;
      const alone = errors.length === 1 && refused === body.results.length - 1;
      const failure = statementFailure(body.results[refused].error, refused);
      // The message is dropped so that the failure cannot classify as complexity.
      throw alone || !(failure instanceof SqlComplexityError)
        ? failure
        : statementFailure({ code: body.results[refused].error?.code }, refused);
    }
    const results = body.results.map((entry) => decodeResult(entry, this.maxBytes));
    this.usage.push(...results.map((result) => result.usage));
    return results;
  }

  async finish(sql) {
    if (!this.open) return;
    // A stream whose last reply was never read cannot be continued: nothing is sent, and the
    // server expires the stream (and with it the transaction). COMMIT is never skipped this way:
    // it is only reachable after a successful statement, and a failed one is rolled back instead.
    if (this.unusable && sql === "ROLLBACK") {
      this.open = false;
      return;
    }
    if (this.unusable) throw new CommitNotSentError(databaseFailure());
    // Cleanup still gets a bounded attempt after the execution deadline expires. For COMMIT the
    // deadline is read before the request is built, so an expired deadline here is a failure
    // before any byte was sent: `CommitNotSentError` (#54), after which the caller rolls back
    // (the transport wrapper does). The pipeline call below is the send; whatever it throws is
    // never that.
    let timeoutMs = this.timeoutMs;
    if (sql === "COMMIT") {
      // A second COMMIT after one was handed to the pipeline is never "not sent" (unknown).
      if (this.commitAttempted) throw databaseFailure();
      try { timeoutMs = Math.min(timeoutMs, remainingDatabaseTime(this.deadlineMs)); } catch (error) {
        throw new CommitNotSentError(error);
      }
    }
    if (sql === "COMMIT") this.commitAttempted = true;
    const body = await this.transport.pipeline(
      [executeRequest({ sql }, this.maxBytes), { type: "close" }],
      this.baton,
      timeoutMs,
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
