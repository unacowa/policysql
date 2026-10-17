import { parentPort } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { createHttpTransport } from './http.js';
import { serveAuthAgentTransport } from './auth-agent.js';
import { mockGateway } from '../client/test-fixture.mjs';

// Test-only credential is created in this worker and never transferred to its parent.
const credential = 'eyJhbGciOiJSUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp: 4_000_000_000 })).toString('base64url') + '.' + randomUUID().replaceAll('-', '');
const gateway = mockGateway();
const transport = createHttpTransport({ endpoint: 'https://gateway.test', token: credential,
  fetchImpl: async (url, init) => {
    if (new Headers(init.headers).get('authorization') !== 'Bearer ' + credential) throw new Error('Missing worker credential');
    return gateway.fetchImpl(url, init);
  },
});
parentPort.once('message', port => {
  serveAuthAgentTransport(port, transport);
  parentPort.close();
});
