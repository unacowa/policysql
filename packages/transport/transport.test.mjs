import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageChannel, Worker } from 'node:worker_threads';
import { Kysely } from 'kysely';
import { PolicySqlDialect } from '../kysely/index.js';
import { PolicySqlClient } from '../client/index.js';
import { mockGateway, testToken } from '../client/test-fixture.mjs';
import { createHttpTransport } from './http.js';
import { createAuthAgentTransport, serveAuthAgentTransport } from './auth-agent.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const token = expiresAt => 'eyJhbGciOiJSUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString('base64url') + '.signature';
const build = async (t, kind, options) => {
  const http = createHttpTransport({ endpoint: 'https://gateway.test', token: testToken, ...options });
  if (kind === 'http') { t.after(() => http.dispose()); return http; }
  const { port1, port2 } = new MessageChannel();
  const server = serveAuthAgentTransport(port2, http);
  const transport = await createAuthAgentTransport(port1);
  t.after(async () => { await transport.dispose(); await server.dispose(); await http.dispose(); });
  return transport;
};

for (const kind of ['http', 'message']) {
  test(kind + ': atomic and interactive commands use the same serializable contract', async t => {
    const gateway = mockGateway();
    const transport = await build(t, kind, { fetchImpl: gateway.fetchImpl });
    const client = new PolicySqlClient({ transport, role: 'author' });
    await client.execute('SELECT id FROM posts');
    const tx = await client.beginTransaction();
    await tx.execute('SELECT id FROM posts');
    await tx.commit();
    assert.deepEqual(gateway.calls.map(call => call.path.split('/').at(-1)), ['transactions:execute', 'transactions', 'statements', 'commit']);
    assert.ok(gateway.calls.every(call => call.headers.get('authorization') === 'Bearer ' + testToken));
    assert.ok(gateway.calls.every(call => call.headers.get('policysql-role') === 'author'));
  });

  test(kind + ': a failed token provider is an unsent authentication failure, never a begin retry', async t => {
    let acquisitions = 0;
    let sends = 0;
    const transport = await build(t, kind, { token: undefined, tokenProvider: {
      currentContextKey: () => 'session1',
      getToken: async () => { acquisitions++; throw new Error('private provider credentials'); },
    }, fetchImpl: async () => { sends++; throw new Error('unexpected'); } });
    await assert.rejects(new PolicySqlClient({ transport }).beginTransaction(), error => error.code === 'POLICYSQL_AUTH_PREPARATION_FAILED' && error.delivery === 'not-sent' && !error.message.includes('credentials'));
    assert.equal(acquisitions, 1);
    assert.equal(sends, 0);
  });

  test(kind + ': context changes after a lost commit preserve the original unknown and never send rollback', async t => {
    const gateway = mockGateway();
    let context = 'session1';
    const transport = await build(t, kind, { token: undefined, tokenProvider: {
      currentContextKey: () => context,
      getToken: async ({ contextKey }) => ({ token: testToken, expiresAt: 4_000_000_000_000, contextKey }),
    }, fetchImpl: async (url, init) => {
      const response = await gateway.fetchImpl(url, init);
      if (new URL(url).pathname.endsWith('/commit')) { context = 'session2'; throw new Error('lost response'); }
      return response;
    } });
    const tx = await new PolicySqlClient({ transport }).beginTransaction();
    let original;
    await assert.rejects(tx.commit(), error => { original = error; return error.code === 'POLICYSQL_OUTCOME_UNKNOWN'; });
    assert.equal(original.recoveryFailure.code, 'POLICYSQL_AUTH_CONTEXT_CHANGED');
    await assert.rejects(tx.commit(), error => error === original);
    await assert.rejects(tx.rollback(), error => error === original);
    assert.equal(gateway.calls.length, 2);
    assert.equal(gateway.transactions.get(tx.id).status, 'committed');
    await tx.dispose();
  });

  test(kind + ': cancellation during shared authentication leaves the other waiter alive', async t => {
    const gateway = mockGateway();
    const entered = Promise.withResolvers();
    const credential = Promise.withResolvers();
    let refreshSignal;
    let refreshes = 0;
    const transport = await build(t, kind, { token: undefined, tokenProvider: {
      currentContextKey: () => 'session1',
      getToken: async ({ signal, contextKey }) => {
        refreshes++; refreshSignal = signal; entered.resolve();
        await credential.promise;
        return { token: testToken, contextKey, expiresAt: 4_000_000_000_000 };
      },
    }, fetchImpl: gateway.fetchImpl });
    const client = new PolicySqlClient({ transport });
    const controller = new AbortController();
    const cancelled = assert.rejects(client.execute('SELECT id FROM posts', {}, { signal: controller.signal }), error => ['POLICYSQL_REQUEST_CANCELLED', 'POLICYSQL_OUTCOME_UNKNOWN'].includes(error.code));
    const successful = client.execute('SELECT id FROM posts');
    await entered.promise;
    await flush();
    controller.abort();
    await cancelled;
    await flush();
    assert.equal(refreshSignal.aborted, false);
    credential.resolve();
    await successful;
    await flush();
    assert.equal(refreshes, 1);
    assert.equal(gateway.calls.length, 1);
  });

  test(kind + ': a terminal result can be recovered after expiry using a refreshed token in the same context', async t => {
    const gateway = mockGateway();
    let reads = 0;
    let drop = true;
    let now = Date.now();
    const transport = await build(t, kind, { token: undefined, tokenProvider: {
      currentContextKey: () => 'session1',
      getToken: async ({ contextKey }) => { reads++; return { token: token(now + 60_000), expiresAt: now + 60_000, contextKey }; },
    }, fetchImpl: async (url, init) => {
      const response = await gateway.fetchImpl(url, init);
      if (new URL(url).pathname.endsWith('/commit') && drop) throw new Error('lost response');
      return response;
    } });
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
    const tx = await new PolicySqlClient({ transport }).beginTransaction();
    await assert.rejects(tx.commit(), { code: 'POLICYSQL_OUTCOME_UNKNOWN' });
    now += 70_000;
    t.mock.timers.tick(70_000);
    drop = false;
    await tx.commit();
    assert.equal(reads, 2);
    assert.equal(tx.status, 'committed');
  });
}

