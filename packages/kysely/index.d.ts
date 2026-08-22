import type { PolicyExecuteOptions, PolicyExecuteResult, PolicySqlClient } from '@unacowa/policysql/client'
import type { RootOperationNode } from 'kysely'

export type NullableOnDenied<T> = T | null
export type PolicyOperation = 'select' | 'insert' | 'update' | 'delete'
export interface CompilableQuery<Row> {
  compile(): { sql: string; parameters?: readonly unknown[] }
  toOperationNode?(): RootOperationNode
  readonly kysely?: object
}
export interface CompiledPolicyQuery {
  operation: PolicyOperation
  sql: string
  params: Record<string, unknown>
}
export type PolicyQueryResult<Row> = PolicyExecuteResult<Row>
export interface PolicyQueryExecution<Row> {
  execute(): Promise<Row[]>
  executeTakeFirst(): Promise<Row | undefined>
  executeTakeFirstOrThrow(): Promise<Row>
  executeWithPolicyMeta(): Promise<PolicyQueryResult<Row>>
}
export interface PolicyKyselyOptions<DB> {
  kysely: DB
  client: PolicySqlClient
  onQuery?: (request: CompiledPolicyQuery) => void
  onResult?: (event: { request: CompiledPolicyQuery; result: PolicyQueryResult<unknown> }) => void
  onError?: (event: { request: CompiledPolicyQuery; error: unknown }) => void
}

export function compilePolicyQuery<Row>(query: CompilableQuery<Row>): CompiledPolicyQuery
export function bindPolicyKysely<DB>(
  kysely: DB,
  clientOrOptions: PolicySqlClient | Omit<PolicyKyselyOptions<DB>, 'kysely'>,
): DB
export function createPolicyKysely<DB>(options: PolicyKyselyOptions<DB>): DB
export function policyQuery<Row>(
  query: CompilableQuery<Row>,
  options?: PolicyExecuteOptions,
  client?: PolicySqlClient,
): PolicyQueryExecution<Row>
export function policySelect<Row>(
  query: CompilableQuery<Row>,
  resource: string,
  conditionalColumns?: readonly string[],
  client?: PolicySqlClient,
): PolicyQueryExecution<Row>
export function policyMutation<Row>(
  query: CompilableQuery<Row>,
  options?: PolicyExecuteOptions,
  client?: PolicySqlClient,
): PolicyQueryExecution<Row>
