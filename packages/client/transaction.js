import { PolicySqlOutcomeUnknownError, object, protocolError, statement, validateResult, validateOptions, unavailable, sendCommand } from "./protocol.js";

// The queue owns sequence allocation. An uncertain command stays fixed until the
// caller explicitly confirms that same command; no callback or command is replayed automatically.
export class PolicySqlTransaction {
  #transport;
  #role;
  #queue = Promise.resolve();
  #pending;
  #failure;
  #state = "active";
  #closing;
  #sequence = 1;
  #settle;
  #disposed = false;
  #disposing;

  constructor(response, mode, transport, role) {
    this.id = response.transactionId;
    this.mode = mode;
    this.expiresAt = response.expiresAt;
    this.#transport = transport;
    this.#role = role;
    this.closed = new Promise((resolve) => { this.#settle = resolve; });
    Object.freeze(this);
  }
  get status() { return this.#state; }
  get nextSequence() { return this.#sequence; }

  #enqueue(work) {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => undefined);
    return result;
  }
  #assertActive() {
    if (this.#failure) throw this.#failure;
    if (this.#disposed || this.#state !== "active") throw unavailable();
  }

  execute(sql, params = {}, options = {}) {
    validateOptions(options, ["expect", "signal"]);
    const { expect, signal } = options;
    if (this.#closing || this.#disposed || this.#disposing) return Promise.reject(this.#failure ?? unavailable());
    const item = statement(sql, params, expect);
    return this.#enqueue(async () => {
      this.#assertActive();
      const response = await this.#command("statement", { sequence: this.#sequence, ...item }, signal);
      return { ...response.result, envelopeMeta: response.meta };
    });
  }

  commit(options = {}) { return this.#terminal("commit", options); }
  rollback(options = {}) { return this.#terminal("rollback", options); }

  #terminal(kind, options) {
    validateOptions(options, ["signal"]);
    const { signal } = options;
    if (this.#disposed || this.#disposing) return Promise.reject(this.#failure ?? unavailable());
    if (this.#closing && this.#closing !== kind) return Promise.reject(this.#failure ?? unavailable());
    this.#closing = kind;
    return this.#enqueue(async () => {
      try {
        if (this.#state === (kind === "commit" ? "committed" : "rolled_back")) return;
        if (this.#pending) {
          if (this.#pending.kind !== kind) throw this.#failure ?? unavailable();
          await this.#sendPending(signal);
          return;
        }
        this.#assertActive();
        await this.#command(kind, { sequence: this.#sequence }, signal);
      } catch (error) {
        // A rejected, unsent terminal operation must not close admission after
        // the caller subsequently confirms an earlier statement.
        if (this.#pending?.kind !== kind) this.#closing = undefined;
        throw error;
      }
    });
  }

  #command(kind, payload, signal) {
    if (this.#pending) throw this.#failure ?? unavailable();
    signal?.throwIfAborted();
    this.#pending = Object.freeze({
      kind, transactionId: this.id, body: JSON.stringify(payload),
      ...(this.#role === undefined ? {} : { role: this.#role }),
    });
    return this.#sendPending(signal);
  }

  async #sendPending(signal) {
    const pending = this.#pending;
    try {
      const response = await sendCommand(this.#transport, pending, {
        transactionId: this.id, phase: pending.kind, sequence: this.#sequence,
      }, (response) => {
        if (response.transactionId !== this.id || !object(response.meta)) throw protocolError();
        if (pending.kind === "statement") {
          if (response.status !== "active" || response.nextSequence !== this.#sequence + 1 ||
            response.result?.sequence !== this.#sequence) throw protocolError();
          validateResult(response.result);
        } else if (response.status !== (pending.kind === "commit" ? "committed" : "rolled_back")) throw protocolError();
      }, signal);
      this.#state = response.status;
      this.#sequence++;
      this.#pending = undefined;
      this.#failure = undefined;
      if (pending.kind !== "statement") this.#settle();
      return response;
    } catch (error) {
      // Later rejection/cancellation cannot settle an earlier ambiguous attempt.
      if (this.#failure) {
        // Applications may freeze caught errors; diagnostic updates must not mask them.
        try { this.#failure.lastError = error; } catch { /* Keep the original error. */ }
        throw this.#failure;
      }
      if (error instanceof PolicySqlOutcomeUnknownError) {
        this.#failure = error;
        this.#state = "unknown";
      } else {
        this.#pending = undefined;
        this.#failure = error;
        this.#state = "failed";
        this.#settle();
      }
      throw error;
    }
  }

  retryPending(options = {}) {
    validateOptions(options, ["signal"]);
    const { signal } = options;
    if (this.#disposed || this.#disposing) return Promise.reject(this.#failure ?? unavailable());
    return this.#enqueue(async () => {
      if (!this.#pending || this.#disposed) throw this.#failure ?? unavailable();
      const response = await this.#sendPending(signal);
      return response.result ? { ...response.result, envelopeMeta: response.meta } : undefined;
    });
  }

  dispose() {
    if (this.#disposing) return this.#disposing;
    this.#disposing = this.#enqueue(async () => {
      try {
        if (this.#state === "active" && !this.#pending && !this.#closing) {
          await this.#command("rollback", { sequence: this.#sequence });
        }
      } finally {
        this.#disposed = true;
        this.#settle();
      }
    });
    return this.#disposing;
  }
}
