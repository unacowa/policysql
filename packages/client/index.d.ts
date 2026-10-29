export type TransportRequest = { readonly role?: string } & (
  | { readonly kind: 'execute'; readonly body: string; readonly idempotencyKey?: string }
  | { readonly kind: 'begin' | 'explain'; readonly body: string }
  | { readonly kind: 'statement' | 'commit' | 'rollback'; readonly transactionId: string; readonly body: string }
  | { readonly kind: 'catalog' | 'capabilities' }
)
export interface TransportResponse { readonly status: number; readonly body: unknown }
export interface SignalOptions { readonly signal?: AbortSignal }
/** One attempt. Preserve the request, honor cancellation and keep the logical endpoint/DB fixed. */
export type PolicySqlTransport = (request: TransportRequest, options?: SignalOptions) => Promise<TransportResponse>
export interface HttpTransportOptions { readonly endpoint: string; readonly fetchImpl?: typeof fetch }
/**
 * Uses fetch once, with redirect:error and credentials:omit. No authentication, timers or retries.
 * Not meant to run inside a Cloudflare Worker: workerd rejects redirect:error with a TypeError.
 */
export function createHttpTransport(options: HttpTransportOptions): PolicySqlTransport
export type SnapshotOptions =
  | { readonly schemaVersion?: undefined; readonly policyVersion?: undefined }
  | { readonly schemaVersion: string; readonly policyVersion: string }
export type PolicySqlClientOptions = {
  readonly transport: PolicySqlTransport
  /** Omit to use the verified JWT's default_role. Fixed for this Client's lifetime. */
  readonly role?: string
} & SnapshotOptions
export interface PolicyExpectation { affectedRows?: number; rowCount?: number }
export interface PolicyExecuteOptions extends SignalOptions {
  /** Optional replay key. Explicit resends must preserve the request and authentication/DB context. */
  idempotencyKey?: string
  expect?: PolicyExpectation
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
export interface PolicySqlErrorOptions extends ErrorOptions { response?: TransportResponse }
export class PolicySqlError extends Error {
  constructor(message: string, code: string, status?: number, options?: PolicySqlErrorOptions)
  readonly code: string
  readonly status?: number
  /** Validated public response, including the original server error fields. */
  readonly response?: TransportResponse
}
export class PolicySqlOutcomeUnknownError extends PolicySqlError {
  constructor(context: {
    transactionId?: string
    phase: 'execute' | 'begin' | 'statement' | 'commit' | 'rollback'
    sequence?: number
  }, options?: ErrorOptions)
  readonly transactionId?: string
  readonly phase: 'execute' | 'begin' | 'statement' | 'commit' | 'rollback'
  readonly sequence?: number
  /** Most recent failed explicit confirmation; cause retains the original failure. */
  readonly lastError?: unknown
}
export interface PolicySqlTransaction {
  readonly id: string
  readonly mode: 'read' | 'write'
  /** Server deadline metadata. The Client does not enforce a local clock deadline. */
  readonly expiresAt: string
  readonly status: 'active' | 'unknown' | 'failed' | 'committed' | 'rolled_back'
  readonly nextSequence: number
  /** Resolves after confirmed completion or local disposal; disposal is not proof of rollback. */
  readonly closed: Promise<void>
  execute<Row = Record<string, unknown>>(
    sql: string, params?: Record<string, unknown>, options?: Pick<PolicyExecuteOptions, 'expect' | 'signal'>,
  ): Promise<PolicyExecuteResult<Row>>
  commit(options?: SignalOptions): Promise<void>
  rollback(options?: SignalOptions): Promise<void>
  retryPending(options?: SignalOptions): Promise<PolicyExecuteResult | undefined>
  dispose(): Promise<void>
}
export class PolicySqlClient {
  constructor(options: PolicySqlClientOptions)
  readonly role: string | undefined
  readonly schemaVersion: string | undefined
  readonly policyVersion: string | undefined
  execute<Row = Record<string, unknown>>(
    sql: string, params?: Record<string, unknown>, options?: PolicyExecuteOptions,
  ): Promise<PolicyExecuteResult<Row>>
  beginTransaction(options?: { readonly mode?: 'read' | 'write'; readonly signal?: AbortSignal }): Promise<PolicySqlTransaction>
}
export interface GeneratedPolicyQuery<Params, Row> {
  readonly sql: string
  readonly queryHash: string
  readonly role: string
  readonly schemaVersion: string
  readonly policyVersion: string
  execute(client: PolicySqlClient, params: Params): Promise<Row[]>
}
