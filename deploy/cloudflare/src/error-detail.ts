// `error.detail` (ADR 0030): values fixed per code, enumerations, numbers, and request
// pointers of a fixed form only. No string that the database, the parser, or a validator made,
// and no identifier. Each boundary that
// reads an error from another party checks it against this table, the same one as
// `ErrorDetail::allowed` in crates/policysql-transaction/src/machine/io.rs.
import { CONSTRAINT_KINDS, type ConstraintKind } from "./database-constraint.ts";

/**
 * The constructs `feature` names (`POLICYSQL_UNSUPPORTED_SQL`), by their SQL syntax. The same
 * list as `UNSUPPORTED_FEATURES` in crates/policysql-transaction/src/machine/io.rs;
 * `test/error-detail.test.mjs` keeps the two, the OpenAPI enum and the client type in step.
 */
export const UNSUPPORTED_FEATURES: readonly string[] = Object.freeze([
  "explain", "statement", "constant_select", "star", "json_collection", "delete", "update",
  "insert", "insert_select", "compound_select", "values", "distinct", "window_clause",
  "group_by", "nulls_ordering", "cte", "derived_table", "table_source", "database_qualifier",
  "indexed_by", "join", "self_join", "window_function", "subquery", "expression", "cast",
  "function", "literal", "missing_from", "duplicate_alias", "duplicate_write_column",
  "insert_arity", "protected_statement",
]);

/** The reasons `reason` names (`POLICYSQL_INVALID_PARAMETER`). */
export const PARAMETER_REASONS: readonly string[] = Object.freeze([
  "positional", "prefix", "name", "type", "null", "literal", "value", "names",
]);

/** The causes `complexity` names (`POLICYSQL_SQL_TOO_COMPLEX`); `database` when none was named. */
export const COMPLEXITY_DETAILS: readonly string[] = Object.freeze([
  "height", "recursion", "columns", "parameters", "like_pattern", "column_metadata",
  "database_expression_depth", "function_arguments", "compound_terms", "join_tables", "database",
]);

/** The expectations `expectation` names (`POLICYSQL_EXPECTATION_FAILED`). */
export const EXPECTATIONS: readonly string[] = Object.freeze(["affectedRows", "rowCount"]);

/** The largest `span` offset: the ceiling of a statement's byte length (`MAX_SQL_BYTES_CEILING`). */
export const MAX_SPAN_OFFSET = 1_048_576;

export type ErrorDetail = Readonly<{
  constraint?: ConstraintKind;
  /** The refusal behind a keyed `POLICYSQL_OUTCOME_UNKNOWN`: the code, path and detail of the unkeyed answer. */
  cause?: Readonly<{ code: string; path: string | null; detail: ErrorDetail | null }>;
  /** `POLICYSQL_UNSUPPORTED_SQL`: the construct, by its syntax. */
  feature?: string;
  /** `POLICYSQL_INVALID_SQL`: the offending token in the statement's UTF-8 bytes, `[start, end)`. */
  span?: Readonly<{ start: number; end: number }>;
  /** `POLICYSQL_INVALID_PARAMETER`. */
  reason?: string;
  /** `POLICYSQL_SQL_TOO_COMPLEX`. */
  complexity?: string;
  /** `POLICYSQL_EXPECTATION_FAILED`. */
  expectation?: string;
}>;

/**
 * The codes a keyed execute refused before the database was read can carry as `cause.code`,
 * without the `POLICYSQL_` prefix (ADR 0030 amendment): every code a compile returns, the
 * session gate's and the body limits'. A code that depends on the database's state is never
 * here. The same list as `OUTCOME_CAUSE_CODES` in crates/policysql-transaction/src/machine/io.rs;
 * this list decides no answer, it only checks one.
 */
export const OUTCOME_CAUSES: readonly string[] = Object.freeze([
  "FORBIDDEN_ACCESS", "STALE_OPERATION", "INVALID_REQUEST", "REQUEST_TOO_LARGE", "JSON_TOO_DEEP",
  "INVALID_SQL", "MULTIPLE_STATEMENTS", "UNSUPPORTED_SQL", "MISSING_POLICY", "FORBIDDEN_OPERATION",
  "FORBIDDEN_COLUMN", "FORBIDDEN_COLUMN_CONTEXT", "DUPLICATE_RESULT_COLUMN", "INVALID_PARAMETER",
  "AMBIGUOUS_PARAMETER_TYPE", "RESERVED_PARAMETER", "PRESET_COLUMN", "LIMIT_EXCEEDED",
  "EXPECTATION_FAILED", "SQL_TOO_COMPLEX", "INTERNAL", "DATABASE_UNAVAILABLE",
]);

