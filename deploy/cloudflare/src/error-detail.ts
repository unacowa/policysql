// `error.detail` (ADR 0030): values fixed per code, enumerations and numbers only. No string
// that the database, the parser, or a validator made, and no identifier. Each boundary that
// reads an error from another party checks it against this table, the same one as
// `ErrorDetail::allowed` in crates/policysql-transaction/src/machine/io.rs.
import { CONSTRAINT_KINDS, type ConstraintKind } from "./database-constraint.ts";

export type ErrorDetail = Readonly<{ constraint?: ConstraintKind }>;

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** One row per code that carries a detail. A later change adds a row and a field. */
const DETAIL_CHECKS: Readonly<Record<string, (detail: Record<string, unknown>) => boolean>> = Object.freeze({
  POLICYSQL_CONSTRAINT_VIOLATION: (detail) => Object.keys(detail).length === 1
    && (CONSTRAINT_KINDS as readonly unknown[]).includes(detail.constraint),
});

/** The checked detail: undefined for a code without one, null when the detail is not what the code allows. */
export const checkedErrorDetail = (code: string, detail: unknown): ErrorDetail | undefined | null => {
  const check = Object.hasOwn(DETAIL_CHECKS, code) ? DETAIL_CHECKS[code] : undefined;
  if (check === undefined) return detail === undefined ? undefined : null;
  return isPlain(detail) && check(detail) ? Object.freeze({ ...detail }) as ErrorDetail : null;
};
