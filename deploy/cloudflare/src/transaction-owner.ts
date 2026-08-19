import { HttpError, safeError, wasmError } from "./errors.ts";
import { stableJson, sha256 } from "./idempotency.ts";
import { TursoHttpTransport } from "./turso-http.ts";
import { observeCostEnvelope } from "./cost.ts";
import { executeSealedOnTransaction } from "./turso.ts";
import { enforceCumulativeLimits } from "./turso.ts";
import { runCommitChecks, verifyCapabilityToken } from "./commit-checks.ts";

const MAX_TRANSACTION_MS = 4_000;
const MAX_STATEMENTS = 8;
const MAX_RESULT_BYTES = 64_000;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
});

const invalid = () => new HttpError(400, "POLICYSQL_INVALID_REQUEST", "The request is invalid.");
const conflict = () => new HttpError(409, "POLICYSQL_TRANSACTION_CONFLICT", "The transaction command conflicts with its current state.");
const unavailable = () => new HttpError(409, "POLICYSQL_TRANSACTION_UNAVAILABLE", "The transaction is no longer active.");
const internal = () => new HttpError(500, "POLICYSQL_INTERNAL", "The request could not be completed.");

const exactKeys = (value, keys, required = keys) => {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const actual = Object.keys(value);
  return actual.every((key) => keys.includes(key)) && required.every((key) => actual.includes(key));
};

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

export class TransactionOwnerCore {
  state: any;
  env: any;
  getRuntime: any;
  transportFactory: any;
  fetchImpl: typeof fetch;
  transaction: any;
  validation: any;
  queue: Promise<any>;
  validationQueue: Promise<any>;

  constructor(
    state,
    env,
    getRuntime,
    transportFactory = (bindings, requestId) => new TursoHttpTransport(bindings, requestId),
    fetchImpl = fetch,
  ) {
    this.state = state;
    this.env = env;
    this.getRuntime = getRuntime;
    this.transportFactory = transportFactory;
    this.fetchImpl = fetchImpl;
    this.transaction = null;
    this.validation = null;
    this.queue = Promise.resolve();
    this.validationQueue = Promise.resolve();
  }

  observeCost(compiled, requestId) {
    this.state.waitUntil?.(observeCostEnvelope(compiled, this.env, `${requestId}-cost`, this.transportFactory));
  }

  fetch(request) {
    if (new URL(request.url).pathname === "/validation-query") {
      const work = this.validationQueue.then(() => this.validationQueryRequest(request));
      this.validationQueue = work.catch(() => undefined);
      return work;
    }
    const work = this.queue.then(() => this.route(request));
    this.queue = work.catch(() => undefined);
    return work;
  }

  async route(request) {
    const requestId = request.headers.get("x-policysql-request-id") ?? crypto.randomUUID();
    try {
      const body = await request.json().catch(() => { throw invalid(); });
      const action = new URL(request.url).pathname;
      if (action === "/begin") return json(await this.begin(body, requestId), 201);
      if (action === "/atomic") return json(await this.atomic(body, requestId));
      if (action === "/statement") return json(await this.statement(body, requestId));
      if (action === "/commit") return json(await this.terminal(body, requestId, "commit"));
      if (action === "/rollback") return json(await this.terminal(body, requestId, "rollback"));
      throw invalid();
    } catch (error) {
      const response = safeError(error, requestId);
      return json(response.body, response.status);
    }
  }

  async stored() {
    return await this.state.storage.get("transaction");
  }

  async persist(value) {
    await this.state.storage.put("transaction", value);
    return value;
  }

  async close(status) {
    if (this.transaction?.open) {
      try {
        if (status === "committed") await this.transaction.commit();
        else await this.transaction.rollback();
      } catch {
        status = "failed";
      }
    } else if (status === "committed") {
      status = "failed";
    }
    this.transaction = null;
    const current = await this.stored();
    if (current) await this.persist({ ...current, status, expiresAt: undefined });
    return status;
  }

