import { copyCommand, copyOperationOptions, failure, identifier, onlyKeys, positiveDuration, record, validReply, validateRole, sanitizeReply } from './index.js';
import { createOperation } from './operation.js';
import { releaseTransportResource } from './cleanup.js';
import { contextKey, timeout, limitDeadline } from './internal.js';

const VERSION = 1;
const INITIALIZATION_TIMEOUT = 15_000;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const attach = (port, receive) => {
  if (!port || typeof port.postMessage !== 'function' || typeof port.addEventListener !== 'function' || typeof port.close !== 'function') throw new TypeError('MessagePort is required');
  port.addEventListener('message', receive);
  port.start();
  return () => port.removeEventListener('message', receive);
};
const post = (port, message) => { port.postMessage({ version: VERSION, ...message }); };

export async function createAuthAgentTransport(port) {
  let ready;
  let closed = false;
  let serial = 0;
  const hello = deferred();
  const pending = new Map();
  const scopes = new Set();
  const receive = event => {
    const message = event.data;
    if (!record(message) || message.version !== VERSION) return;
    if (message.type === 'ready' && !ready) {
      if (!identifier(message.contextKey) || !record(message.descriptor) || typeof message.descriptor.endpointId !== 'string' ||
        !message.descriptor.endpointId || message.descriptor.endpointId.length > 2048 ||
        !Number.isFinite(message.timeoutMs) || message.timeoutMs <= 0 || message.timeoutMs > 2_147_483_647) return;
      ready = { descriptor: Object.freeze({ endpointId: message.descriptor.endpointId }), contextKey: message.contextKey, timeoutMs: message.timeoutMs };
      hello.resolve(ready);
    } else if (message.type === 'reply' && identifier(message.attemptId)) {
      pending.get(message.attemptId)?.resolve(validReply(message.reply) ? message.reply : failure('POLICYSQL_TRANSPORT_PROTOCOL_ERROR', 'possibly-sent'));
    } else if (message.type === 'close') {
      closed = true;
      hello.resolve(undefined);
      for (const entry of pending.values()) entry.resolve(failure('POLICYSQL_TRANSPORT_DISCONNECTED', 'possibly-sent'));
    }
  };
  const detach = attach(port, receive);
  let timer;
  try {
    timer = setTimeout(() => hello.resolve(undefined), INITIALIZATION_TIMEOUT);
    post(port, { type: 'hello' });
    const initialized = await hello.promise;
    if (!initialized || closed) throw new Error('PolicySQL transport initialization failed.');
  } catch {
    detach();
    port.close();
    throw new Error('PolicySQL transport initialization failed.');
  } finally { clearTimeout(timer); }
  const sendControl = message => { try { post(port, message); } catch { /* Best-effort resource release. */ } };

  return Object.freeze({
    descriptor: ready.descriptor,
    createScope(config = {}) {
      if (!onlyKeys(config, ['role'])) throw new TypeError('invalid scope options');
      const role = validateRole(config.role);
      const scopeId = 'scope_' + (++serial);
      const operations = new Set();
      let state = closed ? 'disposed' : 'open';
      const scope = Object.freeze({
        createOperation(input, inputOptions) {
          const command = copyCommand(input);
          const options = copyOperationOptions(command, inputOptions);
          const operationId = 'operation_' + (++serial);
          let operation;
          operation = createOperation(command, options, {
            timeoutMs: ready.timeoutMs,
            acceptNotSentConfirmation: true,
            onDispose() { operations.delete(operation); sendControl({ type: 'release-operation', scopeId, operationId }); },
            async attempt({ signal, markSent, deadline }) {
              if (closed || state === 'disposed') return failure('POLICYSQL_TRANSPORT_CLOSED');
              const attemptId = 'attempt_' + (++serial);
              const entry = deferred();
              const onAbort = () => {
                sendControl({ type: 'cancel', attemptId });
                entry.resolve(failure('POLICYSQL_REQUEST_CANCELLED', 'possibly-sent'));
              };
              pending.set(attemptId, entry);
              try {
                signal.addEventListener('abort', onAbort, { once: true });
                if (signal.aborted) return failure('POLICYSQL_REQUEST_CANCELLED');
                if (!markSent()) return failure('POLICYSQL_TRANSPORT_TIMEOUT');
                post(port, { type: 'send', scopeId, operationId, attemptId, contextKey: ready.contextKey, role, command, options, deadline });
                return await entry.promise;
              } finally {
                signal.removeEventListener('abort', onAbort);
                pending.delete(attemptId);
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
          sendControl({ type: 'drain', scopeId });
        },
        async dispose() {
          if (state === 'disposed') return;
          state = 'disposed';
          try { await Promise.all([...operations].map(releaseTransportResource)); }
          finally { operations.clear(); scopes.delete(scope); sendControl({ type: 'release-scope', scopeId }); }
        },
      });
      if (state !== 'disposed') scopes.add(scope);
      return scope;
    },
    async dispose() {
      closed = true;
      try { await Promise.all([...scopes].map(releaseTransportResource)); }
      finally { sendControl({ type: 'close' }); detach(); port.close(); pending.clear(); }
    },
  });
}

export function serveAuthAgentTransport(port, transport) {
  if (!transport || typeof transport.createScope !== 'function') throw new TypeError('transport is required');
  const readContext = () => transport[contextKey]?.() ?? 'fixed';
  const pinnedContext = readContext();
  if (!identifier(pinnedContext)) throw new TypeError('invalid transport context');
  const timeoutMs = positiveDuration(transport[timeout] ?? INITIALIZATION_TIMEOUT, 'timeoutMs');
  const scopes = new Map();
  const attempts = new Map();
  let closed = false;
  const reply = (attemptId, value) => { try { post(port, { type: 'reply', attemptId, reply: value }); } catch { /* Peer disappeared. */ } };
  const closeScope = async scopeId => {
    const entry = scopes.get(scopeId);
    if (!entry) return;
    scopes.delete(scopeId);
    await Promise.all([...entry.operations.values()].map(value => releaseTransportResource(value.operation)));
    await releaseTransportResource(entry.scope);
  };
  let detach;
  const dispose = async () => {
    if (closed) return;
    closed = true;
    try {
      for (const entry of attempts.values()) entry.controller.abort();
      await Promise.all([...scopes.keys()].map(closeScope));
    } finally {
      attempts.clear();
      try { post(port, { type: 'close' }); } catch { /* Peer disappeared. */ }
      detach();
      port.close();
    }
  };
  const receive = async event => {
    const message = event.data;
    if (closed || !record(message) || message.version !== VERSION) return;
    try {
      if (message.type === 'hello') {
        post(port, { type: 'ready', descriptor: transport.descriptor, contextKey: pinnedContext, timeoutMs });
        return;
      }
      if (message.type === 'close') { await dispose(); return; }
      if (message.type === 'cancel') { attempts.get(message.attemptId)?.controller.abort(); return; }
      if (!identifier(message.scopeId)) return;
      if (message.type === 'drain') { scopes.get(message.scopeId)?.scope.beginShutdown(); return; }
      if (message.type === 'release-scope') {
        await closeScope(message.scopeId);
        return;
      }
      if (message.type === 'release-operation') {
        const entries = scopes.get(message.scopeId)?.operations;
        const entry = entries?.get(message.operationId);
        entries?.delete(message.operationId);
        await releaseTransportResource(entry?.operation);
        return;
      }
      if (message.type !== 'send' || !onlyKeys(message, ['version', 'type', 'scopeId', 'operationId', 'attemptId', 'contextKey', 'role', 'command', 'options', 'deadline']) ||
        !identifier(message.operationId) || !identifier(message.attemptId)) return;
      if (message.contextKey !== pinnedContext || readContext() !== pinnedContext) { reply(message.attemptId, failure('POLICYSQL_AUTH_CONTEXT_CHANGED')); return; }
      const command = copyCommand(message.command);
      const options = copyOperationOptions(command, message.options);
      const role = validateRole(message.role);
      if (!Number.isFinite(message.deadline) || message.deadline <= Date.now()) { reply(message.attemptId, failure('POLICYSQL_TRANSPORT_TIMEOUT')); return; }
      let scope = scopes.get(message.scopeId);
      if (!scope) {
        if (scopes.size >= 256) throw 0;
        scope = { scope: transport.createScope({ role }), role, operations: new Map() };
        scopes.set(message.scopeId, scope);
      }
      if (scope.role !== role || attempts.has(message.attemptId)) throw 0;
      const fingerprint = JSON.stringify({ command, options });
      let entry = scope.operations.get(message.operationId);
      if (!entry) {
        if (scope.operations.size >= 256) throw 0;
        const operation = scope.scope.createOperation(command, options);
        const deadline = Math.min(message.deadline, Date.now() + timeoutMs);
        operation[limitDeadline]?.(deadline);
        entry = { operation, fingerprint, deadline };
        scope.operations.set(message.operationId, entry);
      }
      if (entry.fingerprint !== fingerprint) throw 0;
      const controller = new AbortController();
      const request = { controller };
      attempts.set(message.attemptId, request);
      // The same absolute deadline also cancels custom transports. It never renews
      // the underlying operation's automatic retry budget.
      const timer = setTimeout(() => controller.abort(), Math.max(0, entry.deadline - Date.now()));
      let value;
      try {
        value = await entry.operation.send({ signal: controller.signal });
        if (!validReply(value)) value = failure('POLICYSQL_TRANSPORT_PROTOCOL_ERROR', 'possibly-sent');
      } catch { value = failure('POLICYSQL_TRANSPORT_ERROR', 'possibly-sent'); }
      finally { clearTimeout(timer); attempts.delete(message.attemptId); }
      reply(message.attemptId, sanitizeReply(value));
    } catch {
      if (identifier(message?.attemptId)) reply(message.attemptId, failure('POLICYSQL_TRANSPORT_PROTOCOL_ERROR'));
    }
  };
  detach = attach(port, receive);
  return Object.freeze({ dispose });
}
