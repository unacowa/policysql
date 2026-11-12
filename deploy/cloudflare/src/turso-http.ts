import { CommitNotSentError, EngineError, binaryLimitExceeded } from "./errors.ts";
import { remainingDatabaseTime } from "./database.ts";
import type { DatabaseExecuteOptions, DatabaseResult, DatabaseTransportOptions, DatabaseUsage } from "./database.ts";
import { BinaryLimitError, bytesLimit, decodeBlob, encodeBlob } from "./binary.ts";
import { discardBody, fetchNoFollow } from "./redirects.ts";
import type { OutboundFetch } from "./redirects.ts";
import { BodyTooLargeError, readBoundedText } from "./bounded-body.ts";
import { statementFailure, unclassifiedFailure } from "./database-complexity.ts";

// The statement batch reply carries result rows: its read cap comes with each call (core's compiled
// raw result bound, ADR 0027). Control replies (BEGIN, COMMIT, ROLLBACK, close) carry no result data,
// so their bound is a fixed protocol constant (ADR 0027 "Fixed protocol constants").
const CONTROL_RESPONSE_BYTES = 65_536;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
// A reply the transport refuses or cannot finish reading (over its bound, malformed, wrong
// count, a read error, or a timeout after its first bytes) still starts with the stream's next
// baton: `{"baton":"...","base_url":...,"results":[...]}` (observed on real Turso). It is read
// from the leading bytes and attached to the failure, so the rollback that follows can continue
// the stream instead of leaving the transaction, and its write lock, open (#96, #97). The text is
// parsed only for that field and never kept, logged, or shown.
const BATON_PREFIX = /^\s*\{\s*"baton"\s*:\s*"([^"\\]{1,512})"/u;
const BATON_LENGTH = 512;
const validBaton = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= BATON_LENGTH;
const withBaton = <T extends Error>(error: T, leading: string): T => {
  const baton = BATON_PREFIX.exec(leading)?.[1];
  if (validBaton(baton)) (error as { nextBaton?: string }).nextBaton = baton;
  return error;
};
// A parsed reply's baton needs no key-order-dependent pattern (#97).
const withReplyBaton = <T extends Error>(error: T, body: unknown): T => {
  const baton = (body as { baton?: unknown } | null | undefined)?.baton;
  if (validBaton(baton)) (error as { nextBaton?: string }).nextBaton = baton;
  return error;
};
// The only record of a stream cleanup: its outcome, never the baton or reply text. `rolled_back`
// means the stream was released; `refused` and `failed` mean the transaction, with any write
// lock, may remain until the server expires the stream (ADR 0027, "Baton recovery").
const logStreamRecovery = (requestId: string, outcome: string) => {
  console.log(JSON.stringify({ event: "database_stream_recovery", requestId, outcome }));
};
// A batch reply that breaks the conditional-batch contract (a step after the first error ran or
// errored, a step before it did not run, a malformed error) is logged once with a fixed reason: a
// write may have committed after the refusal, and this is the only signal of it. Never the baton,
// a message, or SQL.
const logProtocolViolation = (requestId: string, reason: string) => {
  console.log(JSON.stringify({ event: "database_protocol_violation", requestId, reason }));
};
const databaseFailure = () =>
  new EngineError("POLICYSQL_DATABASE_UNAVAILABLE", "The database is temporarily unavailable.");

// `maxBytes` comes from the runtime through DatabaseTransportOptions. Without it the
// transport validates BLOB encoding only, inside the bounded HTTP response, and
// PolicySQL classifies size with the runtime limit before WASM (rawDriverValue).
//
// The Hrana wire shapes below are the transport's own output. They are narrow on purpose:
// everything the server sends back is `unknown` until `decodeResult` has checked it, so the
// emitted half can be typed and the received half cannot be trusted by construction.
type HranaValue =
  | { type: "null" }
  | { type: "text"; value: string }
  | { type: "integer"; value: string }
  | { type: "float"; value: number }
  | { type: "blob"; base64: string };

