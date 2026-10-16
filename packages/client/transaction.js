import { object, protocolError, required, statement, validateResult, retryable, unavailable, unknown } from "./protocol.js";

// One instance owns one remote transaction. Sequence allocation and all terminal commands
// share this queue; an uncertain command remains immutable until it is reconciled.
export class PolicySqlTransaction {
  #request;
  #queue = Promise.resolve();
  #pending;
  #failure;
  #state = "active";
  #closing;
  #sequence = 1;
  #timer;
  #settle;
  #disposed = false;
  #deadline;

  constructor(response, mode, request) {
    this.id = required(response.transactionId, "transactionId");
    this.mode = mode;
    this.expiresAt = response.expiresAt;
    this.#deadline = Math.min(Date.parse(response.expiresAt), Date.now() + 4_000);
    this.#request = request;
    this.closed = new Promise((resolve) => { this.#settle = resolve; });
    this.#timer = setTimeout(() => {
      if (this.#state === "active") this.#state = "expired";
      this.#settle();
    }, Math.max(0, this.#deadline - Date.now()));
    this.#timer.unref?.();
    Object.freeze(this);
  }
  get status() { return this.#state; }
  get nextSequence() { return this.#sequence; }

  #enqueue(work) {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => undefined);
    return result;
  }
  #finished(state) {
    this.#state = state;
    clearTimeout(this.#timer);
    this.#settle();
  }
  #assertActive() {
    if (this.#failure) throw this.#failure;
    if (this.#disposed || this.#state !== "active" || Date.now() >= this.#deadline) throw unavailable();
  }

  execute(sql, params = {}, options = {}) {
    if (!object(options) || Object.keys(options).some((key) => !["expect", "signal"].includes(key))) {
      return Promise.reject(new TypeError("transaction statements accept expect and signal, not idempotencyKey"));
    }
    if (this.#closing || this.#disposed) return Promise.reject(this.#failure ?? unavailable());
    // Copy parameters before waiting in a queue, rather than observing later caller mutations.
    const item = statement(sql, params, options.expect);
    return this.#enqueue(async () => {
      this.#assertActive();
      const response = await this.#command("statements", { sequence: this.#sequence, ...item }, options.signal);
      return { ...response.result, envelopeMeta: response.meta };
    });
  }

  commit() { return this.#terminal("commit"); }
  rollback() { return this.#terminal("rollback"); }

  #terminal(kind) {
    if (this.#disposed) return Promise.reject(this.#failure ?? unavailable());
    if (this.#closing && this.#closing !== kind) return Promise.reject(this.#failure ?? unavailable());
    this.#closing = kind;
    return this.#enqueue(async () => {
      const done = kind === "commit" ? "committed" : "rolled_back";
      if (this.#state === done) return;
      if (this.#pending) {
        if (this.#pending.kind !== kind) throw this.#failure ?? unavailable();
        await this.#sendPending();
        return;
      }
      this.#assertActive();
      await this.#command(kind, { sequence: this.#sequence });
    });
  }

  async #command(kind, payload, signal) {
    if (this.#pending) throw this.#failure ?? unavailable();
    signal?.throwIfAborted();
    this.#pending = { kind, sequence: this.#sequence, body: JSON.stringify(payload) };
    return this.#sendPending(signal);
  }

  async #sendPending(signal) {
    const pending = this.#pending;
    // Terminal replay is also useful after the live transaction deadline, while its
    // completed command is retained. Never use this extension to send new statements.
    const deadline = pending.kind === "statements" ? this.#deadline : Math.max(this.#deadline, Date.now() + 2_000);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.#request(`/v1/transactions/${this.id}/${pending.kind}`, pending.body, { deadline, signal });
        if (response.transactionId !== this.id || !object(response.meta)) throw protocolError();
        if (pending.kind === "statements") {
          if (response.status !== "active" || response.nextSequence !== pending.sequence + 1 ||
            response.result?.sequence !== pending.sequence) throw protocolError();
          validateResult(response.result);
          this.#state = "active";
        } else {
          if (response.status !== (pending.kind === "commit" ? "committed" : "rolled_back")) throw protocolError();
          this.#finished(response.status);
        }
        this.#sequence = pending.sequence + 1;
        this.#pending = undefined;
        this.#failure = undefined;
        return response;
      } catch (error) {
        // A previous attempt may already have committed. A later auth/owner error does
        // not prove rollback; keep the same unknown result instead of contradicting it.
        if (!retryable(error) && !this.#failure) {
          this.#pending = undefined;
          this.#failure = error;
          this.#finished("failed");
          throw error;
        }
        this.#failure ??= unknown(this.id, pending.kind === "statements" ? "statement" : pending.kind, pending.sequence);
        this.#state = "unknown";
        if (attempt === 1 || Date.now() >= deadline || signal?.aborted) throw this.#failure;
      }
    }
  }

  // Low-level recovery of the exact outstanding command; it never runs user callbacks.
  retryPending() {
    return this.#enqueue(async () => {
      if (!this.#pending || this.#disposed) throw this.#failure ?? unavailable();
      const response = await this.#sendPending();
      return response.result ? { ...response.result, envelopeMeta: response.meta } : undefined;
    });
  }

  async dispose() {
    if (this.#disposed) return;
    try {
      if (this.#state === "active" && !this.#pending && !this.#closing) await this.rollback();
      else await this.#queue;
    } finally {
      this.#disposed = true;
      clearTimeout(this.#timer);
      this.#settle();
    }
  }
}
