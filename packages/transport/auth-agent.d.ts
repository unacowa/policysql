import type { PolicySqlTransport } from './index.js'
/** Connect an already provisioned port. Worker construction and authentication belong to the application. */
export function createAuthAgentTransport(port: MessagePort, options?: { timeoutMs?: number }): Promise<PolicySqlTransport>
/** Serve a transport on one port without taking ownership of the shared underlying transport. */
export function serveAuthAgentTransport(port: MessagePort, transport: PolicySqlTransport): { dispose(): Promise<void> }
