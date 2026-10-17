import assert from 'node:assert/strict';
import test from 'node:test';
import { PolicySqlClient } from './index.js';
import { createHttpTransport } from '../transport/http.js';
import { mockGateway, testToken } from './test-fixture.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const sql = 'UPDATE posts SET title = :title';
const instrument = (transport, { cleanupThrows = false } = {}) => {
  const operations = [];
  let scopesDisposed = 0;
  const dispose = async resource => {
    await resource.dispose();
    if (cleanupThrows) throw new Error('secret cleanup error');
  };
  return {
    operations,
    get scopesDisposed() { return scopesDisposed; },
    transport: {
      descriptor: transport.descriptor,
      dispose: () => transport.dispose(),
      createScope(options) {
        const scope = transport.createScope(options);
        return {
          beginShutdown: () => scope.beginShutdown(),
          async dispose() { scopesDisposed++; await dispose(scope); },
          createOperation(command, options) {
            const operation = scope.createOperation(command, options);
            const entry = { command, options, attempts: 0, disposed: 0 };
            operations.push(entry);
            return {
              send(options) { entry.attempts++; return operation.send(options); },
              async dispose() { entry.disposed++; await dispose(operation); },
            };
          },
        };
      },
    },
  };
};

test('a second automatic attempt uses only the remaining budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const failFirst = Promise.withResolvers();
  const gateway = mockGateway();
  let count = 0;
  let secondSignal;
  const wrapped = instrument(createHttpTransport({ endpoint: 'https://gateway.test', token: testToken, timeoutMs: 1_000,
    fetchImpl: async (url, init) => {
      const response = await gateway.fetchImpl(url, init);
      if (!new URL(url).pathname.endsWith('/statements')) return response;
      if (++count === 1) { first.resolve(); await failFirst.promise; throw new Error('lost response'); }
      secondSignal = init.signal;
      second.resolve();
      return new Promise(() => {});
    },
  }));
  const tx = await new PolicySqlClient({ transport: wrapped.transport }).beginTransaction();
  const failed = assert.rejects(tx.execute(sql, { title: 'First' }), { code: 'POLICYSQL_OUTCOME_UNKNOWN' });
  await first.promise;
  t.mock.timers.tick(600);
  failFirst.resolve();
  await second.promise;
  t.mock.timers.tick(401);
  await failed;
  assert.equal(secondSignal.aborted, true);
  assert.equal(count, 2);
  assert.equal(wrapped.operations.length, 2);
  await tx.dispose();
});

test('transport is required and legacy options never select an implicit HTTP path', () => {
  for (const config of [undefined, {}, { transport: null }, { endpoint: 'https://gateway.test', token: testToken },
    { transport: { descriptor: { endpointId: 'test' } } }]) assert.throws(() => new PolicySqlClient(config), TypeError);
  const transport = createHttpTransport({ endpoint: 'https://gateway.test', token: testToken });
  assert.throws(() => new PolicySqlClient({ transport, token: testToken }), TypeError);
});

test('explicit statement recovery gets a new finite operation with the identical command', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const gateway = mockGateway();
  let drop = true;
  const wrapped = instrument(createHttpTransport({ endpoint: 'https://gateway.test', token: testToken, timeoutMs: 1_000,
    fetchImpl: async (url, init) => {
      const response = await gateway.fetchImpl(url, init);
      if (new URL(url).pathname.endsWith('/statements') && drop) return new Promise(() => {});
      return response;
    },
  }));
  const tx = await new PolicySqlClient({ transport: wrapped.transport }).beginTransaction();
  const params = { title: 'First' };
  let original;
  const failed = assert.rejects(tx.execute(sql, params), error => { original = error; return error.code === 'POLICYSQL_OUTCOME_UNKNOWN'; });
  params.title = 'Changed';
  await flush();
  t.mock.timers.tick(1_001);
  await failed;
  assert.equal(wrapped.operations[1].attempts, 1);
  assert.equal(tx.nextSequence, 1);
  drop = false;
  await tx.retryPending();
  assert.equal(tx.nextSequence, 2);
  assert.deepEqual(wrapped.operations[1].command, wrapped.operations[2].command);
  assert.equal(wrapped.operations[1].disposed, 1);
  assert.equal(wrapped.operations[2].disposed, 1);
  const requests = gateway.calls.filter(call => call.path.endsWith('/statements'));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].text, requests[1].text);
  assert.equal(requests[1].body.params.title, 'First');
  assert.equal(gateway.transactions.get(tx.id).sequence, 2);
  await tx.commit();
  assert.equal(original.sequence, 1);
});

