import { PolicySqlError, copyJson, validateResult, unavailable } from "../client/protocol.js";

class Connection {
  #client;
  #config;
  #compiled;
  #queue = Promise.resolve();
  #released = false;
  #ending;
  #onClosed;
  #transactionDeadline;
  #beginAbort;
  transaction;

  constructor(client, config, compiled, onClosed) {
    this.#client = client;
    this.#config = config;
    this.#compiled = compiled;
    this.#onClosed = onClosed;
  }
  #enqueue(work) {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => undefined);
    return result;
  }
  begin(settings) {
    return this.#enqueue(async () => {
      if (settings.isolationLevel !== undefined) throw new TypeError("explicit isolation levels are not supported");
      if (settings.accessMode !== undefined && !["read only", "read write"].includes(settings.accessMode)) throw new TypeError("unsupported access mode");
      if (this.transaction || this.#released) throw unavailable();
      this.#beginAbort = new AbortController();
      try {
        this.transaction = await this.#client.beginTransaction({ mode: settings.accessMode === "read only" ? "read" : "write", signal: this.#beginAbort.signal });
      } finally { this.#beginAbort = undefined; }
      this.#transactionDeadline = Date.parse(this.transaction.expiresAt);
      // Local expiry is not resource release: keep in-flight commands owned until disposal.
      // destroy() may have started while the HTTP begin was in flight.
      if (this.#released) {
        await this.transaction.dispose();
        throw unavailable();
      }
    });
  }

  executeQuery(query, { signal } = {}) {
    if (this.#released || this.#ending) return Promise.reject(unavailable());
    const context = this.#compiled.get(query);
    if (!context) return Promise.reject(new TypeError("query must be compiled by this PolicySqlDialect"));
    return this.#enqueue(async () => {
      if (this.#released) throw unavailable();
      signal?.throwIfAborted();
      const { operation, options } = context;
      const mutation = operation !== "select";
      if (this.transaction && options.idempotencyKey !== undefined) throw new TypeError("idempotencyKey is not supported inside transactions");
      if (this.transaction?.mode === "read" && mutation) throw new TypeError("a read-only transaction cannot mutate");
      let key = options.idempotencyKey;
      if (!this.transaction && mutation && key === undefined && this.#config.autoIdempotencyKey) {
        if (typeof globalThis.crypto?.randomUUID !== "function") throw new TypeError("autoIdempotencyKey requires crypto.randomUUID");
        key = crypto.randomUUID();
      }
      if (!mutation && key !== undefined) throw new TypeError("idempotencyKey requires a mutation query");
      const params = Object.fromEntries(query.parameters.map((value, index) => [`p${index + 1}`, value]));
      const response = await (this.transaction
        ? this.transaction.execute(query.sql, params, { ...(options.expect === undefined ? {} : { expect: options.expect }), signal })
        : this.#client.execute(query.sql, params, {
          ...(key === undefined ? {} : { idempotencyKey: key }),
          ...(options.expect === undefined ? {} : { expect: options.expect }), signal,
        }));
      validateResult(response);
      if (mutation && (!Number.isSafeInteger(response.affectedRows) || response.affectedRows < 0)) {
        throw new TypeError("PolicySQL mutation response must include a non-negative safe affectedRows count");
      }
      // The observer and result plugins never share mutable rows/redaction metadata.
      const rows = copyJson(response.rows);
      return {
        result: { rows, ...(mutation ? { numAffectedRows: BigInt(response.affectedRows) } : {}) },
        response: options.onResponse ? copyJson(response) : undefined,
      };
    }).then(async ({ result, response }) => {
      // Application observers must not hold our command queue. Kysely itself retains
      // its connection while consuming the result, so bound an async observer too.
      if (context.options.onResponse) {
        const deadline = this.#transactionDeadline ?? Date.now() + 5_000;
        let timer;
        try {
          await Promise.race([
            Promise.resolve().then(() => context.options.onResponse(response)),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new PolicySqlError(
                "PolicySQL response observer timed out.", "POLICYSQL_OBSERVER_TIMEOUT",
              )), Math.max(0, deadline - Date.now()));
            }),
          ]);
        } finally { clearTimeout(timer); }
      }
      return result;
    });
  }
  terminal(kind) {
    // Shutdown blocks new commits, but Kysely's rollback-on-error must still reach
    // the transaction's saved outcome, including after dispose() has completed.
    if (!this.transaction || (this.#released && kind === "commit")) return Promise.reject(unavailable());
    // Delegate conflicting terminal attempts to the transaction so an unknown commit
    // propagates its original outcome error rather than a misleading rollback result.
    this.#ending ??= kind;
    return this.#enqueue(() => {
      // destroy() may already have rolled back this transaction. Acknowledge that
      // result without another request or masking the callback's original error.
      if (kind === "rollback" && this.transaction.status === "rolled_back") return;
      return this.transaction[kind]();
    });
  }
  async *streamQuery() { throw new TypeError("PolicySQL streaming is not supported"); }
  async dispose() {
    this.#released = true;
    this.#beginAbort?.abort();
    // Stop unsent transaction work now, before waiting for the connection queue.
    const closing = this.transaction?.dispose();
    void closing?.catch(() => undefined);
    try {
      await this.#queue;
      await (closing ?? this.transaction?.dispose());
    } finally { this.#onClosed(); }
  }
}

export class PolicySqlDriver {
  #client;
  #config;
  #compiled;
  #active = new Set();
  #owned = new WeakSet();
  #destroyed = false;
  constructor(client, config, compiled) {
    this.#client = client;
    this.#config = config;
    this.#compiled = compiled;
  }
  async init() {}
  async acquireConnection() {
    if (this.#destroyed) throw new Error("PolicySQL driver has been destroyed");
    const connection = new Connection(this.#client, this.#config, this.#compiled, () => this.#active.delete(connection));
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
    // Cleanup remains valid during shutdown; the transaction owns its outcome.
    this.#assert(connection);
    await connection.terminal("rollback");
  }
  async releaseConnection(connection) {
    this.#assert(connection);
    // Cleanup must not mask a query/commit error. The transaction already reports any
    // uncertain command; its remote owner also enforces its independent expiry.
    await connection.dispose().catch(() => undefined);
  }
  async destroy() {
    this.#destroyed = true;
    await Promise.allSettled([...this.#active].map((connection) => connection.dispose()));
    this.#active.clear();
  }
}
