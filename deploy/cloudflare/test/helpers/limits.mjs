// What a test double of the runtime reports from `limits_json()`: the defaults the runtime
// fills for the reference wrapper's configuration. The engine reads every limit from the
// runtime (src/limits.ts), so a double without `limits_json` fails closed.
export const RUNTIME_DEFAULT_LIMITS = Object.freeze({
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
  maxRequestBytes: 1_048_576,
  maxSqlBytes: 65_536,
  maxJoins: 8,
  maxCommitChecks: 4,
  maxHookDurationMs: 1_500,
});

/** A `limits_json` method for a runtime double, with `overrides` over the defaults. */
export const limitsJson = (overrides = {}) => () => JSON.stringify({ ...RUNTIME_DEFAULT_LIMITS, ...overrides });

/** The reference wrapper's constructor limits as snake_case `limits_json` text. */
export const CONSTRUCTOR_LIMITS = JSON.stringify({ max_rows: 100, max_result_bytes: 64_000, timeout_ms: 1_000, max_statements: 8 });
