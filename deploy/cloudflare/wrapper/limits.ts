import type { RuntimeLimits } from "../src/limits.ts";

// The only place this deployment sets limits (ADR 0024). The engine enforces and
// Capabilities advertises exactly these values, as the runtime reports them; the release
// smoke (scripts/provision-dev.mjs) checks the deployed Capabilities against this object.
export const RUNTIME_LIMITS: Readonly<RuntimeLimits> = Object.freeze({
  maxRows: 100,
  maxResultBytes: 64_000,
  timeoutMs: 1_000,
  maxStatements: 8,
  transactionMs: 4_000,
  maxTransactionStatements: 8,
  maxTransactionResultBytes: 64_000,
  maxCallbackRows: 100,
  beginTimeoutMs: 1_000,
  costTimeoutMs: 1_000,
  // Request-side limits, set explicitly (ADR 0021, ADR 0027); the runtime's defaults are the
  // same values. The CPU limit in wrangler.jsonc is checked against them by test.
  maxRequestBytes: 1_048_576,
  maxJsonValues: 65_536,
  maxSqlBytes: 65_536,
});