type HranaStatement = { sql: string; args?: Record<string, unknown> };
// An envelope's statements go out as one conditional batch (#144): each step runs only when the
// step before it succeeded. Hrana otherwise keeps running a pipeline after an error, and when
// SQLite itself closes the transaction on that error (`ON CONFLICT ROLLBACK`, `RAISE(ROLLBACK)`)
// every later statement would run in autocommit and commit behind the client's back. Only BEGIN,
// COMMIT, and ROLLBACK are sent as plain `execute` requests.
type HranaStmt = { sql: string; named_args: Array<{ name: string; value: HranaValue }> };
type BatchStep = { stmt: HranaStmt; condition?: { type: "ok"; step: number } };
type PipelineRequest =
  | { type: "execute"; stmt: HranaStmt }
  | { type: "batch"; batch: { steps: BatchStep[] } }
  | { type: "close" };
/** A parsed reply: its results are still unchecked, its baton is the only field read unvalidated. */
type PipelineReply = { readonly results: unknown[]; readonly baton: string | null };

const encodeValue = (value: unknown, maxBytes: number): HranaValue => {
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeValue = (value: unknown, maxBytes: number): unknown => {
  if (!isRecord(value)) throw databaseFailure();
  if (value.type === "null") return null;
  if (value.type === "text" && typeof value.value === "string") return value.value;
  if (value.type === "integer" && typeof value.value === "string" && /^-?\d+$/u.test(value.value)) {
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

const encodeStmt = ({ sql, args = {} }: HranaStatement, maxBytes: number): HranaStmt => ({
  sql,
  named_args: Object.entries(args).map(([name, value]) => ({ name, value: encodeValue(value, maxBytes) })),
});

const executeRequest = (statement: HranaStatement, maxBytes: number): PipelineRequest => ({
  type: "execute",
  stmt: encodeStmt(statement, maxBytes),
});

// Step 0 has no condition; step i runs only when step i - 1 succeeded, so one failure stops the
// whole chain (a step that did not run is not ok).
const batchRequest = (statements: HranaStatement[], maxBytes: number): PipelineRequest => ({
  type: "batch",
  batch: {
    steps: statements.map((statement, index): BatchStep => ({
      stmt: encodeStmt(statement, maxBytes),
      ...(index > 0 ? { condition: { type: "ok", step: index - 1 } as const } : {}),
    })),
  },
});

const decodeStmtResult = (result: unknown, maxBytes: number): DatabaseResult => {
  // `result` is the server's, checked field by field below.
  if (!isRecord(result)) throw databaseFailure();
  if (
    !Array.isArray(result.cols) ||
    !Array.isArray(result.rows) ||
    !Number.isSafeInteger(result.affected_row_count) ||
    (result.affected_row_count as number) < 0 ||
    !Number.isSafeInteger(result.rows_read) ||
    (result.rows_read as number) < 0 ||
    !Number.isSafeInteger(result.rows_written) ||
    (result.rows_written as number) < 0 ||
    typeof result.query_duration_ms !== "number" ||
    !Number.isFinite(result.query_duration_ms) ||
    result.query_duration_ms < 0
  ) throw databaseFailure();
  const columns = result.cols.map((column: unknown) => {
    if (!isRecord(column) || typeof column.name !== "string") throw databaseFailure();
    return column.name;
  });
  if (new Set(columns).size !== columns.length) throw databaseFailure();
  const rows = result.rows.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== columns.length) throw databaseFailure();
    return row.map((value: unknown) => decodeValue(value, maxBytes));
  });
  return {
    columns,
    rows,
    rowsAffected: result.affected_row_count as number,
    usage: {
      rowsRead: result.rows_read as number,
      rowsWritten: result.rows_written as number,
      queryDurationMs: result.query_duration_ms,
    },
  };
};

const decodeResult = (entry: unknown, maxBytes: number): DatabaseResult => {
  // `entry` is the server's: `entry.response.result` is checked in decodeStmtResult.
  const reply = isRecord(entry) && entry.type === "ok" && isRecord(entry.response) ? entry.response : undefined;
  if (reply?.type !== "execute" || !isRecord(reply.result)) throw databaseFailure();
  return decodeStmtResult(reply.result, maxBytes);
};

type BatchOutcome =
  | { readonly refused: null; readonly results: unknown[] }
  | { readonly refused: number; readonly error: Record<string, unknown> };