test('HTTP auth preparation may exceed four seconds within its operation budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const credentials = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const gateway = mockGateway();
  const transport = await build(t, 'http', { token: undefined, tokenProvider: {
    currentContextKey: () => 'session1',
    getToken: async ({ contextKey, minValidityMs }) => { entered.resolve(minValidityMs); await credentials.promise; return { token: testToken, expiresAt: 4_000_000_000_000, contextKey }; },
  }, fetchImpl: gateway.fetchImpl });
  const started = new PolicySqlClient({ transport }).beginTransaction();
  assert.ok(await entered.promise >= 24_000);
  t.mock.timers.tick(6_000);
  assert.equal(gateway.calls.length, 0);
  credentials.resolve();
  const tx = await started;
  await tx.rollback();
});

test('HTTP failures before and after fetch have distinct delivery classifications', async t => {
  for (const mode of ['expired', 'network', 'malformed', 'forbidden']) {
    let calls = 0;
    const http = await build(t, 'http', { token: mode === 'expired' ? token(Date.now() - 10_000) : testToken,
      fetchImpl: async () => { calls++; if (mode === 'network') throw new Error('network secret'); return mode === 'malformed' ? new Response('bad json') : Response.json({ error: { code: 'POLICYSQL_FORBIDDEN', message: 'private' } }, { status: 403 }); },
    });
    const scope = http.createScope({});
    const operation = scope.createOperation({ commandId: 'cmd1', target: { kind: 'execute' }, body: '{}' }, { purpose: 'execute' });
    const reply = await operation.send();
    if (mode === 'expired') { assert.equal(reply.delivery, 'not-sent'); assert.equal(calls, 0); }
    else if (mode === 'forbidden') { assert.equal(reply.type, 'response'); assert.equal(reply.status, 403); }
    else assert.equal(reply.delivery, 'possibly-sent');
    await operation.dispose();
    await scope.dispose();
  }
});

test('standard Kysely queries and callback run in the parent while a worker owns JWT and HTTP', async t => {
  const worker = new Worker(new URL('./test-worker.mjs', import.meta.url));
  const { port1, port2 } = new MessageChannel();
  const received = [];
  port1.addEventListener('message', event => received.push(event.data));
  worker.postMessage(port2, [port2]);
  t.after(() => worker.terminate());
  const transport = await createAuthAgentTransport(port1);
  const db = new Kysely({ dialect: new PolicySqlDialect({ client: new PolicySqlClient({ transport }) }) });
  try {
    let callbacks = 0;
    await db.transaction().execute(async trx => {
      callbacks++;
      const row = await trx.selectFrom('posts').select('id').executeTakeFirstOrThrow();
      await trx.updateTable('posts').set({ title: 'From UI' }).where('id', '=', row.id).execute();
    });
    assert.equal(callbacks, 1);
    assert.doesNotMatch(JSON.stringify(received), /Bearer|authorization|eyJhbGci/);
  } finally {
    await db.destroy();
    await transport.dispose();
  }
});

