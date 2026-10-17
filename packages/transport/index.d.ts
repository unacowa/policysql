export type CommandTarget =
  | { readonly kind: 'execute' | 'begin' | 'explain' | 'catalog' | 'capabilities' }
  | { readonly kind: 'statement' | 'commit' | 'rollback'; readonly transactionId: string }

export interface TransportCommand {
  readonly commandId: string
  readonly target: CommandTarget
  readonly body?: string
  readonly idempotencyKey?: string
}
export interface OperationOptions {
  readonly serverExpiresAt?: string
  readonly purpose: 'execute' | 'confirm-terminal' | 'cleanup-rollback'
}
export type TransportFailureCode =
  | 'POLICYSQL_AUTH_REQUIRED'
  | 'POLICYSQL_AUTH_PREPARATION_FAILED'
  | 'POLICYSQL_AUTH_CONTEXT_CHANGED'
  | 'POLICYSQL_TRANSPORT_TIMEOUT'
  | 'POLICYSQL_REQUEST_CANCELLED'
  | 'POLICYSQL_TRANSPORT_DISCONNECTED'
  | 'POLICYSQL_TRANSPORT_CLOSED'
  | 'POLICYSQL_TRANSPORT_PROTOCOL_ERROR'
  | 'POLICYSQL_TRANSPORT_ERROR'
export type TransportReply =
  | { type: 'response'; status: number; body: unknown }
  | { type: 'failure'; code: TransportFailureCode; delivery: 'not-sent' | 'possibly-sent' }
export interface TransportOperation {
  send(options?: { signal?: AbortSignal }): Promise<TransportReply>
  dispose(): Promise<void>
}
export interface TransportScope {
  createOperation(command: TransportCommand, options: OperationOptions): TransportOperation
  beginShutdown(): void
  dispose(): Promise<void>
}
export interface PolicySqlTransport {
  readonly descriptor: Readonly<{ endpointId: string }>
  createScope(options: { role?: string }): TransportScope
  dispose(): Promise<void>
}
