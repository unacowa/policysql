import { copyJson, unavailable } from "../client/protocol.js";
import { extractOptions, operation } from "./options.js";

class Connection {
  #client;
  #config;
  #pending = new Set();
  #released = false;
  #onClosed;
  #cancellation = new AbortController();
  transaction;

  constructor(client, config, onClosed) {
    this.#client = client;
    this.#config = config;
    this.#onClosed = onClosed;
  }
  // Client owns command ordering and terminal state. Track only communication
  // that shutdown must await, without retaining observers or serializing again.
  #track(promise) {
    this.#pending.add(promise);
    const settled = () => this.#pending.delete(promise);
    void promise.then(settled, settled);
    return promise;
  }
  begin(settings) {
    if (settings.isolationLevel !== undefined) throw new TypeError("explicit isolation levels are not supported");
    if (settings.accessMode !== undefined && !["read only", "read write"].includes(settings.accessMode)) throw new TypeError("unsupported access mode");
    if (this.transaction || this.#released) throw unavailable();
    return this.#track(this.#client.beginTransaction({ mode: settings.accessMode === "read only" ? "read" : "write", signal: this.#cancellation.signal }).then(async transaction => {
      this.transaction = transaction;
      void transaction.closed.then(this.#onClosed);
      // destroy() may have started while the HTTP begin was in flight.
      if (this.#released) {
        await transaction.dispose();
        throw unavailable();
      }
    }));
  }

  async executeQuery(query, { signal } = {}) {
    if (this.#released) throw unavailable();
    const { node, options } = extractOptions(query.query);
    const mutation = operation(node) !== "select";
    signal = signal ? AbortSignal.any([signal, this.#cancellation.signal]) : this.#cancellation.signal;
    signal.throwIfAborted();
    if (this.transaction && options.idempotencyKey !== undefined) throw new TypeError("idempotencyKey is not supported inside transactions");
    let key = options.idempotencyKey;
    if (!this.transaction && mutation && key === undefined && this.#config.autoIdempotencyKey) {
      if (typeof globalThis.crypto?.randomUUID !== "function") throw new TypeError("autoIdempotencyKey requires crypto.randomUUID");
      key = crypto.randomUUID();
    }
    if (!mutation && key !== undefined) throw new TypeError("idempotencyKey requires a mutation query");
    const params = Object.fromEntries(query.parameters.map((value, index) => [`p${index + 1}`, value]));
    const response = await this.#track(this.transaction
      ? this.transaction.execute(query.sql, params, { ...(options.expect === undefined ? {} : { expect: options.expect }), signal })
      : this.#client.execute(query.sql, params, {
        ...(key === undefined ? {} : { idempotencyKey: key }),
        ...(options.expect === undefined ? {} : { expect: options.expect }), signal,
      }));
    if (mutation && response.affectedRows === undefined) throw new TypeError("PolicySQL mutation response must include affectedRows");
    const result = { rows: response.rows, ...(mutation ? { numAffectedRows: BigInt(response.affectedRows) } : {}) };
    // Client already validates and copies responses. Only the observer needs a
    // separate snapshot so its mutations cannot affect Kysely result plugins.
    await options.onResponse?.(copyJson(response));
    return result;
  }
  terminal(kind) {
    // Shutdown blocks new commits, but rollback-on-error must still reach the
    // transaction's saved outcome, including after dispose() has completed.
    if (!this.transaction || (this.#released && kind === "commit")) return Promise.reject(unavailable());
    if (kind === "rollback" && this.transaction.status === "rolled_back") return Promise.resolve();
    return this.#track(this.transaction[kind](kind === "commit" ? { signal: this.#cancellation.signal } : {}));
  }
  async *streamQuery() { throw new TypeError("PolicySQL streaming is not supported"); }
  async dispose() {
    this.#released = true;
    this.#cancellation.abort();
    try {
      // Execution failures belong to their callers; newly initiated cleanup
      // failures propagate from transaction.dispose().
      await Promise.allSettled(this.#pending);
      await this.transaction?.dispose();
    } finally { this.#onClosed(); }
  }
}

export class PolicySqlDriver {
  #client;
  #config;
  #active = new Set();
  #owned = new WeakSet();
  #destroyed = false;
  constructor(client, config) {
    this.#client = client;
    this.#config = config;
  }
  async init() {}
  async acquireConnection() {
    if (this.#destroyed) throw new Error("PolicySQL driver has been destroyed");
    const connection = new Connection(this.#client, this.#config, () => this.#active.delete(connection));
    this.#active.add(connection);
    this.#owned.add(connection);
    return connection;
  }
  #assert(connection) {
    if (!this.#owned.has(connection)) throw new TypeError("foreign PolicySQL connection");
  }
  async beginTransaction(connection, settings) {
    this.#assert(connection);
    try { await connection.begin(settings); }
    catch (error) {
      // ControlledTransactionBuilder doesn't release a connection when begin fails.
      await connection.dispose().catch(() => undefined);
      throw error;
    }
  }
  async commitTransaction(connection) { if (this.#destroyed) throw unavailable(); this.#assert(connection); await connection.terminal("commit"); }
  async rollbackTransaction(connection) {
    this.#assert(connection);
    await connection.terminal("rollback");
  }
  async releaseConnection(connection) {
    this.#assert(connection);
    // Kysely releases in finally; cleanup must not replace an execution error.
    await connection.dispose().catch(() => undefined);
  }
  async destroy() {
    this.#destroyed = true;
    const results = await Promise.allSettled([...this.#active].map(connection => connection.dispose()));
    this.#active.clear();
    const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "PolicySQL cleanup failed");
  }
}