// Reads a batch reply. The server is not trusted to have honoured the conditions: any shape that
// is not exactly "steps before the first error ran, the error step errored, nothing after it ran"
// is a protocol violation, a plain 503 (never a classified refusal). A later step that ran, or a
// second error, means a write may have committed after the refusal (#144).
const readBatch = (entry: unknown, count: number, requestId: string): BatchOutcome => {
  // A top-level error is the whole batch failing (not a statement's step error): its code is kept
  // for the log, its message is never read, so it cannot classify as a complexity refusal.
  if (isRecord(entry) && entry.type === "error" && isRecord(entry.error)) throw unclassifiedFailure(entry.error);
  const response = isRecord(entry) && entry.type === "ok" && isRecord(entry.response) ? entry.response : undefined;
  if (response?.type !== "batch" || !isRecord(response.result)) throw databaseFailure();
  const { step_results: stepResults, step_errors: stepErrors } = response.result;
  if (!Array.isArray(stepResults) || !Array.isArray(stepErrors)) throw databaseFailure();
  if (stepResults.length !== count || stepErrors.length !== count) throw databaseFailure();
  const refused = stepErrors.findIndex((error) => error !== null);
  if (refused === -1) return { refused: null, results: stepResults };
  const violation = (reason: string): never => {
    logProtocolViolation(requestId, reason);
    throw databaseFailure();
  };
  for (let index = 0; index < count; index += 1) {
    if (index < refused && !isRecord(stepResults[index])) violation("step_before_error_not_run");
    if (index === refused && stepResults[index] !== null) violation("error_step_has_result");
    if (index === refused && !isRecord(stepErrors[index])) violation("error_not_object");
    if (index > refused && (stepResults[index] !== null || stepErrors[index] !== null)) violation("step_after_error_ran");
  }
  return { refused, error: stepErrors[refused] as Record<string, unknown> };
};

export class TursoHttpTransport {
  readonly url: string;
  readonly token: string;
  readonly requestId: string;
  readonly fetchImpl?: OutboundFetch;

  constructor(connection: { url: string; authToken: string }, requestId: string, fetchImpl: OutboundFetch | undefined = undefined) {
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
  //
  // `readDeclaredPrefix` asks for the leading bytes of a reply whose declared length is over the
  // bound, so the caller can recover its baton (#97). Statement execution asks for them because
  // its over-bound class is the 413 limit; BEGIN asks explicitly because its over-bound class is
  // the 503 default, but it still needs the baton to roll back a transaction the server started.
  async pipeline(
    requests: PipelineRequest[],
    baton: string | undefined = undefined,
    timeoutMs = 1_000,
    oversized: () => Error = databaseFailure,
    maxResponseBytes = CONTROL_RESPONSE_BYTES,
    readDeclaredPrefix = oversized !== databaseFailure,
  ): Promise<PipelineReply> {
    const signal = AbortSignal.timeout(timeoutMs);
    const timedOut = () => new EngineError("POLICYSQL_DATABASE_TIMEOUT", "The database operation timed out.");
    const isAbort = (error: unknown) => (error as { name?: unknown } | null)?.name === "TimeoutError"
      || (error as { name?: unknown } | null)?.name === "AbortError";
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
    // The leading bytes are kept for every failure, not only the over-bound one: a reply that
    // stalls or fails mid-body has already sent its baton (#97).
    const leading = { text: "" };
    const text = await readBoundedText(response, maxResponseBytes, signal, readDeclaredPrefix, leading).catch((error) => {
      if (error instanceof BodyTooLargeError) throw withBaton(oversized(), error.prefix);
      if (isAbort(error)) throw withBaton(timedOut(), leading.text);
      throw withBaton(databaseFailure(), leading.text);
    });
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw withBaton(databaseFailure(), text); }
    if (!isRecord(body) || !Array.isArray(body.results) || !(body.baton === null || typeof body.baton === "string")) {
      throw withBaton(databaseFailure(), text);
    }
    // The JSON is parsed, so the baton is read from it: no pattern and no key order (#97).
    if (body.results.length !== requests.length) throw withReplyBaton(databaseFailure(), body);
    return body as PipelineReply;
  }

