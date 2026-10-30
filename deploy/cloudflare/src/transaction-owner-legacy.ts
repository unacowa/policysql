import { EngineError, operationError, wasmError } from "./errors.ts";
import { authIdentity, callbackDigest, commandDigest } from "./core-identity.ts";
import { observeCostEnvelope } from "./cost.ts";
import { executeSealedOnTransaction } from "./turso.ts";
import { enforceCumulativeLimits } from "./turso.ts";
import { runCommitChecks, verifyCapabilityToken } from "./commit-checks.ts";
import { checkDatabaseBinding, databaseTransportFactory, sameDatabaseBinding, validateDatabaseProvider } from "./database.ts";
import type { DatabaseProvider } from "./database.ts";
import type { OutboundFetch } from "./redirects.ts";
import { runtimeBytesLimit } from "./binary.ts";
import { runtimeLimits } from "./limits.ts";
import { validateConfig } from "./engine-config.ts";
import type { PolicySqlConfig, ValidatedConfig } from "./engine-config.ts";
import { runInBackground, validateOwnerFacilities } from "./transaction-owner-port.ts";
import type { OwnerAtomicInput, OwnerCommandKind, OwnerFacilities, OwnerReply } from "./transaction-owner-port.ts";

const COMMAND_KINDS: readonly OwnerCommandKind[] = ["statement", "commit", "rollback"];

const replyRequestId = (requestId: unknown) =>
  typeof requestId === "string" && requestId !== "" ? requestId : crypto.randomUUID();

const invalid = () => new EngineError("POLICYSQL_INVALID_REQUEST", "The request is invalid.");
const conflict = () => new EngineError("POLICYSQL_TRANSACTION_CONFLICT", "The transaction command conflicts with its current state.");
const unavailable = () => new EngineError("POLICYSQL_TRANSACTION_UNAVAILABLE", "The transaction is no longer active.");
const internal = () => new EngineError("POLICYSQL_INTERNAL", "The request could not be completed.");
// COMMIT may have been sent and the owner cannot tell whether it applied (#48, ADR 0007).
// Never a rejection: the client must treat it as an unknown outcome.
const outcomeUnknown = () => new EngineError("POLICYSQL_COMMIT_OUTCOME_UNKNOWN", "The commit outcome is unknown.");

const exactKeys = (value, keys, required = keys) => {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const actual = Object.keys(value);
  return actual.every((key) => keys.includes(key)) && required.every((key) => actual.includes(key));
};

/** The one-statement envelope a statement or callback command compiles as. */
const statementEnvelope = (command) => JSON.stringify({ statements: [{
  sql: command.sql,
  params: command.params,
  ...(command.expect === undefined ? {} : { expect: command.expect }),
}] });

// Compile errors that depend on the runtime's state rather than on the command: the plan
// table is full (POLICYSQL_DATABASE_UNAVAILABLE) or the runtime failed.
const STATE_DEPENDENT_COMPILE_ERRORS = new Set(["POLICYSQL_DATABASE_UNAVAILABLE", "POLICYSQL_INTERNAL"]);

const storedAtomicTerminal = (responseJson) => {
  let stored;
  try { stored = JSON.parse(responseJson); } catch { throw internal(); }
  if (
    stored?.version !== 1 || stored.status !== "committed" ||
    !Array.isArray(stored.results) || typeof stored.originalRequestId !== "string" ||
    typeof stored.transactionId !== "string" || !stored.transactionId.startsWith("atomic_") ||
    !stored.usage || Array.isArray(stored.usage) || typeof stored.usage !== "object" ||
    !["passed", "not_triggered"].includes(stored.commitChecks)
  ) throw internal();
  return {
    version: 1,
    transactionId: stored.transactionId,
    status: "committed",
    results: stored.results,
    usage: stored.usage,
    originalRequestId: stored.originalRequestId,
    replayed: true,
    commitChecks: stored.commitChecks,
  };
};

/** What a transaction owner needs. It receives the same `config` as `createApp` (ADR 0021). */
export type TransactionOwnerDependencies = {
  getRuntime: () => any;
  database: DatabaseProvider;
  config: PolicySqlConfig;
  /** Omitted: commit-check calls use the host fetch through fetchNoFollow. */
  fetchImpl?: OutboundFetch;
};

/** The legacy owner's own input shapes (before ADR 0024 pull request 7). */
export type LegacyBeginInput = {
  transactionId: string; authFingerprint: string; startFingerprint: string; mode: "read" | "write";
  auth: unknown; expected?: unknown; databaseBinding: unknown; snapshot: string;
};
export type LegacyCommandInput = {
  transactionId: string; authFingerprint: string; command: unknown; databaseBinding: unknown; snapshot: string;
};
export type LegacyCallbackInput = { capability: string; command: unknown };

/**
 * The TypeScript owner of ADR 0007 and ADR 0022, before the step machine (ADR 0024).
 *
 * Since pull request 7 production serves interactive transactions, and since pull request 8
 * atomic executions, with the step machine (`TransactionOwnerCore`, transaction-owner.ts). No
 * production path reaches this class. It stays, with `turso.ts`, `cost.ts`, and
 * `commit-checks.ts`, only as the reference of the differential harnesses
 * (test/step-differential.test.mjs, test/step-atomic-differential.test.mjs) and as the
 * previous release's writer in the tests of keyed retries across the deployment, until pull
 * request 9 deletes it. A record it wrote is an old-format record to the machine.
 */
