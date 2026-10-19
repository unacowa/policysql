import type { PolicySqlTransport } from '@unacowa/policysql/client'
export interface GenerateOptions {
  /** Generation metadata only. The application configures the corresponding Transport/DB. */
  readonly endpoint: string
  readonly role: string
  readonly input: string
  readonly output: string
  readonly transport: PolicySqlTransport
  readonly signal?: AbortSignal
}
export function generate(options: GenerateOptions): Promise<void>
