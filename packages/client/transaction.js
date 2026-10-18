import { object, protocolError, required, statement, validateResult, retryable, uncertain, unavailable, unknown, command, sendOperation, transportError, signalOptions } from './protocol.js';
import { releaseTransportResource } from '../transport/cleanup.js';

// Protocol state survives operation disposal. Every attempt has its own timeout;
// recovery retains the original command and every unresolved outcome.
export class PolicySqlTransaction {
  #scope;
  #queue = Promise.resolve();
  #pending;
  #failure;
  #state = 'active';
  #closing;
  #sequence = 1;
  #timer;
  #settle;
  #disposed = false;
  #disposing;
  #deadline;
  constructor(response, mode, scope) {
    this.id = required(response.transactionId, 'transactionId');
    this.mode = mode;
    this.expiresAt = response.expiresAt;
    this.#deadline = Date.parse(response.expiresAt);
    this.#scope = scope;
    this.closed = new Promise(resolve => { this.#settle = resolve; });
    const expire = () => {
      const remaining = this.#deadline - Date.now();
      if (remaining > 0) {
        this.#timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
        this.#timer.unref?.();
      } else {
        if (this.#state === 'active') this.#state = 'expired';
        this.#settle();
      }
    };
    expire();
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
    if (this.#disposed || this.#disposing || this.#state !== 'active' || Date.now() >= this.#deadline) throw unavailable();
  }
  execute(sql, params = {}, options = {}) {
    if (!object(options) || Object.keys(options).some(key => !['expect', 'signal'].includes(key))) return Promise.reject(new TypeError('transaction statements accept expect and signal, not idempotencyKey'));
    if (this.#closing || this.#disposed || this.#disposing) return Promise.reject(this.#failure ?? unavailable());
    const item = statement(sql, params, options.expect);
    return this.#enqueue(async () => {
      this.#assertActive();
      const response = await this.#command('statement', { sequence: this.#sequence, ...item }, options.signal);
      return { ...response.result, envelopeMeta: response.meta };
    });
  }
  commit(options) { return this.#terminal('commit', signalOptions(options)); }
  rollback(options) { return this.#terminal('rollback', signalOptions(options)); }
  #terminal(kind, signal) {
    if (this.#disposed || this.#disposing) return Promise.reject(this.#failure ?? unavailable());
    if (this.#closing && this.#closing !== kind) return Promise.reject(this.#failure ?? unavailable());
    this.#closing = kind;
    return this.#enqueue(async () => {
      const done = kind === 'commit' ? 'committed' : 'rolled_back';
      if (this.#state === done) return;
      if (this.#pending) {
        if (this.#pending.kind !== kind) throw this.#failure ?? unavailable();
        await this.#sendPending(signal);
        return;
      }
      this.#assertActive();
      await this.#command(kind, { sequence: this.#sequence }, signal);
    });
  }
  async #command(kind, payload, signal, purpose = 'execute') {
    if (this.#pending) throw this.#failure ?? unavailable();
    this.#pending = { kind, sequence: this.#sequence, command: command(kind, JSON.stringify(payload), this.id) };
    return this.#sendPending(signal, purpose);
  }
  async #sendPending(signal, purpose = 'execute') {
    const pending = this.#pending;
    if (pending.kind === 'statement' && Date.now() >= this.#deadline) throw this.#failure ?? unavailable();
    if (pending.kind !== 'statement' && this.#failure?.code === 'POLICYSQL_OUTCOME_UNKNOWN') purpose = 'confirm-terminal';
    let operation;
    try {
      try { operation = this.#scope.createOperation(pending.command, { purpose, serverExpiresAt: this.expiresAt }); }
      catch { throw transportError('POLICYSQL_TRANSPORT_ERROR', 'not-sent'); }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await sendOperation(operation, signal);
          if (response.transactionId !== this.id || !object(response.meta)) throw protocolError();
          if (pending.kind === 'statement') {
            if (response.status !== 'active' || response.nextSequence !== pending.sequence + 1 || response.result?.sequence !== pending.sequence) throw protocolError();
            validateResult(response.result);
            this.#state = Date.now() < this.#deadline ? 'active' : 'expired';
          } else {
            if (response.status !== (pending.kind === 'commit' ? 'committed' : 'rolled_back')) throw protocolError();
            this.#finished(response.status);
          }
          this.#sequence = pending.sequence + 1;
          this.#pending = undefined;
          this.#failure = undefined;
          return response;
        } catch (error) {
          if (uncertain(error) && !this.#failure) this.#failure = unknown(this.id, pending.kind, pending.sequence);
          if (this.#failure) {
            this.#state = 'unknown';
            if (error.code !== 'POLICYSQL_OUTCOME_UNKNOWN') this.#failure.recoveryFailure = { code: error.code, ...(error.status === undefined ? {} : { status: error.status }) };
          }
          if (attempt === 1 || !retryable(error) || signal?.aborted) throw this.#failure ?? error;
        }
      }
    } catch (error) {
      if (this.#failure) throw this.#failure;
      this.#pending = undefined;
      this.#closing = undefined;
      // A proven unsent command leaves the remote transaction available for cleanup.
      if (error.delivery !== 'not-sent') {
        this.#failure = error;
        this.#finished('failed');
      }
      throw error;
    } finally {
      await releaseTransportResource(operation);
      if (['committed', 'rolled_back', 'failed'].includes(this.#state)) await releaseTransportResource(this.#scope);
    }
  }
  retryPending(options) {
    const signal = signalOptions(options);
    return this.#enqueue(async () => {
      if (!this.#pending || this.#disposed || this.#disposing) throw this.#failure ?? unavailable();
      const response = await this.#sendPending(signal);
      return response.result ? { ...response.result, envelopeMeta: response.meta } : undefined;
    });
  }
  dispose() {
    if (this.#disposing) return this.#disposing;
    if (this.#disposed) return Promise.resolve();
    try { this.#scope.beginShutdown(); } catch { /* Keep the protocol outcome. */ }
    this.#disposing = Promise.resolve().then(async () => {
      try {
        await this.#queue;
        if (this.#state === 'active' && !this.#pending && !this.#closing && Date.now() < this.#deadline) {
          await this.#command('rollback', { sequence: this.#sequence }, undefined, 'cleanup-rollback');
        }
      } finally {
        this.#disposed = true;
        clearTimeout(this.#timer);
        this.#settle();
        await releaseTransportResource(this.#scope);
      }
    });
    return this.#disposing;
  }
}
