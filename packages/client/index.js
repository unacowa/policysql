import { PolicySqlTransaction } from './transaction.js';
import { releaseTransportResource } from '../transport/cleanup.js';
import { onlyKeys, validateRole } from '../transport/index.js';
import {
  PolicySqlError, PolicySqlOutcomeUnknownError, object, protocolError, required, validateKey,
  statement, validateResult, retryable, uncertain, unknown, command, sendOperation, transportError,
} from './protocol.js';
export { PolicySqlError, PolicySqlOutcomeUnknownError };

export class PolicySqlClient {
  #transport;
  #role;
  #expected;
  constructor(options) {
    if (!onlyKeys(options, ['transport', 'role', 'schemaVersion', 'policyVersion'])) throw new TypeError('invalid client options; supply a transport');
    const { transport, role, schemaVersion, policyVersion } = options;
    if (!object(transport) || typeof transport.createScope !== 'function' || typeof transport.dispose !== 'function' ||
      !object(transport.descriptor) || typeof transport.descriptor.endpointId !== 'string' || !transport.descriptor.endpointId) throw new TypeError('transport is required');
    this.#role = validateRole(role);
    if ((schemaVersion === undefined) !== (policyVersion === undefined)) throw new TypeError('schemaVersion and policyVersion must be supplied together');
    if (schemaVersion !== undefined) this.#expected = Object.freeze({ schemaVersion: required(schemaVersion, 'schemaVersion'), policyVersion: required(policyVersion, 'policyVersion') });
    this.#transport = transport;
    Object.freeze(this);
  }
  get role() { return this.#role; }
  get schemaVersion() { return this.#expected?.schemaVersion; }
  get policyVersion() { return this.#expected?.policyVersion; }
  #scope() {
    try {
      const scope = this.#transport.createScope({ role: this.#role });
      if (!scope || typeof scope.createOperation !== 'function' || typeof scope.beginShutdown !== 'function' || typeof scope.dispose !== 'function') throw 0;
      return scope;
    } catch { throw transportError('POLICYSQL_TRANSPORT_ERROR', 'not-sent'); }
  }
  async execute(sql, params = {}, options = {}) {
    if (!onlyKeys(options, ['idempotencyKey', 'expect', 'signal'])) throw new TypeError('invalid execute options');
    const key = validateKey(options.idempotencyKey);
    const body = JSON.stringify({ ...(this.#expected === undefined ? {} : { expected: this.#expected }), statements: [statement(sql, params, options.expect)] });
    const scope = this.#scope();
    let operation;
    try {
      try { operation = scope.createOperation(command('execute', body, undefined, key), { purpose: 'execute' }); }
      catch { throw transportError('POLICYSQL_TRANSPORT_ERROR', 'not-sent'); }
      const response = await sendOperation(operation, options.signal);
      if (response.status !== 'committed' || !Array.isArray(response.results) || response.results.length !== 1 || !object(response.meta)) throw protocolError();
      validateResult(response.results[0]);
      return { ...response.results[0], envelopeMeta: response.meta, ...(response.debug ? { debug: response.debug } : {}) };
    } catch (error) {
      if (uncertain(error)) throw unknown(undefined, 'execute');
      throw error;
    } finally {
      await releaseTransportResource(operation);
      await releaseTransportResource(scope);
    }
  }
  async beginTransaction(options = {}) {
    if (!onlyKeys(options, ['mode', 'signal'])) throw new TypeError('invalid transaction start options');
    const { mode = 'write', signal } = options;
    if (!['read', 'write'].includes(mode)) throw new TypeError('invalid transaction mode');
    const body = JSON.stringify({ mode, ...(this.#expected === undefined ? {} : { expected: this.#expected }) });
    const scope = this.#scope();
    let operation;
    let transferred = false;
    let originalUnknown;
    try {
      try { operation = scope.createOperation(command('begin', body), { purpose: 'execute' }); }
      catch { throw transportError('POLICYSQL_TRANSPORT_ERROR', 'not-sent'); }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await sendOperation(operation, signal);
          if (!/^tx_[a-f0-9]{32}$/.test(response.transactionId) || response.status !== 'active' || response.nextSequence !== 1 ||
            typeof response.expiresAt !== 'string' || !Number.isFinite(Date.parse(response.expiresAt)) ||
            Date.parse(response.expiresAt) <= Date.now() || !object(response.meta)) throw protocolError();
          if (signal?.aborted) throw transportError('POLICYSQL_REQUEST_CANCELLED', 'possibly-sent');
          const transaction = new PolicySqlTransaction(response, mode, scope);
          transferred = true;
          return transaction;
        } catch (error) {
          if (uncertain(error)) originalUnknown ??= unknown(undefined, 'begin');
          if (attempt === 1 || !retryable(error) || signal?.aborted) throw originalUnknown ?? error;
        }
      }
    } finally {
      await releaseTransportResource(operation);
      if (!transferred) await releaseTransportResource(scope);
    }
  }
}
