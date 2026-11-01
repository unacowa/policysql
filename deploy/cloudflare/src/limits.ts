// The runtime's effective limits (ADR 0024, "One place for limits"). The wrapper configures
// them once, as `RuntimeLimits`, and the runtime validates them and fills the defaults. The
// engine holds no copy: every limit it enforces and every limit Capabilities advertises is
// read here, from the loaded runtime.

/**
 * The deployment's limits, configured here and nowhere else (ADR 0024). The runtime
 * validates them at construction and reports the effective values, which the engine
 * enforces and Capabilities advertises. Every value is a positive integer; the ranges and
 * defaults are in `docs/configuration.md`. Any other key is rejected.
 */
export type RuntimeLimits = {
  /** Rows per statement (at most 100,000, ADR 0027). */
  maxRows: number;
  /**
   * Encoded result bytes per statement, and cumulatively per atomic envelope (at most 524,288,
   * ADR 0027).
   */
  maxResultBytes: number;
  /** Database timeout per statement, in milliseconds. */
  timeoutMs: number;
  /** Statements per atomic envelope (at most 64, ADR 0027). */
  maxStatements: number;
  /** Interactive transaction duration from begin, in milliseconds (default 4,000, at most 60,000). */
  transactionMs?: number;
  /** Statements per interactive transaction and callback queries per commit check (default 8, at most 256). */
  maxTransactionStatements?: number;
  /** Cumulative result bytes per interactive transaction and per check's callbacks (default 64,000, at most 65,536). */
  maxTransactionResultBytes?: number;
  /** Cumulative callback rows per commit check (default 100, at most 10,000). */
  maxCallbackRows?: number;
  /** BEGIN timeout of an interactive transaction, in milliseconds (default 1,000, at most 60,000). */
  beginTimeoutMs?: number;
  /** Connection and BEGIN timeout of the cost observation, in milliseconds (default 1,000, at most 10,000). */
  costTimeoutMs?: number;
  /** UTF-8 bytes of a request body as received, BOM included (default 1,048,576; 65,536 to 2,097,152; ADR 0027). */
  maxRequestBytes?: number;
  /**
   * JSON values plus object member names in one request body, and, separately, the raw values of
   * one atomic envelope's or interactive statement's database result: every cell (visibility and
   * check companions included), every column descriptor, and every value inside a JSON-typed cell
   * (default 65,536; 1,024 to 131,072).
   */
  maxJsonValues?: number;
  /** UTF-8 bytes of one statement's SQL (default 65,536; 1,024 to 1,048,576, and at most `maxRequestBytes`). */
  maxSqlBytes?: number;
  /**
   * Decoded bytes of one bytes value: a client parameter, a policy preset, a result cell
   * (default 262,144; 1 to 1,048,576; ADR 0027). An upper bound, not a promise: on every path
   * the smallest applicable limit governs (`maxRequestBytes`, `maxSqlBytes`, `maxResultBytes`,
   * the interactive result cap), see `docs/configuration.md`.
   */
  maxBytesPerValue?: number;
  /**
   * Distinct client parameter names in one statement (default 1,024; 1 to 16,384). Input-side:
   * it bounds PolicySQL's own work on the client's SQL and does not promise that a request
   * within it compiles (ADR 0027).
   */
  maxParameters?: number;
  /** Binder expression depth of the client's SQL (default 32; 1 to 64). Input-side, as `maxParameters`. */
  maxExpressionDepth?: number;
  /** Result columns per SELECT or RETURNING in the client's SQL (default 128; 1 to 2,000). Input-side. */
  maxProjections?: number;
  /** Joins per FROM in the client's SQL (default 8; 1 to 63). Input-side. */
  maxJoins?: number;
  /**
   * UTF-8 bytes of a complete success response (default `maxResultBytes` + 65,536; from
   * `maxResultBytes` + 3,072 to 589,824). An atomic envelope whose response, plus a 1,024-byte
   * reserve for what is added after commit, exceeds it is rolled back with 413
   * `POLICYSQL_LIMIT_EXCEEDED` before COMMIT (ADR 0027).
   */
  maxResponseBytes?: number;
};

// The constructor's field for each `RuntimeLimits` key. The runtime owns the defaults and
// ranges; an omitted optional key is omitted here so the runtime's default applies.
const RUNTIME_LIMIT_FIELDS: Readonly<Record<keyof RuntimeLimits, string>> = Object.freeze({
  maxRows: "max_rows",
  maxResultBytes: "max_result_bytes",
  timeoutMs: "timeout_ms",
  maxStatements: "max_statements",
  transactionMs: "transaction_ms",
  maxTransactionStatements: "max_transaction_statements",
  maxTransactionResultBytes: "max_transaction_result_bytes",
  maxCallbackRows: "max_callback_rows",
  beginTimeoutMs: "begin_timeout_ms",
  costTimeoutMs: "cost_timeout_ms",
  maxRequestBytes: "max_request_bytes",
  maxJsonValues: "max_json_values",
  maxSqlBytes: "max_sql_bytes",
  maxBytesPerValue: "max_bytes_per_value",
  maxParameters: "max_parameters",
  maxExpressionDepth: "max_expression_depth",
  maxProjections: "max_projections",
  maxJoins: "max_joins",
  maxResponseBytes: "max_response_bytes",
});

