import { copyCommand, copyOperationOptions, failure, identifier, onlyKeys, positiveDuration, record, validateRole, sanitizeReply } from './index.js';
import { createOperation } from './operation.js';
import { releaseTransportResource } from './cleanup.js';
import { contextKey, timeout } from './internal.js';

const routes = Object.freeze({
  execute: '/v1/transactions:execute', begin: '/v1/transactions', explain: '/v1/transactions:explain',
  catalog: '/v1/catalog', capabilities: '/v1/capabilities',
});
const authError = code => ({ code });
const readBody = async response => {
  const maximum = 2_097_152;
  if (Number(response.headers.get('content-length')) > maximum || !response.body) throw new Error('invalid response');
  const reader = response.body.getReader();
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) throw new Error('response too large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    try { await reader.cancel(); } catch { /* Preserve the parsed response. */ }
    try { reader.releaseLock(); } catch { /* Preserve the parsed response. */ }
  }
};
const tokenExpiry = token => {
  try {
    if (typeof token !== 'string' || token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw 0;
    const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    if (!Number.isSafeInteger(payload.exp) || payload.exp <= 0 || !Number.isSafeInteger(payload.exp * 1000)) throw 0;
    return payload.exp * 1000;
  } catch { throw authError('POLICYSQL_AUTH_REQUIRED'); }
};

export function createHttpTransport(config) {
  if (!onlyKeys(config, ['endpoint', 'token', 'tokenProvider', 'fetchImpl', 'timeoutMs', 'transactionMaxDurationMs', 'clockToleranceMs'])) throw new TypeError('invalid HTTP transport options');
  const endpoint = new URL(config.endpoint);
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && endpoint.hostname === 'localhost')) ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new TypeError('invalid HTTP endpoint');
  const fetchImpl = config.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const provider = config.tokenProvider;
  const fixedToken = config.token;
  if ((fixedToken === undefined) === (provider === undefined) ||
    (fixedToken !== undefined && (typeof fixedToken !== 'string' || !fixedToken)) ||
    (provider !== undefined && (!record(provider) || typeof provider.currentContextKey !== 'function' || typeof provider.getToken !== 'function'))) {
    throw new TypeError('supply token or tokenProvider');
  }
  const timeoutMs = positiveDuration(config.timeoutMs ?? 15_000, 'timeoutMs');
  const transactionMaxDurationMs = positiveDuration(config.transactionMaxDurationMs ?? 4_000, 'transactionMaxDurationMs');
  const clockToleranceMs = config.clockToleranceMs ?? 5_000;
  if (!Number.isFinite(clockToleranceMs) || clockToleranceMs < 0 || clockToleranceMs > 2_147_483_647) throw new TypeError('invalid clockToleranceMs');
  let closed = false;
  let cache;
  const flights = new Map();
  const scopes = new Set();
  const context = () => {
    const key = provider ? provider.currentContextKey() : 'fixed';
    if (!identifier(key)) throw authError('POLICYSQL_AUTH_PREPARATION_FAILED');
    return key;
  };
  const checkContext = key => {
    if (closed) throw authError('POLICYSQL_TRANSPORT_CLOSED');
    if (context() !== key) throw authError('POLICYSQL_AUTH_CONTEXT_CHANGED');
  };

  const credential = async (key, minValidityMs, signal) => {
    checkContext(key);
    if (!provider) {
      if (tokenExpiry(fixedToken) - Date.now() < minValidityMs) throw authError('POLICYSQL_AUTH_REQUIRED');
      return fixedToken;
    }
    if (cache?.contextKey === key && cache.expiresAt - Date.now() >= minValidityMs) return cache.token;
    let flight = flights.get(key);
    if (!flight) {
      // An atomic request may share its refresh with a concurrent begin. Ask once
      // for enough lifetime for either, rather than making the second waiter fail.
      const requestedValidityMs = Math.max(minValidityMs, transactionMaxDurationMs + timeoutMs + clockToleranceMs);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      flight = { controller, waiters: 0 };
      let onRefreshAbort;
      const interrupted = new Promise((_, reject) => {
        onRefreshAbort = () => reject(authError('POLICYSQL_AUTH_PREPARATION_FAILED'));
        controller.signal.addEventListener('abort', onRefreshAbort, { once: true });
      });
      flight.promise = Promise.race([
        interrupted,
        Promise.resolve().then(() => provider.getToken({ contextKey: key, minValidityMs: requestedValidityMs, signal: controller.signal })).then(value => {
          if (controller.signal.aborted) throw authError('POLICYSQL_AUTH_PREPARATION_FAILED');
          checkContext(key);
          if (!record(value) || value.contextKey !== key) throw authError('POLICYSQL_AUTH_CONTEXT_CHANGED');
          if (!Number.isFinite(value.expiresAt)) throw authError('POLICYSQL_AUTH_PREPARATION_FAILED');
          const result = { token: value.token, expiresAt: Math.min(tokenExpiry(value.token), value.expiresAt), contextKey: key };
          if (result.expiresAt - Date.now() < minValidityMs) throw authError('POLICYSQL_AUTH_PREPARATION_FAILED');
          cache = result;
          return result;
        }),
      ]).finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onRefreshAbort);
        if (flights.get(key) === flight) flights.delete(key);
      });
      flights.set(key, flight);
    }
    flight.waiters++;
    let onAbort;
    try {
      if (signal.aborted) throw authError('POLICYSQL_REQUEST_CANCELLED');
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(authError('POLICYSQL_REQUEST_CANCELLED'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const value = await Promise.race([flight.promise, aborted]);
      checkContext(key);
      if (value.expiresAt - Date.now() < minValidityMs) throw authError('POLICYSQL_AUTH_PREPARATION_FAILED');
      return value.token;
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (--flight.waiters === 0 && flights.get(key) === flight) {
        flights.delete(key);
        flight.controller.abort();
      }
    }
  };

  return Object.freeze({
    [contextKey]: context,
    [timeout]: timeoutMs,
    descriptor: Object.freeze({ endpointId: endpoint.href }),
    createScope(options = {}) {
      if (!onlyKeys(options, ['role'])) throw new TypeError('invalid scope options');
      const role = validateRole(options.role);
      let key;
      let preparationError;
      try { key = context(); } catch { preparationError = 'POLICYSQL_AUTH_PREPARATION_FAILED'; }
      let state = closed ? 'disposed' : 'open';
      const operations = new Set();
      const scope = Object.freeze({
        createOperation(input, inputOptions) {
          const command = copyCommand(input);
          const options = copyOperationOptions(command, inputOptions);
          let operation;
          operation = createOperation(command, options, {
            timeoutMs,
            onDispose: () => operations.delete(operation),
            async attempt({ signal, remainingMs, markSent }) {
              if (closed || state === 'disposed' || (state === 'draining' && options.purpose === 'execute' && !operations.has(operation))) return failure('POLICYSQL_TRANSPORT_CLOSED');
              if (preparationError) return failure(preparationError);
              let dispatched = false;
              try {
                const minValidityMs = clockToleranceMs + remainingMs() + (command.target.kind === 'begin' ? transactionMaxDurationMs : 0);
                const token = await credential(key, minValidityMs, signal);
                checkContext(key);
                if (signal.aborted) return failure('POLICYSQL_REQUEST_CANCELLED');
                if (closed || state === 'disposed') return failure('POLICYSQL_TRANSPORT_CLOSED');
                const { kind, transactionId } = command.target;
                const path = routes[kind] ?? `/v1/transactions/${transactionId}/${kind === 'statement' ? 'statements' : kind}`;
                const headers = {
                  authorization: `Bearer ${token}`, 'content-type': 'application/json',
                  ...(role === undefined ? {} : { 'policysql-role': role }),
                  ...(command.idempotencyKey === undefined ? {} : { 'idempotency-key': command.idempotencyKey }),
                };
                new Headers(headers);
                if (!markSent()) return failure('POLICYSQL_TRANSPORT_TIMEOUT');
                dispatched = true;
                const response = await fetchImpl(new URL(path, endpoint), {
                  method: ['catalog', 'capabilities'].includes(kind) ? 'GET' : 'POST',
                  redirect: 'error', credentials: 'omit', headers, body: command.body, signal,
                });
                let body;
                try { body = await readBody(response); }
                catch { return failure('POLICYSQL_TRANSPORT_PROTOCOL_ERROR', 'possibly-sent'); }
                return sanitizeReply({ type: 'response', status: response.status, body });
              } catch (error) {
                const allowed = ['POLICYSQL_AUTH_REQUIRED', 'POLICYSQL_AUTH_PREPARATION_FAILED', 'POLICYSQL_AUTH_CONTEXT_CHANGED', 'POLICYSQL_REQUEST_CANCELLED', 'POLICYSQL_TRANSPORT_CLOSED'];
                return failure(allowed.includes(error?.code) ? error.code : dispatched ? 'POLICYSQL_TRANSPORT_ERROR' : 'POLICYSQL_AUTH_PREPARATION_FAILED');
              }
            },
          });
          if (state === 'disposed' || closed || (state === 'draining' && options.purpose === 'execute')) void operation.dispose();
          else operations.add(operation);
          return operation;
        },
        beginShutdown() {
          if (state !== 'open') return;
          state = 'draining';
          for (const operation of operations) operation.stopUnsent();
        },
        async dispose() {
          if (state === 'disposed') return;
          state = 'disposed';
          try { await Promise.all([...operations].map(releaseTransportResource)); }
          finally { operations.clear(); scopes.delete(scope); }
        },
      });
      if (state !== 'disposed') scopes.add(scope);
      return scope;
    },
    async dispose() {
      if (closed) return;
      closed = true;
      cache = undefined;
      for (const flight of flights.values()) flight.controller.abort();
      flights.clear();
      await Promise.all([...scopes].map(releaseTransportResource));
    },
  });
}