test('automatic retries share an operation and expiry prevents manual statement replay', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const gateway = mockGateway();
  const wrapped = instrument(createHttpTransport({ endpoint: 'https://gateway.test', token: testToken,
    fetchImpl: async (url, init) => {
      const response = await gateway.fetchImpl(url, init);
      if (new URL(url).pathname.endsWith('/statements')) throw new Error('lost response');
      return response;
    },
  }));
  const tx = await new PolicySqlClient({ transport: wrapped.transport }).beginTransaction();
  let original;
  await assert.rejects(tx.execute(sql, { title: 'First' }), error => { original = error; return error.phase === 'statement'; });
  assert.equal(wrapped.operations[1].attempts, 2);
  assert.equal(wrapped.operations.length, 2);
  t.mock.timers.tick(4_001);
  await assert.rejects(tx.retryPending(), error => error === original);
  assert.equal(wrapped.operations.length, 2);
  assert.equal(gateway.calls.length, 3);
  assert.equal(tx.status, 'unknown');
  await tx.dispose();
});

for (const terminal of ['commit', 'rollback']) test('explicit ' + terminal + ' confirmation survives the server live deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const gateway = mockGateway();
  let drop = true;
  const wrapped = instrument(createHttpTransport({ endpoint: 'https://gateway.test', token: testToken,
    fetchImpl: async (url, init) => {
      const response = await gateway.fetchImpl(url, init);
      if (new URL(url).pathname.endsWith('/' + terminal) && drop) throw new Error('lost response');
      return response;
    },
  }));
  const tx = await new PolicySqlClient({ transport: wrapped.transport }).beginTransaction();
  await assert.rejects(tx[terminal](), { code: 'POLICYSQL_OUTCOME_UNKNOWN' });
  t.mock.timers.tick(4_001);
  drop = false;
  await tx[terminal]();
  assert.equal(wrapped.operations.at(-1).options.purpose, 'confirm-terminal');
  assert.deepEqual(wrapped.operations[1].command, wrapped.operations[2].command);
  assert.equal(tx.status, terminal === 'commit' ? 'committed' : 'rolled_back');
  await tx.dispose();
});

for (const phase of ['execute', 'commit', 'rollback']) {
  for (const outcome of ['success', 'unknown', 'rejected']) test(phase + ' preserves ' + outcome + ' when resource disposal rejects', async () => {
    const gateway = mockGateway();
    const wrapped = instrument(createHttpTransport({ endpoint: 'https://gateway.test', token: testToken,
      fetchImpl: async (url, init) => {
        const targeted = new URL(url).pathname.endsWith(phase === 'execute' ? ':execute' : '/' + phase);
        if (targeted && outcome === 'rejected') return Response.json({ error: { code: 'POLICYSQL_FORBIDDEN' } }, { status: 403 });
        const response = await gateway.fetchImpl(url, init);
        if (targeted && outcome === 'unknown') throw new Error('lost response');
        return response;
      },
    }), { cleanupThrows: true });
    const client = new PolicySqlClient({ transport: wrapped.transport });
    const tx = phase === 'execute' ? undefined : await client.beginTransaction();
    const result = tx ? tx[phase]() : client.execute(sql, { title: 'First' });
    if (outcome === 'success') {
      await result;
      if (tx) assert.equal(tx.status, phase === 'commit' ? 'committed' : 'rolled_back');
    } else if (outcome === 'unknown') {
      let original;
      await assert.rejects(result, error => { original = error; return error.code === 'POLICYSQL_OUTCOME_UNKNOWN' && error.phase === phase; });
      if (tx) await assert.rejects(tx.retryPending(), error => error === original);
    } else await assert.rejects(result, { code: 'POLICYSQL_FORBIDDEN', status: 403 });
    if (tx) await tx.dispose();
    assert.ok(wrapped.scopesDisposed >= 1);
    assert.ok(wrapped.operations.every(operation => operation.disposed === 1));
    if (outcome === 'success') assert.ok(wrapped.operations.every(operation => operation.attempts === 1));
  });
}