export class LegacyTransactionOwnerCore {
  facilities: OwnerFacilities;
  config: ValidatedConfig;
  getRuntime: any;
  fetchImpl?: OutboundFetch;
  transaction: any;
  validation: any;
  queue: Promise<any>;
  validationQueue: Promise<any>;
  database: DatabaseProvider;
  /** True while this owner's COMMIT is in flight: nothing else may end the transaction. */
  committing: boolean;
  /** A terminal commit record whose put failed after COMMIT succeeded; replayed on retry. */
  unrecorded: { record: any } | null;

  /**
   * `facilities` come from the owner adapter; `dependencies` are the same ports the wrapper
   * gives `createApp`. No platform object is an argument.
   */
  constructor(facilities: OwnerFacilities, dependencies: TransactionOwnerDependencies) {
    if (typeof dependencies?.getRuntime !== "function") throw new TypeError("getRuntime is required");
    validateDatabaseProvider(dependencies.database);
    // Validated before the owner can serve any request, so a bad setting never reaches I/O.
    this.config = validateConfig(dependencies.config);
    this.facilities = validateOwnerFacilities(facilities);
    this.getRuntime = dependencies.getRuntime;
    this.fetchImpl = dependencies.fetchImpl;
    this.database = dependencies.database;
    this.transaction = null;
    this.validation = null;
    this.committing = false;
    this.unrecorded = null;
    this.queue = Promise.resolve();
    this.validationQueue = Promise.resolve();
  }

  connectionFactory(binding, deadlineMs = undefined) {
    return databaseTransportFactory(this.database, binding, runtimeBytesLimit(this.getRuntime()), deadlineMs);
  }

  async checkContext(body) {
    const snapshot = this.getRuntime().snapshot;
    if (body.snapshot !== snapshot) throw conflict();
    const databaseBinding = await checkDatabaseBinding(this.database, body.databaseBinding, snapshot);
    return { databaseBinding, snapshot };
  }

  async checkCurrent(current, deadlineMs = current.expiresAtMs) {
    try {
      if (current.snapshot !== this.getRuntime().snapshot) throw unavailable();
      await checkDatabaseBinding(this.database, current.databaseBinding, current.snapshot,
        ["active", "validating"].includes(current.status) ? deadlineMs : undefined);
      if (current.snapshot !== this.getRuntime().snapshot ||
        (["active", "validating"].includes(current.status) && Date.now() >= current.expiresAtMs)) throw unavailable();
    } catch (error) {
      if (this.transaction?.open) await this.close("failed");
      throw error;
    }
  }

  observeCost(compiled, requestId, binding) {
    runInBackground(this.facilities.background,
      observeCostEnvelope(
        compiled, this.config.costCatalog, `${requestId}-cost`, this.connectionFactory(binding),
        runtimeBytesLimit(this.getRuntime()), runtimeLimits(this.getRuntime()).costTimeoutMs,
      ),
      requestId);
  }

