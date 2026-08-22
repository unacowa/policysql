export interface PolicySqlClientOptions {
  endpoint: string
  token: string
  role: string
  schemaVersion: string
  policyVersion: string
  fetchImpl?: typeof fetch
}
export interface PolicyExecuteOptions {
  idempotencyKey?: string
  expect?: { affectedRows?: number; rowCount?: number }
}
export interface PolicyExecuteResult<Row> {
  columns?: string[]
  rows: Row[]
  rowCount?: number
  affectedRows?: number
  meta: unknown
  envelopeMeta: unknown
}
export class PolicySqlClient {
  constructor(options: PolicySqlClientOptions)
  execute<Row = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown>,
    options?: PolicyExecuteOptions,
  ): Promise<PolicyExecuteResult<Row>>
}
export interface GeneratedPolicyQuery<Params, Row> {
  readonly sql: string
  readonly queryHash: string
  readonly schemaVersion: string
  readonly policyVersion: string
  execute(client: PolicySqlClient, params: Params): Promise<Row[]>
}
