import type { PolicySqlTransport } from './index.js'
export interface TokenProvider {
  currentContextKey(): string
  getToken(options: { contextKey: string; minValidityMs: number; signal: AbortSignal }): Promise<{
    token: string
    /** Milliseconds since the Unix epoch. */
    expiresAt: number
    contextKey: string
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