  // Client commands: one at a time, in arrival order.
  clientLane(work: () => Promise<unknown>): Promise<OwnerReply> {
    const run = this.queue.then(async (): Promise<OwnerReply> => {
      try {
        return { ok: true, value: await work() };
      } catch (error) {
        return { ok: false, error: operationError(error) };
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  begin(input: LegacyBeginInput, requestId: string): Promise<OwnerReply> {
    const id = replyRequestId(requestId);
    return this.clientLane(() => this.startTransaction(input, id));
  }

  atomic(input: OwnerAtomicInput, requestId: string): Promise<OwnerReply> {
    const id = replyRequestId(requestId);
    return this.clientLane(() => this.executeAtomic(input, id));
  }

  command(kind: OwnerCommandKind, input: LegacyCommandInput, requestId: string): Promise<OwnerReply> {
    const id = replyRequestId(requestId);
    return this.clientLane(async () => {
      if (!COMMAND_KINDS.includes(kind)) throw invalid();
      return kind === "statement" ? await this.statement(input, id) : await this.terminal(input, id, kind);
    });
  }

  // Callback queries: one at a time on their own lane, because they arrive while a commit
  // on the client lane waits for the validator. Only a live capability can be called back
  // (ADR 0007): without one the reply is unavailable and nothing changes (#73). With one,
  // any failure ends the open transaction, a failure to read the record included. A query
  // whose capability is revoked while it runs (the verdict, an expiry, or a close then
  // decided the transaction) is answered unavailable, as in the step machine.
  callbackQuery(input: LegacyCallbackInput, requestId: string): Promise<OwnerReply> {
    const id = replyRequestId(requestId);
    const run = this.validationQueue.then(async (): Promise<OwnerReply> => {
      // Captured before any await: the capability this callback may fail.
      let session = this.validation;
      try {
        if (!await this.liveValidation(session)) {
          session = null;
          throw unavailable();
        }
        const capability = typeof input?.capability === "string" ? input.capability : "";
        return { ok: true, value: await this.validationQuery(session, input?.command, capability, id) };
      } catch (error) {
        if (!session) return { ok: false, error: operationError(error) };
        if (this.validation !== session) return { ok: false, error: operationError(unavailable()) };
        this.validation = null;
        if (this.transaction?.open) {
          // The rollback is done before the record is read; a failed put leaves the record to
          // the waiting commit, which is rejected because the transaction is closed.
          try { await this.close("failed"); } catch { /* the store failed */ }
        }
        return { ok: false, error: operationError(error) };
      }
    });
    this.validationQueue = run.catch(() => undefined);
    return run;
  }

  async stored(): Promise<any> {
    return await this.facilities.store.get("transaction");
  }

  async persist(value) {
    await this.facilities.store.put("transaction", value);
    return value;
  }

  /** Rolls back an open transaction and records `status`. COMMIT is sent only by `commit`. */
  async close(status) {
    // A failing callback query cannot roll back or overwrite a commit in flight; the commit's
    // outcome alone decides the record.
    if (this.committing) return "committing";
    // Any close revokes the callback capability.
    this.validation = null;
    if (this.transaction?.open) {
      try {
        await this.transaction.rollback();
      } catch {
        status = "failed";
      }
    }
    this.transaction = null;
    const current = await this.stored();
    if (current) await this.persist({ ...current, status, expiresAt: undefined });
    return status;
  }

  /**
   * The stored record, if it belongs to the caller: the same transaction id, and the same
   * auth fingerprint and database binding, which both include the snapshot. `sameSnapshot`
   * is false only for a commit whose caller differs from the record in nothing but the
   * snapshot (a deployment between the commit and its retry); see `sameExceptSnapshot`.
   */
  async owned(body, kind) {
    const current = await this.stored();
    if (!current || current.transactionId !== body.transactionId) throw unavailable();
    if (current.authFingerprint === body.authFingerprint && sameDatabaseBinding(current.databaseBinding, body.databaseBinding)) {
      return { current, sameSnapshot: true };
    }
    if (kind === "commit" && this.sameExceptSnapshot(current, body)) return { current, sameSnapshot: false };
    throw unavailable();
  }

  /**
   * Whether the caller is the record's principal, subject, role, and session on the record's
   * database (scope, id, and generation), with only the snapshot changed. The record keeps
   * that identity as its `auth` and `databaseBinding`; the owner recomputes the fingerprint
   * the caller must present under the caller's snapshot, after checking that the stored
   * `auth` still produces the stored fingerprint.
   */
  sameExceptSnapshot(current, body) {
    const binding = body.databaseBinding;
    const stored = current.databaseBinding;
    if (!binding || typeof binding !== "object" || Array.isArray(binding) || typeof binding.snapshot !== "string" ||
      !stored || typeof stored !== "object" || !current.auth || typeof current.auth !== "object") return false;
    if (binding.snapshot === stored.snapshot) return false;
    if (!sameDatabaseBinding({ ...stored, snapshot: null }, { ...binding, snapshot: null })) return false;
    const runtime = this.getRuntime();
    if (authIdentity(runtime, current.auth, stored) !== current.authFingerprint) return false;
    return authIdentity(runtime, current.auth, binding) === body.authFingerprint;
  }

  /**
   * A commit command whose COMMIT may already have been sent (#48, ADR 0007). `commitSent`
   * is written before COMMIT and never removed, so it records explicitly that every later
   * status of the record (`committing`, or `failed` after a COMMIT error) was reached after
   * COMMIT was sent. Called after `owned`, before the snapshot, route, and expiry checks:
   * such a commit is answered only with its recorded reply (re-recorded first, when this
   * live owner holds a reply whose put failed), or with POLICYSQL_COMMIT_OUTCOME_UNKNOWN,
   * never with a rejection. Any other command returns null and is checked as usual.
   */
  async commitRetry(current, command) {
    if (!Number.isSafeInteger(command?.sequence)) return null;
    const digest = commandDigest(this.getRuntime(), "commit", command);
    const sent = current.commitSent
      ? current.commitSent.sequence === command.sequence && current.commitSent.digest === digest
      // A record of the previous release, which wrote nothing before COMMIT: `committed` with
      // the earlier command's `last` (between its two puts), or `active`, `failed`, or
      // `expired`, which it also left after a COMMIT that may have applied. Nothing in it
      // proves that COMMIT was not sent, so a commit at its next sequence is not rejected. Such
      // a record is never this owner's open transaction: this release writes the field.
      : current.commitRecording === undefined && !this.transaction && command.sequence === current.nextSequence &&
        ["committed", "active", "failed", "expired"].includes(current.status);
    if (!sent) return null;
    if (current.status === "committed" && current.nextSequence - 1 === command.sequence && current.last?.digest === digest) {
      return current.last.response;
    }
    // This owner saw COMMIT succeed, and only its terminal put failed: record it again.
    const unrecorded = this.unrecorded;
    if (current.status === "committing" && unrecorded?.record.transactionId === current.transactionId &&
      unrecorded.record.last.digest === digest && unrecorded.record.nextSequence - 1 === command.sequence) {
      try {
        await this.persist(unrecorded.record);
        this.unrecorded = null;
        return unrecorded.record.last.response;
      } catch {
        console.log(JSON.stringify({ event: "transaction_terminal_unrecorded", transactionId: current.transactionId }));
      }
    }
    console.log(JSON.stringify({
      event: "transaction_commit_outcome_unknown", transactionId: current.transactionId, status: current.status,
    }));
    throw outcomeUnknown();
  }

  async active(body, current) {
    if (body.snapshot !== undefined && current.snapshot !== body.snapshot) throw unavailable();
    await this.checkCurrent(current);
    if (current.status !== "active") return current;
    if (!this.transaction || Date.now() >= current.expiresAtMs) {
      console.log(JSON.stringify({
        event: "transaction_owner_unavailable",
        transactionId: current.transactionId,
        reason: Date.now() >= current.expiresAtMs ? "expired" : "owner_lost",
      }));
      await this.close(Date.now() >= current.expiresAtMs ? "expired" : "failed");
      throw unavailable();
    }
    return current;
  }

  async startTransaction(body, requestId) {
    if (!exactKeys(body, ["transactionId", "authFingerprint", "startFingerprint", "mode", "auth", "expected", "databaseBinding", "snapshot"], ["transactionId", "authFingerprint", "startFingerprint", "mode", "auth"]) ||
      !/^tx_[a-f0-9]{32}$/.test(body.transactionId) ||
      !/^[a-f0-9]{64}$/.test(body.authFingerprint) ||
      !/^[a-f0-9]{64}$/.test(body.startFingerprint) ||
      !["read", "write"].includes(body.mode)) throw invalid();
    const bindingContext = await this.checkContext(body);
    const previous = await this.stored();
    if (previous) {
      if (previous.startFingerprint !== body.startFingerprint || previous.authFingerprint !== body.authFingerprint ||
        previous.snapshot !== bindingContext.snapshot || !sameDatabaseBinding(previous.databaseBinding, bindingContext.databaseBinding)) {
        throw conflict();
      }
      // COMMIT may be in flight or its outcome unrecorded; only the commit command answers.
      if (previous.status === "committing") throw unavailable();
      if (previous.status === "active" && !this.transaction) {
        await this.persist({ ...previous, status: "failed", expiresAt: undefined });
        throw unavailable();
      }
      return this.publicState(previous, requestId);
    }
    const limits = runtimeLimits(this.getRuntime());
    const expiresAtMs = Date.now() + limits.transactionMs;
    const transport = await this.connectionFactory(bindingContext.databaseBinding, expiresAtMs)(requestId);
    this.transaction = await transport.begin(body.mode, limits.beginTimeoutMs);
    const value = await this.persist({
      ...bindingContext,
      transactionId: body.transactionId,
      authFingerprint: body.authFingerprint,
      startFingerprint: body.startFingerprint,
      mode: body.mode,
      auth: body.auth,
      status: "active",
      // This release records `commitSent` before every COMMIT (#48); a record without this
      // field was written by the previous release.
      commitRecording: 1,
      nextSequence: 1,
      expiresAtMs,
      last: null,
      usage: { rowsRead: 0, rowsWritten: 0, queryDurationMs: 0 },
      statementCount: 0,
      resultBytes: 0,
      mutations: [],
      commitChecks: [],
      schemaVersion: null,
      policyVersion: null,
    });
    await this.facilities.timer.schedule(expiresAtMs);
    console.log(JSON.stringify({ event: "transaction_started", transactionId: value.transactionId, mode: value.mode, requestId }));
    return this.publicState(value, requestId);
  }

  publicState(value, requestId) {
    return {
      transactionId: value.transactionId,
      status: value.status,
      ...(value.status === "active" ? {
        nextSequence: value.nextSequence,
        expiresAt: new Date(value.expiresAtMs).toISOString(),
      } : {}),
      meta: { requestId },
    };
  }

  async prepareCommand(body, kind, requestId) {
    const { current: owned, sameSnapshot } = await this.owned(body, kind);
    if (kind === "commit") {
      const replay = await this.commitRetry(owned, body.command);
      if (replay) return { replay };
    }
    // Across a snapshot change only a commit whose COMMIT was sent is answered.
    if (!sameSnapshot) throw unavailable();
    const current = await this.active(body, owned);
    if (!Number.isSafeInteger(body.command?.sequence) || body.command.sequence < 1) throw invalid();
    // A statement's digest decides only two things: whether it repeats `last` (an exact
    // retry, possible only at `nextSequence - 1`), and what a successful statement records.
    // So a statement's digest is computed here only for a possible retry that compiles
    // (see `mayRepeat`), and otherwise after its compile succeeds, before it executes
    // (`statement`), before any database work. A body that cannot compile is never hashed
    // (#55 review: a 1 MB body of numbers cost hashes before compile). A body that compiles is
    // hashed in full, by core's canonicalization, in time linear in its size.
    const retry = body.command.sequence === current.nextSequence - 1 && current.last !== undefined && current.last !== null;
    let digest = null;
    if (kind !== "statement" || (retry && this.mayRepeat(current.auth, statementEnvelope(body.command)))) {
      digest = commandDigest(this.getRuntime(), kind, body.command);
      if (retry && current.last.digest === digest) return { replay: current.last.response };
    }
    if (current.status !== "active") throw unavailable();
    if (body.command.sequence !== current.nextSequence) {
      await this.close("failed");
      throw conflict();
    }
    return { current, digest };
  }

  /**
   * Whether a command may equal the recorded `last` one, judged by compiling it (a pure call
   * whose plan is released at once). `last` compiled under the same `auth`, and every caller
   * first requires the record's snapshot to equal the runtime's, so the same command compiles
   * again: a compile that rejects the command for a reason of its own proves that it is not
   * `last` without hashing it. This spares only the hashes of commands that cannot compile;
   * it does not bound what is hashed: a command that compiles, such as one with a large
   * JSON-typed parameter, is hashed in full, at a cost linear in its size. A state-dependent
   * failure is inconclusive and the caller hashes as before.
   */
  mayRepeat(auth, envelope) {
    const runtime = this.getRuntime();
    let compiled;
    try {
      compiled = JSON.parse(runtime.compile_json(JSON.stringify(auth), envelope, "execute"));
    } catch {
      return true;
    }
    const error = wasmError(compiled);
    if (error) return STATE_DEPENDENT_COMPILE_ERRORS.has(error.code);
    runtime.release_execution(BigInt(compiled.executionHandle));
    return true;
  }

  async saveCommand(current, digest, response, usage) {
    await this.persist({
      ...current,
      nextSequence: current.nextSequence + 1,
      last: { digest, response },
      usage,
    });
    return response;
  }

  async statement(body, requestId) {
    if (!exactKeys(body, ["transactionId", "authFingerprint", "command", "databaseBinding", "snapshot"], ["transactionId", "authFingerprint", "command"]) ||
      !exactKeys(body.command, ["sequence", "sql", "params", "expect"], ["sequence", "sql", "params"]) ||
      typeof body.command.sql !== "string" ||
      !body.command.params || Array.isArray(body.command.params) || typeof body.command.params !== "object") throw invalid();
    const prepared = await this.prepareCommand(body, "statement", requestId);
    if (prepared.replay) return prepared.replay;
    const { current } = prepared;
    const limits = runtimeLimits(this.getRuntime());
    if (current.statementCount >= limits.maxTransactionStatements) {
      await this.close("failed");
      throw new EngineError("POLICYSQL_TRANSACTION_LIMIT_EXCEEDED", "The transaction limit was exceeded.");
    }
    const runtime = this.getRuntime();
    const compiled = JSON.parse(runtime.compile_json(JSON.stringify(current.auth), statementEnvelope(body.command), "execute"));
    const compileError = wasmError(compiled);
    if (compileError) {
      await this.close("failed");
      throw compileError;
    }
    if (current.mode === "read" && compiled.transactionMode !== "read") {
      runtime.release_execution(BigInt(compiled.executionHandle));
      await this.close("failed");
      throw new EngineError("POLICYSQL_TRANSACTION_MODE_VIOLATION", "A read transaction cannot execute a mutation.");
    }
    // The digest this statement records, computed by core before any database work.
    let digest = prepared.digest;
    if (digest === null) {
      try {
        digest = commandDigest(runtime, "statement", body.command);
      } catch (error) {
        runtime.release_execution(BigInt(compiled.executionHandle));
        throw error;
      }
    }
    let executed;
    try {
      executed = await executeSealedOnTransaction(runtime, compiled, this.transaction, requestId);
    } catch (error) {
      await this.close("failed");
      throw error;
    }
    this.observeCost(compiled, requestId, current.databaseBinding);
    const usage = {
      rowsRead: current.usage.rowsRead + executed.usage.rowsRead,
      rowsWritten: current.usage.rowsWritten + executed.usage.rowsWritten,
      queryDurationMs: Math.round((current.usage.queryDurationMs + executed.usage.queryDurationMs) * 1000) / 1000,
    };
    const response = {
      transactionId: current.transactionId,
      status: "active",
      nextSequence: current.nextSequence + 1,
      result: { sequence: current.nextSequence, ...executed.results[0] },
      meta: { requestId },
    };
    const resultBytes = current.resultBytes + new TextEncoder().encode(JSON.stringify(response.result)).byteLength;
    if (resultBytes > limits.maxTransactionResultBytes) {
      await this.close("failed");
      throw new EngineError("POLICYSQL_TRANSACTION_LIMIT_EXCEEDED", "The transaction limit was exceeded.");
    }
    console.log(JSON.stringify({
      event: "transaction_usage",
      transactionId: current.transactionId,
      requestId,
      usage,
    }));
    return await this.saveCommand({
      ...current,
      statementCount: current.statementCount + 1,
      resultBytes,
      mutations: compiled.statements[0].operation !== "select" && (executed.results[0].affectedRows ?? 0) > 0
        ? [...current.mutations, {
          index: current.statementCount,
          type: compiled.statements[0].operation,
          resource: compiled.statements[0].resource,
        }]
        : current.mutations,
      commitChecks: this.mergeChecks(current.commitChecks, compiled.commitChecks ?? []),
      schemaVersion: compiled.schemaVersion,
      policyVersion: compiled.policyVersion,
    }, digest, response, usage);
  }

  async terminal(body, requestId, kind) {
    if (!exactKeys(body, ["transactionId", "authFingerprint", "command", "databaseBinding", "snapshot"], ["transactionId", "authFingerprint", "command"]) ||
      !exactKeys(body.command, ["sequence"], ["sequence"])) throw invalid();
    const prepared = await this.prepareCommand(body, kind, requestId);
    if (prepared.replay) return prepared.replay;
    const { current, digest } = prepared;
    let commitChecks = "not_triggered";
    if (kind === "commit" && current.mutations.length > 0) {
      try {
        commitChecks = await this.checksForCurrent(current, requestId);
      } catch (error) {
        await this.close("failed");
        throw error;
      }
    }
    if (kind === "commit") return await this.commit(current, digest, requestId, commitChecks);
    const status = await this.close("rolled_back");
    const response = {
      transactionId: current.transactionId,
      status,
      meta: { requestId, commitChecks },
    };
    await this.persist({
      ...current,
      status,
      nextSequence: current.nextSequence + 1,
      expiresAtMs: undefined,
      last: { digest, response },
    });
    console.log(JSON.stringify({
      event: "transaction_terminal",
      transactionId: current.transactionId,
      status,
      requestId,
      usage: current.usage,
    }));
    return response;
  }

  /**
   * Sends COMMIT for `current`, which passed its commit checks. The record says `committing`
   * (with the command's sequence and digest as `commitSent`) before COMMIT is sent, and the
   * terminal record (`committed`, the next sequence, and the reply as `last`) is one put, so
   * neither a successor nor a retry after a failed put reads a state that rejects a commit
   * that applied (#48).
   */
  async commit(current, digest, requestId, commitChecks) {
    // A route can be revoked while an external validator is running.
    await this.checkCurrent(current);
    // Nothing was sent: an expiry or failure already ended the transaction.
    if (!this.transaction?.open) throw unavailable();
    let committing;
    try {
      committing = await this.persist({ ...current, status: "committing", commitSent: { sequence: current.nextSequence, digest } });
    } catch (error) {
      // COMMIT was not sent. If the put did land, the failed record keeps `commitSent`, and a
      // retry gets the unknown outcome rather than a rejection.
      await this.close("failed");
      throw error;
    }
    // The deadline can pass while `committing` is stored. COMMIT is then never sent: roll
    // back, record `expired` without `commitSent`, and only then reject (ADR 0024). If that
    // record cannot be stored, `committing` stays, so a retry gets the unknown outcome.
    if (Date.now() >= current.expiresAtMs) {
      try { await this.transaction.rollback(); } catch { /* the database deadline ends it */ }
      this.transaction = null;
      try {
        await this.persist({ ...current, status: "expired", expiresAtMs: undefined });
      } catch {
        throw internal();
      }
      throw unavailable();
    }
    this.committing = true;
    try {
      await this.transaction.commit();
    } catch {
      // A transport error during COMMIT does not prove that nothing committed. Whatever the
      // store does, the reply is the unknown outcome; an unstored `failed` leaves
      // `committing`, which a retry answers the same way.
      this.committing = false;
      this.transaction = null;
      console.log(JSON.stringify({ event: "transaction_commit_outcome_unknown", transactionId: current.transactionId, requestId }));
      try {
        await this.persist({ ...committing, status: "failed", expiresAtMs: undefined });
      } catch {
        console.log(JSON.stringify({ event: "transaction_terminal_unrecorded", transactionId: current.transactionId, requestId }));
      }
      throw outcomeUnknown();
    }
    this.committing = false;
    this.transaction = null;
    const response = {
      transactionId: current.transactionId,
      status: "committed",
      meta: { requestId, commitChecks },
    };
    const terminal = {
      ...committing,
      status: "committed",
      nextSequence: current.nextSequence + 1,
      expiresAtMs: undefined,
      last: { digest, response },
    };
    try {
      await this.persist(terminal);
    } catch {
      // The commit applied, so the reply says so. The record stays `committing`. This owner
      // keeps the terminal record and stores it again on a retry; a successor, or a second
      // failed put, answers the retry with the unknown outcome, never a rejection.
      this.unrecorded = { record: terminal };
      console.log(JSON.stringify({ event: "transaction_terminal_unrecorded", transactionId: current.transactionId, requestId }));
    }
    console.log(JSON.stringify({
      event: "transaction_terminal",
      transactionId: current.transactionId,
      status: "committed",
      requestId,
      usage: current.usage,
    }));
    return response;
  }

  /**
   * Called by the adapter when this owner's timer fires: an open transaction expires. It is
   * not queued behind the client lane, so expiry also ends a commit that waits on a validator.
   */
  async onTimer() {
    const current = await this.stored();
    if (["active", "validating"].includes(current?.status)) await this.close("expired");
  }

  mergeChecks(current, incoming) {
    return [...new Map([...current, ...incoming].map((check) => [check.id, check])).values()]
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async activateValidation(current, session) {
    this.validation = { ...session, databaseBinding: current.databaseBinding, snapshot: current.snapshot };
    await this.persist({ ...current, status: "validating" });
  }

  async deactivateValidation(current) {
    this.validation = null;
    if (!this.transaction?.open) {
      throw new EngineError("POLICYSQL_COMMIT_CHECK_REJECTED", "A commit check rejected the transaction.");
    }
    await this.persist({ ...current, status: "active" });
  }

  async checksForCurrent(current, requestId, compiled = null, results = null) {
    const context = compiled ?? {
      statements: current.mutations.map((mutation) => ({
        operation: mutation.type,
        resource: mutation.resource,
      })),
      commitChecks: current.commitChecks,
      policyVersion: current.policyVersion,
      schemaVersion: current.schemaVersion,
    };
    const outcomes = results ?? current.mutations.map(() => ({ affectedRows: 1 }));
    return await runCommitChecks({
      compiled: context,
      results: outcomes,
      auth: current.auth,
      config: this.config,
      requestId,
      validationId: current.validationId ?? current.transactionId.replace(/^tx_/u, "cval_"),
      activate: (session) => this.activateValidation(current, session),
      deactivate: () => this.deactivateValidation(current),
      fetchImpl: this.fetchImpl,
      deadlineMs: current.expiresAtMs,
    });
  }

  /**
   * The live capability, or null: a validator is awaited (the verdict's
   * `deactivateValidation` and every close clear `this.validation`), the record is
   * `validating`, and the transaction is open. Read before the token is looked at, so a
   * callback that finds no live capability (none granted, after the verdict, after an expiry,
   * on a successor) cannot end the transaction (#73). `session` was captured before any
   * await; a failed read of the record throws, which the caller treats as a failure of that
   * live capability (fail closed).
   */
  async liveValidation(session) {
    if (!session || this.validation !== session || !this.transaction?.open) return null;
    const current = await this.stored();
    return current?.status === "validating" && this.validation === session && this.transaction?.open ? session : null;
  }

  async validationQuery(session, command, capability, requestId) {
    const current = await this.stored();
    if (!current || current.status !== "validating" || !this.transaction?.open ||
      !await verifyCapabilityToken(capability, session) ||
      !exactKeys(command, ["sequence", "sql", "params"], ["sequence", "sql", "params"]) ||
      !Number.isSafeInteger(command.sequence) || command.sequence < 1 ||
      typeof command.sql !== "string" || !command.params || Array.isArray(command.params) ||
      typeof command.params !== "object") throw unavailable();
    if (!sameDatabaseBinding(session.databaseBinding, current.databaseBinding) || session.snapshot !== current.snapshot) throw unavailable();
    await this.checkCurrent(current, Math.min(current.expiresAtMs, session.expiresAtMs));
    if (Date.now() >= session.expiresAtMs) throw unavailable();
    // As for statements (`prepareCommand`): hashed for a possible exact retry that compiles,
    // otherwise after the compile succeeds and before the query executes.
    const envelope = statementEnvelope(command);
    let digest = null;
    if (command.sequence === session.nextSequence - 1 && session.last && this.mayRepeat(session.auth, envelope)) {
      digest = callbackDigest(this.getRuntime(), command);
      if (session.last.digest === digest) return session.last.response;
    }
    const runtime = this.getRuntime();
    const limits = runtimeLimits(runtime);
    if (command.sequence !== session.nextSequence || command.sequence > limits.maxTransactionStatements) throw conflict();
    const compiled = JSON.parse(runtime.compile_json(JSON.stringify(session.auth), envelope, "execute"));
    const compileError = wasmError(compiled);
    if (compileError) throw compileError;
    if (compiled.transactionMode !== "read" || compiled.statements.length !== 1) {
      runtime.release_execution(BigInt(compiled.executionHandle));
      throw conflict();
    }
    if (digest === null) {
      try {
        digest = callbackDigest(runtime, command);
      } catch (error) {
        runtime.release_execution(BigInt(compiled.executionHandle));
        throw error;
      }
    }
    const executed = await executeSealedOnTransaction(runtime, compiled, this.transaction, requestId);
    const response = {
      sequence: command.sequence,
      ...executed.results[0],
      meta: {
        ...executed.results[0].meta,
        requestId,
        policyVersion: compiled.policyVersion,
        schemaVersion: compiled.schemaVersion,
        role: session.auth.role,
      },
    };
    const rowsReturned = session.rowsReturned + executed.results[0].rowCount;
    const resultBytes = session.resultBytes + new TextEncoder().encode(JSON.stringify(response)).byteLength;
    if (rowsReturned > limits.maxCallbackRows || resultBytes > limits.maxTransactionResultBytes) {
      throw new EngineError("POLICYSQL_TRANSACTION_LIMIT_EXCEEDED", "The transaction limit was exceeded.");
    }
    // Revoked while the query ran (the verdict, an expiry, or a close): its rows are not
    // returned, and the revoked capability is not restored.
    if (this.validation !== session) throw unavailable();
    this.validation = {
      ...session,
      nextSequence: session.nextSequence + 1,
      last: { digest, response },
      rowsReturned,
      resultBytes,
    };
    return response;
  }

  async executeAtomic(body, requestId) {
    if (!exactKeys(body, ["validationId", "auth", "request", "idempotency", "databaseBinding", "snapshot"], ["validationId", "auth", "request"]) ||
      !/^cval_[a-f0-9]{32}$/u.test(body.validationId) || typeof body.request !== "string" ||
      (body.idempotency != null && (
        !exactKeys(body.idempotency, ["keyHash", "fingerprint"]) ||
        typeof body.idempotency.keyHash !== "string" || !/^[a-f0-9]{64}$/.test(body.idempotency.keyHash) ||
        typeof body.idempotency.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.idempotency.fingerprint)
      ))) throw invalid();
    const bindingContext = await this.checkContext(body);
    const previous = await this.stored();
    if (previous && (!sameDatabaseBinding(previous.databaseBinding, bindingContext.databaseBinding) ||
      previous.snapshot !== bindingContext.snapshot)) throw conflict();
    const runtime = this.getRuntime();
    const compiled = JSON.parse(runtime.compile_json(JSON.stringify(body.auth), body.request, "execute"));
    const compileError = wasmError(compiled);
    if (compileError) throw compileError;
    if (compiled.transactionMode !== "write") {
      runtime.release_execution(BigInt(compiled.executionHandle));
      throw invalid();
    }
    let released = false;
    const expiresAtMs = Date.now() + runtimeLimits(runtime).transactionMs;
    try {
      const transport = await this.connectionFactory(bindingContext.databaseBinding, expiresAtMs)(requestId);
      this.transaction = await transport.begin("write", Math.min(...compiled.statements.map((item) => item.limits.timeoutMs)));
    } catch (error) {
      runtime.release_execution(BigInt(compiled.executionHandle));
      throw error;
    }
    const current = {
      ...bindingContext,
      transactionId: `atomic_${body.idempotency?.keyHash.slice(0, 24) ?? body.validationId.slice("cval_".length)}`,
      validationId: body.validationId,
      auth: body.auth,
      status: "active",
      expiresAtMs,
    };
    const started = performance.now();
    let terminal = null;
    try {
      await this.persist(current);
      await this.facilities.timer.schedule(current.expiresAtMs);
      if (body.idempotency) {
        const [existing] = await this.transaction.execute([{
          sql: "SELECT fingerprint, response_json FROM policysql_idempotency WHERE key_hash = :key_hash",
          args: { key_hash: body.idempotency.keyHash },
        }]);
        if (existing.rows.length === 1) {
          const [fingerprint, responseJson] = existing.rows[0];
          if (fingerprint !== body.idempotency.fingerprint) throw conflict();
          const stored = storedAtomicTerminal(responseJson);
          runtime.release_execution(BigInt(compiled.executionHandle));
          released = true;
          await this.transaction.rollback();
          this.transaction = null;
          await this.persist({ ...current, status: "committed" });
          return stored;
        }
        if (existing.rows.length !== 0) throw conflict();
      }
      // executeSealedOnTransaction releases its handle on both success and failure.
      released = true;
      const executed = await executeSealedOnTransaction(runtime, compiled, this.transaction, requestId);
      this.observeCost(compiled, requestId, current.databaseBinding);
      enforceCumulativeLimits(compiled, executed.results, performance.now() - started);
      const commitChecks = await this.checksForCurrent(current, requestId, compiled, executed.results);
      await this.checkCurrent(current);
      const usage = {
        rowsReturned: executed.results.reduce((sum, result) => sum + result.rowCount, 0),
        rowsAffected: executed.results.reduce((sum, result) => sum + (result.affectedRows ?? 0), 0),
        rowsRead: executed.usage.rowsRead,
        rowsWritten: executed.usage.rowsWritten,
        queryDurationMs: Math.round(executed.usage.queryDurationMs * 1000) / 1000,
      };
      const reply = {
        version: 1,
        transactionId: current.transactionId,
        status: "committed",
        results: executed.results,
        usage,
        originalRequestId: requestId,
        replayed: false,
        commitChecks,
      };
      if (body.idempotency) {
        await this.transaction.execute([{
          sql: "INSERT INTO policysql_idempotency (key_hash, fingerprint, response_json) VALUES (:key_hash, :fingerprint, :response_json)",
          args: {
            key_hash: body.idempotency.keyHash,
            fingerprint: body.idempotency.fingerprint,
            response_json: JSON.stringify(reply),
          },
        }]);
      }
      await this.transaction.commit();
      terminal = reply;
      this.transaction = null;
      this.validation = null;
      await this.persist({ ...current, status: "committed" });
      return terminal;
    } catch (error) {
      // The commit applied: a failed put of the owner record does not change the outcome. A
      // keyed retry resolves through `policysql_idempotency`, never through this record.
      if (terminal) {
        console.log(JSON.stringify({ event: "transaction_terminal_unrecorded", transactionId: current.transactionId, requestId }));
        return terminal;
      }
      if (!released) runtime.release_execution(BigInt(compiled.executionHandle));
      if (this.transaction?.open) {
        try { await this.transaction.rollback(); } catch { /* terminal */ }
      }
      this.transaction = null;
      this.validation = null;
      await this.persist({ ...current, status: "failed" });
      throw error;
    }
  }
}