/**
 * The runtime's `limits_json`. Rejects, naming the key, anything but a plain object of
 * known keys with positive safe-integer values, so a misspelled limit never falls back to a
 * default. The runtime then checks each range and names the field it rejects.
 */
export const runtimeLimitsJson = (limits: unknown): string => {
  if (!limits || Array.isArray(limits) || typeof limits !== "object") {
    throw new TypeError("limits must be an object of RuntimeLimits");
  }
  const fields: Record<string, number> = {};
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(RUNTIME_LIMIT_FIELDS, key)) throw new TypeError(`limits.${key} is not a runtime limit`);
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new TypeError(`limits.${key} must be a positive integer`);
    }
    fields[RUNTIME_LIMIT_FIELDS[key as keyof RuntimeLimits]] = value as number;
  }
  return JSON.stringify(fields);
};

/** What `PolicySqlRuntime.limits_json()` reports. Every value is a positive safe integer. */
export type EnforcedLimits = Readonly<{
  /** Per statement: rows, encoded result bytes, and database timeout (configured). */
  maxRows: number;
  maxResultBytes: number;
  timeoutMs: number;
  /** Statements per atomic envelope (configured). */
  maxStatements: number;
  /** Interactive transaction duration from begin; also the atomic owner deadline. */
  transactionMs: number;
  /** Statements per interactive transaction; also the callback queries per commit check. */
  maxTransactionStatements: number;
  /** Cumulative result bytes per interactive transaction and per check's callbacks. */
  maxTransactionResultBytes: number;
  /** Cumulative callback rows per commit check. */
  maxCallbackRows: number;
  /** BEGIN timeout of an interactive transaction. */
  beginTimeoutMs: number;
  /** Connection and BEGIN timeout of the after-response cost observation. */
  costTimeoutMs: number;
  /** Request body bytes as received (configured, ADR 0027). */
  maxRequestBytes: number;
  /** JSON values plus member names in one request body, and raw values of a result (configured). */
  maxJsonValues: number;
  /** UTF-8 bytes of one statement's SQL (configured). */
  maxSqlBytes: number;
  /** Decoded bytes of one bytes value (configured, ADR 0027 pull request 5). */
  maxBytesPerValue: number;
  /** Input-side limits of the binder (configured, ADR 0027 pull request 4). */
  maxParameters: number;
  maxExpressionDepth: number;
  maxProjections: number;
  maxJoins: number;
  /** UTF-8 bytes of a complete success response (configured, ADR 0027 pull request 6). */
  maxResponseBytes: number;
  /** Fixed protocol constants that core enforces. */
  maxCommitChecks: number;
  maxHookDurationMs: number;
}>;

export const ENFORCED_LIMIT_KEYS = Object.freeze([
  "maxRows", "maxResultBytes", "timeoutMs", "maxStatements",
  "transactionMs", "maxTransactionStatements", "maxTransactionResultBytes", "maxCallbackRows",
  "beginTimeoutMs", "costTimeoutMs",
  "maxRequestBytes", "maxJsonValues", "maxSqlBytes", "maxBytesPerValue",
  "maxParameters", "maxExpressionDepth", "maxProjections", "maxJoins", "maxResponseBytes",
  "maxCommitChecks", "maxHookDurationMs",
] as const);

const invalid = () => new TypeError("PolicySQL runtime reports invalid limits");

// A runtime is immutable once activated, so its limits are parsed once per runtime object.
const cache = new WeakMap<object, EnforcedLimits>();

/**
 * The limits of `runtime`, validated like any other host input: the exact key set, each a
 * positive safe integer. Anything else is an adapter wiring defect and fails closed, so no
 * caller can fall back to a value of its own.
 */
export const runtimeLimits = (runtime: unknown): EnforcedLimits => {
  if (!runtime || (typeof runtime !== "object" && typeof runtime !== "function")) throw invalid();
  const cached = cache.get(runtime);
  if (cached) return cached;
  const report = (runtime as { limits_json?: unknown }).limits_json;
  if (typeof report !== "function") throw invalid();
  let value: unknown;
  try { value = JSON.parse(report.call(runtime)); } catch { throw invalid(); }
  if (!value || Array.isArray(value) || typeof value !== "object") throw invalid();
  const keys = Object.keys(value);
  if (keys.length !== ENFORCED_LIMIT_KEYS.length ||
    !ENFORCED_LIMIT_KEYS.every((key) => Number.isSafeInteger(value[key]) && value[key] > 0)) {
    throw invalid();
  }
  const limits = Object.freeze(Object.fromEntries(ENFORCED_LIMIT_KEYS.map((key) => [key, value[key]]))) as EnforcedLimits;
  cache.set(runtime, limits);
  return limits;
};
