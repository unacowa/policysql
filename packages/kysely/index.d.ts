import type { PolicySqlClient } from '@policysql/client'
import type { RootOperationNode } from 'kysely'
export type NullableOnDenied<T> = T | null
export interface CompilableQuery<Row> {
  compile(): { sql: string; parameters?: readonly unknown[] }
  toOperationNode?(): RootOperationNode
  readonly kysely?: object
}
export function bindPolicyKysely<DB>(kysely: DB, client: PolicySqlClient): DB
export function createPolicyKysely<DB>(options: { kysely: DB; client: PolicySqlClient }): DB
export function policySelect<Row>(
  query: CompilableQuery<Row>,
  resource: string,
  conditionalColumns?: readonly string[],
  client?: PolicySqlClient,
): {
  execute(): Promise<Row[]>
  executeWithPolicyMeta(): Promise<{ rows: Row[]; meta: unknown; envelopeMeta: unknown }>
}