  async active(body) {
    const current = await this.stored();
    if (!current || current.transactionId !== body.transactionId || current.authFingerprint !== body.authFingerprint) {
      throw unavailable();
    }
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

  async begin(body, requestId) {
    if (!exactKeys(body, ["transactionId", "authFingerprint", "startFingerprint", "mode", "auth", "expected"], ["transactionId", "authFingerprint", "startFingerprint", "mode", "auth"]) ||
      !/^tx_[a-f0-9]{32}$/.test(body.transactionId) ||
      !/^[a-f0-9]{64}$/.test(body.authFingerprint) ||
      !/^[a-f0-9]{64}$/.test(body.startFingerprint) ||
      !["read", "write"].includes(body.mode)) throw invalid();
    const previous = await this.stored();
    if (previous) {
      if (previous.startFingerprint !== body.startFingerprint || previous.authFingerprint !== body.authFingerprint) {
        throw conflict();
      }
      if (previous.status === "active" && !this.transaction) {
        await this.persist({ ...previous, status: "failed", expiresAt: undefined });
        throw unavailable();
      }
      return this.publicState(previous, requestId);
    }
    const transport = this.transportFactory(this.env, requestId);
    this.transaction = await transport.begin(body.mode, 1_000);
    const expiresAtMs = Date.now() + MAX_TRANSACTION_MS;
    const value = await this.persist({
      transactionId: body.transactionId,
      authFingerprint: body.authFingerprint,
      startFingerprint: body.startFingerprint,
      mode: body.mode,
      auth: body.auth,
      status: "active",
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
    await this.state.storage.setAlarm(expiresAtMs);
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

  async prepareCommand(body, kind) {
    const current = await this.active(body);
    if (!Number.isSafeInteger(body.command?.sequence) || body.command.sequence < 1) throw invalid();
    const digest = await sha256(stableJson({ kind, command: body.command }));
    if (body.command.sequence === current.nextSequence - 1 && current.last?.digest === digest) {
      return { replay: current.last.response };
    }
    if (current.status !== "active") throw unavailable();
    if (body.command.sequence !== current.nextSequence) {
      await this.close("failed");
      throw conflict();
    }
    return { current, digest };
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
    if (!exactKeys(body, ["transactionId", "authFingerprint", "command"], ["transactionId", "authFingerprint", "command"]) ||
      !exactKeys(body.command, ["sequence", "sql", "params", "expect"], ["sequence", "sql", "params"]) ||
      typeof body.command.sql !== "string" ||
      !body.command.params || Array.isArray(body.command.params) || typeof body.command.params !== "object") throw invalid();
    const prepared = await this.prepareCommand(body, "statement");
    if (prepared.replay) return prepared.replay;
    const { current, digest } = prepared;
    if (current.statementCount >= MAX_STATEMENTS) {
      await this.close("failed");
      throw new HttpError(429, "POLICYSQL_TRANSACTION_LIMIT_EXCEEDED", "The transaction limit was exceeded.");
    }
    const runtime = this.getRuntime();
    const envelope = JSON.stringify({ statements: [{
      sql: body.command.sql,
      params: body.command.params,
      ...(body.command.expect === undefined ? {} : { expect: body.command.expect }),
    }] });
    const compiled = JSON.parse(runtime.compile_json(JSON.stringify(current.auth), envelope, "execute"));
    const compileError = wasmError(compiled);
    if (compileError) {
      await this.close("failed");
      throw compileError;
    }
    if (current.mode === "read" && compiled.transactionMode !== "read") {
      runtime.release_execution(BigInt(compiled.executionHandle));
      await this.close("failed");
      throw new HttpError(403, "POLICYSQL_TRANSACTION_MODE_VIOLATION", "A read transaction cannot execute a mutation.");
    }
    let executed;
    try {
      executed = await executeSealedOnTransaction(runtime, compiled, this.transaction, requestId);
    } catch (error) {
      await this.close("failed");
      throw error;
    }
    this.observeCost(compiled, requestId);
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
    if (resultBytes > MAX_RESULT_BYTES) {
      await this.close("failed");
      throw new HttpError(429, "POLICYSQL_TRANSACTION_LIMIT_EXCEEDED", "The transaction limit was exceeded.");
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
    if (!exactKeys(body, ["transactionId", "authFingerprint", "command"], ["transactionId", "authFingerprint", "command"]) ||
      !exactKeys(body.command, ["sequence"], ["sequence"])) throw invalid();
    const prepared = await this.prepareCommand(body, kind);
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
    const status = await this.close(kind === "commit" ? "committed" : "rolled_back");
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

  async alarm() {
    const current = await this.stored();
    if (["active", "validating"].includes(current?.status)) await this.close("expired");
  }

  mergeChecks(current, incoming) {
    return [...new Map([...current, ...incoming].map((check) => [check.id, check])).values()]
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async activateValidation(current, session) {
    this.validation = session;
    await this.persist({ ...current, status: "validating" });
  }

  async deactivateValidation(current) {
    this.validation = null;
    if (!this.transaction?.open) {
      throw new HttpError(409, "POLICYSQL_COMMIT_CHECK_REJECTED", "A commit check rejected the transaction.");
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
      env: this.env,
      requestId,
      validationId: current.validationId ?? current.transactionId.replace(/^tx_/u, "cval_"),
      activate: (session) => this.activateValidation(current, session),
      deactivate: () => this.deactivateValidation(current),
      fetchImpl: this.fetchImpl,
      deadlineMs: current.expiresAtMs,
    });
  }

  async validationQueryRequest(request) {
    const requestId = request.headers.get("x-policysql-request-id") ?? crypto.randomUUID();
    try {
      const body = await request.json().catch(() => { throw invalid(); });
      return json(await this.validationQuery(body, request.headers.get("authorization"), requestId));
    } catch (error) {
      if (this.transaction?.open) await this.close("failed");
      this.validation = null;
      const response = safeError(error, requestId);
      return json(response.body, response.status);
    }
  }

  async validationQuery(command, authorization, requestId) {
    const session = this.validation;
    const current = await this.stored();
    if (!current || current.status !== "validating" || !this.transaction?.open ||
      !await verifyCapabilityToken(authorization, session) ||
      !exactKeys(command, ["sequence", "sql", "params"], ["sequence", "sql", "params"]) ||
      !Number.isSafeInteger(command.sequence) || command.sequence < 1 ||
      typeof command.sql !== "string" || !command.params || Array.isArray(command.params) ||
      typeof command.params !== "object") throw unavailable();
    const digest = await sha256(stableJson(command));
    if (command.sequence === session.nextSequence - 1 && session.last?.digest === digest) {
      return session.last.response;
    }
    if (command.sequence !== session.nextSequence || command.sequence > MAX_STATEMENTS) throw conflict();
    const runtime = this.getRuntime();
    const envelope = JSON.stringify({ statements: [{ sql: command.sql, params: command.params }] });
    const compiled = JSON.parse(runtime.compile_json(JSON.stringify(session.auth), envelope, "execute"));
    const compileError = wasmError(compiled);
    if (compileError) throw compileError;
    if (compiled.transactionMode !== "read" || compiled.statements.length !== 1) {
      runtime.release_execution(BigInt(compiled.executionHandle));
      throw conflict();
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
    if (rowsReturned > 100 || resultBytes > MAX_RESULT_BYTES) {
      throw new HttpError(429, "POLICYSQL_TRANSACTION_LIMIT_EXCEEDED", "The transaction limit was exceeded.");
    }
    this.validation = {
      ...session,
      nextSequence: session.nextSequence + 1,
      last: { digest, response },
      rowsReturned,
      resultBytes,
    };
    return response;
  }

  async atomic(body, requestId) {
    if (!exactKeys(body, ["validationId", "auth", "request", "idempotency"], ["validationId", "auth", "request", "idempotency"]) ||
      !/^cval_[a-f0-9]{32}$/u.test(body.validationId) || typeof body.request !== "string" ||
      !body.idempotency || typeof body.idempotency.keyHash !== "string" ||
      typeof body.idempotency.fingerprint !== "string") throw invalid();
    const runtime = this.getRuntime();
    const compiled = JSON.parse(runtime.compile_json(JSON.stringify(body.auth), body.request, "execute"));
    const compileError = wasmError(compiled);
    if (compileError) throw compileError;
    if (compiled.transactionMode !== "write") {
      runtime.release_execution(BigInt(compiled.executionHandle));
      throw invalid();
    }
    const transport = this.transportFactory(this.env, requestId);
    let released = false;
    try {
      this.transaction = await transport.begin("write", Math.min(...compiled.statements.map((item) => item.limits.timeoutMs)));
    } catch (error) {
      runtime.release_execution(BigInt(compiled.executionHandle));
      throw error;
    }
    const current = {
      transactionId: `atomic_${body.idempotency.keyHash.slice(0, 24)}`,
      validationId: body.validationId,
      auth: body.auth,
      status: "active",
      expiresAtMs: Date.now() + MAX_TRANSACTION_MS,
    };
    await this.persist(current);
    await this.state.storage.setAlarm(current.expiresAtMs);
    const started = performance.now();
    try {
      const [existing] = await this.transaction.execute([{
        sql: "SELECT fingerprint, response_json FROM policysql_idempotency WHERE key_hash = :key_hash",
        args: { key_hash: body.idempotency.keyHash },
      }]);
      if (existing.rows.length === 1) {
        const [fingerprint, responseJson] = existing.rows[0];
        if (fingerprint !== body.idempotency.fingerprint) throw conflict();
        const stored = storedAtomicTerminal(responseJson);
        runtime.release_execution(BigInt(compiled.executionHandle));
        await this.transaction.rollback();
        this.transaction = null;
        await this.persist({ ...current, status: "committed" });
        return stored;
      }
      if (existing.rows.length !== 0) throw conflict();
      const executed = await executeSealedOnTransaction(runtime, compiled, this.transaction, requestId);
      released = true;
      this.observeCost(compiled, requestId);
      enforceCumulativeLimits(compiled, executed.results, performance.now() - started);
      const commitChecks = await this.checksForCurrent(current, requestId, compiled, executed.results);
      const usage = {
        rowsReturned: executed.results.reduce((sum, result) => sum + result.rowCount, 0),
        rowsAffected: executed.results.reduce((sum, result) => sum + (result.affectedRows ?? 0), 0),
        rowsRead: executed.usage.rowsRead,
        rowsWritten: executed.usage.rowsWritten,
        queryDurationMs: Math.round(executed.usage.queryDurationMs * 1000) / 1000,
      };
      const terminal = {
        version: 1,
        transactionId: current.transactionId,
        status: "committed",
        results: executed.results,
        usage,
        originalRequestId: requestId,
        replayed: false,
        commitChecks,
      };
      await this.transaction.execute([{
        sql: "INSERT INTO policysql_idempotency (key_hash, fingerprint, response_json) VALUES (:key_hash, :fingerprint, :response_json)",
        args: {
          key_hash: body.idempotency.keyHash,
          fingerprint: body.idempotency.fingerprint,
          response_json: JSON.stringify(terminal),
        },
      }]);
      await this.transaction.commit();
      this.transaction = null;
      this.validation = null;
      await this.persist({ ...current, status: "committed" });
      return terminal;
    } catch (error) {
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