test('silent port loss is bounded by the operation deadline', async t => {
  const http = createHttpTransport({ endpoint: 'https://gateway.test', token: testToken, timeoutMs: 30 });
  const { port1, port2 } = new MessageChannel();
  const server = serveAuthAgentTransport(port2, http);
  const transport = await createAuthAgentTransport(port1);
  port2.close();
  try {
    await assert.rejects(new PolicySqlClient({ transport }).execute('SELECT id FROM posts'), { code: 'POLICYSQL_OUTCOME_UNKNOWN', phase: 'execute' });
  } finally {
    await transport.dispose();
    await server.dispose();
    await http.dispose();
  }
});

test('destroying one Kysely instance leaves a shared transport and another instance usable', async t => {
  const gateway = mockGateway();
  const transport = await build(t, 'message', { fetchImpl: gateway.fetchImpl });
  const client = new PolicySqlClient({ transport });
  const first = new Kysely({ dialect: new PolicySqlDialect({ client }) });
  const second = new Kysely({ dialect: new PolicySqlDialect({ client }) });
  const trx = await second.startTransaction().execute();
  await first.destroy();
  assert.equal((await trx.selectFrom('posts').select('id').execute()).length, 1);
  await trx.commit().execute();
  await second.destroy();
});

test('worker wire strips server messages, causes and stacks while retaining safe diagnostics', async () => {
  const { port1, port2 } = new MessageChannel();
  const received = [];
  port1.addEventListener('message', event => received.push(event.data));
  const http = createHttpTransport({ endpoint: 'https://gateway.test', token: testToken, fetchImpl: async () => Response.json({
    error: { code: 'POLICYSQL_FORBIDDEN', requestId: 'request-123', path: 'statements[0].sql', message: 'private credential', cause: 'private credential', stack: 'private credential' },
    other: 'private credential',
  }, { status: 403 }) });
  const server = serveAuthAgentTransport(port2, http);
  const transport = await createAuthAgentTransport(port1);
  try {
    await assert.rejects(new PolicySqlClient({ transport }).execute('SELECT id FROM posts'), {
      code: 'POLICYSQL_FORBIDDEN', status: 403, requestId: 'request-123', path: 'statements[0].sql',
    });
    assert.doesNotMatch(JSON.stringify(received), /private credential|stack|cause/);
  } finally { await transport.dispose(); await server.dispose(); await http.dispose(); }
});

test('one shared refresh satisfies concurrent atomic and begin lifetime requirements', async t => {
  const gateway = mockGateway();
  const wait = Promise.withResolvers();
  let refreshes = 0;
  const transport = await build(t, 'http', { token: undefined, tokenProvider: {
    currentContextKey: () => 'session1',
    async getToken({ contextKey, minValidityMs }) {
      refreshes++;
      await wait.promise;
      const expiresAt = Date.now() + minValidityMs + 2_000;
      return { token: token(expiresAt), expiresAt, contextKey };
    },
  }, fetchImpl: gateway.fetchImpl });
  const client = new PolicySqlClient({ transport });
  const read = client.execute('SELECT id FROM posts');
  const start = client.beginTransaction();
  await flush();
  wait.resolve();
  await read;
  const tx = await start;
  assert.equal(refreshes, 1);
  await tx.rollback();
});

test('unknown exceptions and non-JSON transport replies are normalized without leaking causes', async () => {
  for (const send of [async () => { throw new Error('private credential'); }, async () => ({ type: 'response', status: 200, body: new Error('private credential') }),
    async () => ({ type: 'failure', code: 'unknown private credential', delivery: 'not-sent' })]) {
    const transport = {
      descriptor: { endpointId: 'test' }, async dispose() {},
      createScope() { return { beginShutdown() {}, async dispose() {}, createOperation() { return { send, async dispose() {} }; } }; },
    };
    await assert.rejects(new PolicySqlClient({ transport }).execute('SELECT id FROM posts'), error => error.code === 'POLICYSQL_OUTCOME_UNKNOWN' && error.cause === undefined && !error.message.includes('private'));
  }
});
