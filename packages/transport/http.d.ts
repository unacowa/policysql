import type { PolicySqlTransport } from './index.js'
export interface TokenProvider {
  /** Called for each send. Credential caching and account switches belong to the provider. */
  getToken(options: { minValidityMs: number; signal: AbortSignal }): Promise<{
    token: string
    /** Milliseconds since the Unix epoch. */
    expiresAt: number
  }>
}
export type HttpTransportOptions = {
  endpoint: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  transactionMaxDurationMs?: number
  clockToleranceMs?: number
} & ({ token: string; tokenProvider?: never } | { token?: never; tokenProvider: TokenProvider })
export function createHttpTransport(options: HttpTransportOptions): PolicySqlTransport
