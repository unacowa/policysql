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
const token = (expiresAt, subject = 'user-a') => 'eyJhbGciOiJSUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000), sub: subject })).toString('base64url') + '.signature';
const build = async (t, kind, options) => {
  const http = createHttpTransport({ endpoint: 'https://gateway.test', token: testToken, ...options });
  if (kind === 'http') { t.after(() => http.dispose()); return http; }
  const { port1, port2 } = new MessageChannel();
  const backend = kind === 'message-wrapped' ? {
    descriptor: http.descriptor,
    createScope: options => http.createScope(options),
    dispose: () => http.dispose(),
  } : http;
  const server = serveAuthAgentTransport(port2, backend);
  const transport = await createAuthAgentTransport(port1, { timeoutMs: options?.timeoutMs });
  t.after(async () => { await transport.dispose(); await server.dispose(); await http.dispose(); });
  return transport;
};

for (const kind of ['http', 'message', 'message-wrapped']) {
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
      getToken: async () => { acquisitions++; throw new Error('private provider credentials'); },
    }, fetchImpl: async () => { sends++; throw new Error('unexpected'); } });
    await assert.rejects(new PolicySqlClient({ transport }).beginTransaction(), error => error.code === 'POLICYSQL_AUTH_PREPARATION_FAILED' && error.delivery === 'not-sent' && !error.message.includes('credentials'));
    assert.equal(acquisitions, 1);
    assert.equal(sends, 0);
  });

  test(kind + ': a provider account switch applies to new requests without rebuilding the client or port', async t => {
    const gateway = mockGateway();
    const expiresAt = Date.now() + 60_000;
    let current = token(expiresAt, 'user-a');
    const first = current;
    let acquisitions = 0;
    const transport = await build(t, kind, { token: undefined, tokenProvider: {
      getToken: async () => { acquisitions++; return { token: current, expiresAt }; },
    }, fetchImpl: gateway.fetchImpl });
    const client = new PolicySqlClient({ transport });
    await client.execute('SELECT id FROM posts');
    current = token(expiresAt, 'user-b');
    await client.execute('SELECT id FROM posts');
    assert.equal(acquisitions, 2);
    assert.deepEqual(gateway.calls.map(call => call.headers.get('authorization')), ['Bearer ' + first, 'Bearer ' + current]);
  });

  test(kind + ': retry timeout starts again for the same command, including across a worker', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const first = Promise.withResolvers();
    const second = Promise.withResolvers();
    const failFirst = Promise.withResolvers();
    const gateway = mockGateway();
    let attempts = 0;
    let secondSignal;
    const transport = await build(t, kind, { timeoutMs: 1_000, fetchImpl: async (url, init) => {
      const response = await gateway.fetchImpl(url, init);
      if (!new URL(url).pathname.endsWith('/commit')) return response;
      if (++attempts === 1) { first.resolve(); await failFirst.promise; throw new Error('lost reply'); }
      secondSignal = init.signal;
      second.resolve();
      return new Promise(() => {});
    } });
    const tx = await new PolicySqlClient({ transport }).beginTransaction();
    const rejected = assert.rejects(tx.commit(), { code: 'POLICYSQL_OUTCOME_UNKNOWN', phase: 'commit' });
    await first.promise;
    t.mock.timers.tick(600);
    failFirst.resolve();
    await second.promise;
    t.mock.timers.tick(401);
    await flush();
    assert.equal(secondSignal.aborted, false);
    t.mock.timers.tick(600);
    await rejected;
    assert.equal(secondSignal.aborted, true);
    assert.equal(attempts, 2);
    const sent = gateway.calls.filter(call => call.path.endsWith('/commit'));
    assert.equal(sent[0].text, sent[1].text);
    await tx.dispose();
  });

  test(kind + ': authentication failure after a lost commit preserves the original unknown and never sends rollback', async t => {
    const gateway = mockGateway();
    let denied = false;
    const transport = await build(t, kind, { token: undefined, tokenProvider: {
      getToken: async () => {
        if (denied) throw new Error('private provider failure');
        return { token: testToken, expiresAt: 4_000_000_000_000 };
      },
    }, fetchImpl: async (url, init) => {
      const response = await gateway.fetchImpl(url, init);
      if (new URL(url).pathname.endsWith('/commit')) { denied = true; throw new Error('lost response'); }
      return response;
    } });
    const tx = await new PolicySqlClient({ transport }).beginTransaction();
    let original;
    await assert.rejects(tx.commit(), error => { original = error; return error.code === 'POLICYSQL_OUTCOME_UNKNOWN'; });
    assert.equal(original.recoveryFailure.code, 'POLICYSQL_AUTH_PREPARATION_FAILED');
    await assert.rejects(tx.commit(), error => error === original);
    await assert.rejects(tx.rollback(), error => error === original);
    assert.equal(gateway.calls.length, 2);
    assert.equal(gateway.transactions.get(tx.id).status, 'committed');
    await tx.dispose();
  });

  test(kind + ': cancellation during authentication leaves the other request alive', async t => {
    const gateway = mockGateway();
    const entered = Promise.withResolvers();
    const credential = Promise.withResolvers();
    const signals = [];
    const transport = await build(t, kind, { token: undefined, tokenProvider: {
      getToken: async ({ signal }) => {
        signals.push(signal);
        if (signals.length === 2) entered.resolve();
        await credential.promise;
        return { token: testToken, expiresAt: 4_000_000_000_000 };
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
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
    credential.resolve();
    await successful;
    await flush();
    assert.equal(signals.length, 2);
    assert.equal(gateway.calls.length, 1);
  });

  test(kind + ': a terminal result can be recovered after expiry using a refreshed token', async t => {
    const gateway = mockGateway();
    let reads = 0;
    let drop = true;
    let now = Date.now();
    const transport = await build(t, kind, { token: undefined, tokenProvider: {
      getToken: async () => { reads++; return { token: token(now + 60_000), expiresAt: now + 60_000 }; },
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
    assert.equal(reads, 4);
    assert.equal(tx.status, 'committed');
  });
}

test('HTTP auth preparation may exceed four seconds within its send timeout', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const credentials = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const gateway = mockGateway();
  const transport = await build(t, 'http', { token: undefined, tokenProvider: {
    getToken: async ({ minValidityMs }) => { entered.resolve(minValidityMs); await credentials.promise; return { token: testToken, expiresAt: 4_000_000_000_000 }; },
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

test('silent port loss is bounded by the explicit bridge timeout through a public wrapper', async t => {
  const http = createHttpTransport({ endpoint: 'https://gateway.test', token: testToken, timeoutMs: 30 });
  const { port1, port2 } = new MessageChannel();
  const server = serveAuthAgentTransport(port2, {
    descriptor: http.descriptor, createScope: options => http.createScope(options), dispose: () => http.dispose(),
  });
  const transport = await createAuthAgentTransport(port1, { timeoutMs: 30 });
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

test('concurrent atomic and begin sends request their own credentials and lifetime requirements', async t => {
  const gateway = mockGateway();
  const wait = Promise.withResolvers();
  let refreshes = 0;
  const transport = await build(t, 'http', { token: undefined, tokenProvider: {
    async getToken({ minValidityMs }) {
      refreshes++;
      await wait.promise;
      const expiresAt = Date.now() + minValidityMs + 2_000;
      return { token: token(expiresAt), expiresAt };
    },
  }, fetchImpl: gateway.fetchImpl });
  const client = new PolicySqlClient({ transport });
  const read = client.execute('SELECT id FROM posts');
  const start = client.beginTransaction();
  await flush();
  wait.resolve();
  await read;
  const tx = await start;
  assert.equal(refreshes, 2);
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
