import type { PolicyExecuteResult, PolicyExpectation, PolicySqlClient } from '@unacowa/policysql/client'
import type { DatabaseIntrospector, Dialect, DialectAdapter, Driver, Kysely, KyselyPlugin, QueryCompiler } from 'kysely'

export type NullableOnDenied<T> = T | null
export interface PolicySqlDialectOptions {
  client: PolicySqlClient
  /** Generate a fresh key per atomic mutation execution. Never applies to interactive transactions. Default false. */
  autoIdempotencyKey?: boolean
}
export interface PolicyOptions {
  /** Only for atomic mutations outside an interactive transaction. */
  idempotencyKey?: string
  expect?: PolicyExpectation
  /** Receives a separate copy of raw gateway rows/metadata, before Kysely result transformations. */
  onResponse?: (response: PolicyExecuteResult) => void | Promise<void>
}
export class PolicySqlDialect implements Dialect {
  constructor(options: PolicySqlDialectOptions)
  createAdapter(): DialectAdapter
  createQueryCompiler(): QueryCompiler
  createDriver(): Driver
  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector
}
/** Attach last, to the executed root query. Does not replace any Kysely execute method. */
export function policyOptions(options?: PolicyOptions): KyselyPlugin
