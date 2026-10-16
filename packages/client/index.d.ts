export type SnapshotOptions =
  | { schemaVersion?: undefined; policyVersion?: undefined }
  | { schemaVersion: string; policyVersion: string }
export type PolicySqlClientOptions = {
  endpoint: string
  token: string
  /** Omit to use the verified JWT's default_role. */
  role?: string
  fetchImpl?: typeof fetch
} & SnapshotOptions
export interface PolicyExpectation { affectedRows?: number; rowCount?: number }
export interface PolicyExecuteOptions {
  /** Optional replay key (16-128 ASCII letters, digits, . _ : -). Reuse with identical payloads. */
  idempotencyKey?: string
  expect?: PolicyExpectation
  signal?: AbortSignal
}
export interface PolicyExecuteResult<Row = Record<string, unknown>> {
  columns?: string[]
  rows: Row[]
  rowCount?: number
  affectedRows?: number
  meta: Record<string, unknown>
  envelopeMeta: Record<string, unknown>
  debug?: { executionTrace?: unknown }
}
export class PolicySqlError extends Error {
  constructor(message: string, code: string, status?: number)
  readonly code: string
  readonly status?: number
}
export class PolicySqlOutcomeUnknownError extends PolicySqlError {
  constructor(context: {
    transactionId?: string
    phase: 'execute' | 'begin' | 'statement' | 'commit' | 'rollback'
    sequence?: number
  })
  readonly transactionId?: string
  readonly phase: 'execute' | 'begin' | 'statement' | 'commit' | 'rollback'
  readonly sequence?: number
}
export interface PolicySqlTransaction {
  readonly id: string
  readonly mode: 'read' | 'write'
  readonly expiresAt: string
  readonly status: 'active' | 'unknown' | 'expired' | 'failed' | 'committed' | 'rolled_back'
  readonly nextSequence: number
  /** Resolves on termination, disposal, or expiry (including an unknown outcome). */
  readonly closed: Promise<void>
  execute<Row = Record<string, unknown>>(
    sql: string, params?: Record<string, unknown>, options?: Pick<PolicyExecuteOptions, 'expect' | 'signal'>,
  ): Promise<PolicyExecuteResult<Row>>
  commit(): Promise<void>
  rollback(): Promise<void>
  retryPending(): Promise<PolicyExecuteResult | undefined>
  dispose(): Promise<void>
}
export class PolicySqlClient {
  constructor(options: PolicySqlClientOptions)
  readonly endpoint: string
  readonly role: string | undefined
  readonly schemaVersion: string | undefined
  readonly policyVersion: string | undefined
  execute<Row = Record<string, unknown>>(
    sql: string, params?: Record<string, unknown>, options?: PolicyExecuteOptions,
  ): Promise<PolicyExecuteResult<Row>>
  beginTransaction(options?: { mode?: 'read' | 'write' }): Promise<PolicySqlTransaction>
}
export interface GeneratedPolicyQuery<Params, Row> {
  readonly sql: string
  readonly queryHash: string
  readonly schemaVersion: string
  readonly policyVersion: string
  execute(client: PolicySqlClient, params: Params): Promise<Row[]>
}