  async begin(mode: "read" | "write", timeoutMs: number, deadlineMs: number | undefined, options: DatabaseTransportOptions) {
    // The runtime's per-value limit is required. An omitted or malformed limit fails
    // closed before any request, so a direct caller cannot disable the BLOB bound.
    const maxBytes = bytesLimit(options?.maxBytesPerValue);
    let body;
    try {
      body = await this.pipeline(
        [executeRequest({ sql: mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED" }, maxBytes)],
        undefined,
        Math.min(timeoutMs, remainingDatabaseTime(deadlineMs)),
        databaseFailure,
        CONTROL_RESPONSE_BYTES,
        true,
      );
    } catch (error) {
      // A BEGIN reply can name the stream's next baton even when the reply is refused or cannot
      // be read; the server may already have started the transaction (BEGIN IMMEDIATE takes the
      // write lock). One bounded best-effort rollback+close through that baton, then rethrow the
      // original failure. A reply whose headers never arrived carries no baton: if the server
      // runs BEGIN later, that transaction stays until the stream expires (ADR 0027).
      const next = (error as { nextBaton?: unknown } | null)?.nextBaton;
      if (validBaton(next)) await this.recoverStream(next, maxBytes, timeoutMs);
      throw error;
    }
    let beginResult: DatabaseResult;
    try {
      beginResult = decodeResult(body.results[0], maxBytes);
    } catch (error) {
      // The reply parsed and named the stream's baton, but its result is unusable. The server
      // may have started the transaction, so roll it back through the baton before rethrowing.
      if (validBaton(body.baton)) await this.recoverStream(body.baton, maxBytes, timeoutMs);
      throw error;
    }
    if (!body.baton) throw databaseFailure();
    return new TursoHttpTransaction(this, body.baton, timeoutMs, beginResult.usage, deadlineMs, maxBytes);
  }

  /**
   * One bounded best-effort ROLLBACK+close on a stream whose baton is known (#97): a failed
   * BEGIN (before a transaction object exists) and an abandoned transaction both use it. Never
   * throws: the caller's failure is already terminal. Logs only the outcome, never the baton.
   */
  async recoverStream(baton: string, maxBytes: number, timeoutMs: number): Promise<DatabaseUsage | null> {
    let outcome = "refused";
    let usage: DatabaseUsage | null = null;
    try {
      const body = await this.pipeline(
        [executeRequest({ sql: "ROLLBACK" }, maxBytes), { type: "close" }],
        baton,
        timeoutMs,
      );
      usage = decodeResult(body.results[0], maxBytes).usage;
      const close = body.results[1];
      if (isRecord(close) && close.type === "ok" && isRecord(close.response) && close.response.type === "close") {
        outcome = "rolled_back";
      }
    } catch { /* best effort: the stream is abandoned either way */ }
    logStreamRecovery(this.requestId, outcome);
    return usage;
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
  /** The reply was read and its baton was null: the server ended the stream, so nothing is left to roll back (#144). */
  streamEnded = false;
  readonly usage: DatabaseUsage[];

  constructor(
    transport: TursoHttpTransport,
    baton: string,
    timeoutMs: number,
    beginUsage: DatabaseUsage,
    deadlineMs: number | undefined,
    maxBytes: number,
  ) {
    this.transport = transport;
    this.baton = baton;
    this.timeoutMs = timeoutMs;
    this.deadlineMs = deadlineMs;
    this.maxBytes = maxBytes;
    this.open = true;
    this.usage = [beginUsage];
  }

  async execute(statements: HranaStatement[], options: DatabaseExecuteOptions): Promise<DatabaseResult[]> {
    if (!this.open) throw databaseFailure();
    // The read cap is core's. An omitted or malformed one fails closed before any request, so a
    // direct caller cannot read an unbounded reply.
    const readCap = options?.maxResponseBytes;
    if (!Number.isSafeInteger(readCap) || readCap <= 0) throw databaseFailure();
    // Nothing is sent yet: an expired deadline or an unencodable value fails here, and the stream
    // stays usable (the baton is still the server's current one).
    const timeoutMs = Math.min(this.timeoutMs, remainingDatabaseTime(this.deadlineMs));
    const requests = [batchRequest(statements, this.maxBytes)];
    let body: PipelineReply;
    try {
      body = await this.transport.pipeline(
        requests,
        this.baton,
        timeoutMs,
        binaryLimitExceeded,
        readCap,
      );
    } catch (error) {
      // The reply was refused or never read. The baton held here may be stale (the request may
      // have run), but the reply's leading bytes almost always carry the next one: the stream
      // continues from it (a reply over the bound, malformed, the wrong count, or one that
      // stalled or failed after its first bytes). Only when no baton was read is the stream
      // unusable; the rollback then makes one bounded best-effort attempt with the stale baton
      // (finish, #97), and the server may still expire the stream.
      const next = (error as { nextBaton?: unknown } | null)?.nextBaton;
      if (validBaton(next)) this.baton = next; else this.unusable = true;
      throw error;
    }
    if (!body.baton) {
      this.unusable = true;
      this.streamEnded = true;
      // Real Turso ends the stream (`baton: null`) when SQLite itself closed the transaction on the
      // error (`ON CONFLICT ROLLBACK`, `RAISE(ROLLBACK)`), and the reply is still the batch reply.
      // It is read so the refusal keeps its code, but never classified as a complexity refusal: a
      // stream that ended gives no evidence that the steps before the error ran inside a
      // transaction, so the refusal is not definite. Nothing more is sent on the ended stream, and
      // a success without a baton is a plain 503 that is logged (a statement may have run outside
      // a transaction).
      const ended = readBatch(body.results[0], statements.length, this.transport.requestId);
      if (ended.refused !== null) throw unclassifiedFailure(ended.error);
      logProtocolViolation(this.transport.requestId, "stream_ended_without_error");
      throw databaseFailure();
    }
    // The stream's next baton comes first, even when a statement was refused: the rollback that
    // follows a refusal must continue this stream with the baton of this reply, or the server
    // keeps the transaction (and its write lock) open until the stream expires.
    this.baton = body.baton;
    // The first error decides, and its message is read only to classify it
    // (src/database-complexity.ts). readBatch has checked that nothing ran after it; a reply that
    // does not show that is a protocol violation and a plain 503.
    const outcome = readBatch(body.results[0], statements.length, this.transport.requestId);
    if (outcome.refused !== null) throw statementFailure(outcome.error, outcome.refused);
    const results = outcome.results.map((result) => decodeStmtResult(result, this.maxBytes));
    this.usage.push(...results.map((result) => result.usage));
    return results;
  }

  async finish(sql: "COMMIT" | "ROLLBACK"): Promise<void> {
    if (!this.open) return;
    // A stream whose last reply was never read cannot be continued with certainty: the baton
    // held here may already be stale. ROLLBACK still makes one bounded best-effort attempt with
    // it (#97): when the request never reached the server the baton is current and this releases
    // the transaction and its write lock now; when it did, the server refuses it and the stream
    // stays until the server expires it (ADR 0027, "Baton recovery"). COMMIT is never skipped
    // or attempted this way: an unusable stream is committed only if that same reply was read.
    // A stream the server ended (a read reply with a null baton) has nothing left to roll back and
    // no baton to continue: no request is sent and no recovery outcome is logged, so the runbook's
    // `refused` signal (a write lock waiting for expiry) is not raised for it (#144).
    if (this.streamEnded && sql === "ROLLBACK") {
      this.open = false;
      return;
    }
    if (this.unusable && sql === "ROLLBACK") {
      this.open = false;
      await this.recover();
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
    try {
      const body = await this.transport.pipeline(
        [executeRequest({ sql }, this.maxBytes), { type: "close" }],
        this.baton,
        timeoutMs,
      );
      const terminal = decodeResult(body.results[0], this.maxBytes);
      this.usage.push(terminal.usage);
      const close = body.results[1];
      if (!isRecord(close) || close.type !== "ok" || !isRecord(close.response) || close.response.type !== "close") {
        throw databaseFailure();
      }
      this.open = false;
    } catch (error) {
      // A cleanup ROLLBACK runs after the reply (or is handed to the background) and its
      // failure is otherwise swallowed. Log the outcome so a rollback that never reached the
      // server is visible to the runbook's stream-recovery alert (#97 review); the reply is
      // unchanged and no baton is logged.
      if (sql === "ROLLBACK") logStreamRecovery(this.transport.requestId, "failed");
      throw error;
    }
  }

  /**
   * Best-effort ROLLBACK after a reply was never read (#97). Never throws: the transaction is
   * already abandoned, so cleanup cannot change the reply. The outcome log is `rolled_back` or
   * `refused` (the server no longer knows that stream), and the transaction, with any write
   * lock, remains until the server expires it.
   */
  private async recover() {
    const usage = await this.transport.recoverStream(this.baton, this.maxBytes, this.timeoutMs);
    if (usage) this.usage.push(usage);
  }

  commit() { return this.finish("COMMIT"); }
  rollback() { return this.finish("ROLLBACK"); }
}
