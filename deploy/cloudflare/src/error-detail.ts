// `error.detail` (ADR 0030): values fixed per code, enumerations, numbers, and request
// pointers of a fixed form only. No string that the database, the parser, or a validator made,
// and no identifier. Each boundary that
// reads an error from another party checks it against this table, the same one as
// `ErrorDetail::allowed` in crates/policysql-transaction/src/machine/io.rs.
import { CONSTRAINT_KINDS, type ConstraintKind } from "./database-constraint.ts";

export type ErrorDetail = Readonly<{
  constraint?: ConstraintKind;
  /** The refusal behind a keyed `POLICYSQL_OUTCOME_UNKNOWN`: the code and path of the unkeyed answer. */
  cause?: Readonly<{ code: string; path: string | null }>;
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

/**
 * One row per code that carries a detail: the check of its shape, returning a frozen copy that
 * shares nothing with what was read. A later change adds a row and a field.
 */
const DETAIL_CHECKS: Readonly<Record<string, (detail: Record<string, unknown>) => ErrorDetail | null>> = Object.freeze({
  POLICYSQL_CONSTRAINT_VIOLATION: (detail) => Object.keys(detail).length === 1
    && (CONSTRAINT_KINDS as readonly unknown[]).includes(detail.constraint)
    ? Object.freeze({ constraint: detail.constraint as ConstraintKind }) : null,
  POLICYSQL_OUTCOME_UNKNOWN: (detail) => {
    const keys = Object.keys(detail);
    const cause = detail.cause;
    if (keys.length !== 1 || keys[0] !== "cause" || !isPlain(cause)) return null;
    const causeKeys = Object.keys(cause).sort();
    if (causeKeys.length !== 2 || causeKeys[0] !== "code" || causeKeys[1] !== "path") return null;
    const { code, path } = cause;
    if (typeof code !== "string" || !code.startsWith(CAUSE_PREFIX)
      || !OUTCOME_CAUSES.includes(code.slice(CAUSE_PREFIX.length))) return null;
    if (path !== null && !(typeof path === "string" && CAUSE_PATH.test(path))) return null;
    return Object.freeze({ cause: Object.freeze({ code, path }) });
  },
});

/** The checked detail: undefined for a code without one, null when the detail is not what the code allows. */
export const checkedErrorDetail = (code: string, detail: unknown): ErrorDetail | undefined | null => {
  const check = Object.hasOwn(DETAIL_CHECKS, code) ? DETAIL_CHECKS[code] : undefined;
  if (check === undefined) return detail === undefined ? undefined : null;
  return isPlain(detail) ? check(detail) : null;
};
