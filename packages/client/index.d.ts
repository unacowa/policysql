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
export class PolicySqlClient {
  constructor(options: PolicySqlClientOptions)
  execute<Row = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown>,
    options?: PolicyExecuteOptions,
  ): Promise<{ rows: Row[]; meta: unknown; envelopeMeta: unknown }>
}
export interface GeneratedPolicyQuery<Params, Row> {
  readonly sql: string
  readonly queryHash: string
  readonly schemaVersion: string
  readonly policyVersion: string
  execute(client: PolicySqlClient, params: Params): Promise<Row[]>
}