const CAUSE_PREFIX = "POLICYSQL_";
/** A statement's pointer, or its SQL's: a canonical decimal index of 1 to 10 digits. */
const CAUSE_PATH = /^\/statements\/(?:0|[1-9][0-9]{0,9})(?:\/sql)?$/u;

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** One row of the table: how a detail of the code is checked, and whether the code must carry one. */
type DetailRow = Readonly<{
  required: boolean;
  check: (detail: Record<string, unknown>) => ErrorDetail | null;
}>;

/** A detail of exactly one key `key`, whose value is one of `values`. */
const enumerated = (key: "feature" | "reason" | "complexity" | "expectation", values: readonly string[]): DetailRow => ({
  required: true,
  check: (detail) => Object.keys(detail).length === 1 && Object.hasOwn(detail, key)
    && typeof detail[key] === "string" && values.includes(detail[key])
    ? Object.freeze({ [key]: detail[key] as string }) : null,
});

const isOffset = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SPAN_OFFSET;

/** The `cause` of a keyed unknown outcome: exactly `code`, `path` and `detail`, the last checked as the cause's code allows. */
const checkedCause = (cause: Record<string, unknown>): ErrorDetail["cause"] | null => {
  const causeKeys = Object.keys(cause).sort();
  if (causeKeys.length !== 3 || causeKeys[0] !== "code" || causeKeys[1] !== "detail" || causeKeys[2] !== "path") return null;
  const { code, path, detail } = cause;
  if (typeof code !== "string" || !code.startsWith(CAUSE_PREFIX)
    || !OUTCOME_CAUSES.includes(code.slice(CAUSE_PREFIX.length))) return null;
  if (path !== null && !(typeof path === "string" && CAUSE_PATH.test(path))) return null;
  // `POLICYSQL_OUTCOME_UNKNOWN` is not a cause code, so this check cannot recurse further. A
  // `null` detail is the absence of one: valid only where the cause's code does not require it.
  if (detail !== null && !isPlain(detail)) return null;
  const checked = checkedErrorDetail(code, detail === null ? undefined : detail);
  if (checked === null) return null;
  return Object.freeze({ code, path, detail: checked ?? null });
};

/**
 * One row per code that carries a detail: the check of its shape, returning a frozen copy that
 * shares nothing with what was read. A later change adds a row and a field.
 */
const DETAIL_ROWS: Readonly<Record<string, DetailRow>> = Object.freeze({
  POLICYSQL_CONSTRAINT_VIOLATION: {
    required: true,
    check: (detail) => Object.keys(detail).length === 1
      && (CONSTRAINT_KINDS as readonly unknown[]).includes(detail.constraint)
      ? Object.freeze({ constraint: detail.constraint as ConstraintKind }) : null,
  },
  POLICYSQL_OUTCOME_UNKNOWN: {
    required: true,
    check: (detail) => {
      const cause = detail.cause;
      if (Object.keys(detail).length !== 1 || !Object.hasOwn(detail, "cause") || !isPlain(cause)) return null;
      const checked = checkedCause(cause);
      return checked === null ? null : Object.freeze({ cause: checked });
    },
  },
  // The span is optional: a parse error the parser reports no position for has no detail.
  POLICYSQL_INVALID_SQL: {
    required: false,
    check: (detail) => {
      const span = detail.span;
      if (Object.keys(detail).length !== 1 || !Object.hasOwn(detail, "span") || !isPlain(span)) return null;
      const keys = Object.keys(span).sort();
      if (keys.length !== 2 || keys[0] !== "end" || keys[1] !== "start") return null;
      const { start, end } = span;
      if (!isOffset(start) || !isOffset(end) || start > end) return null;
      return Object.freeze({ span: Object.freeze({ start, end }) });
    },
  },
  POLICYSQL_UNSUPPORTED_SQL: enumerated("feature", UNSUPPORTED_FEATURES),
  POLICYSQL_INVALID_PARAMETER: enumerated("reason", PARAMETER_REASONS),
  POLICYSQL_SQL_TOO_COMPLEX: enumerated("complexity", COMPLEXITY_DETAILS),
  POLICYSQL_EXPECTATION_FAILED: enumerated("expectation", EXPECTATIONS),
});

/**
 * The checked detail: undefined for a code without one (or an optional one that is absent),
 * null when the detail is not what the code allows. A required detail that is missing is null.
 */
export const checkedErrorDetail = (code: string, detail: unknown): ErrorDetail | undefined | null => {
  const row = Object.hasOwn(DETAIL_ROWS, code) ? DETAIL_ROWS[code] : undefined;
  if (row === undefined) return detail === undefined ? undefined : null;
  if (detail === undefined) return row.required ? null : undefined;
  return isPlain(detail) ? row.check(detail) : null;
};
