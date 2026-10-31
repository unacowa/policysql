// How a database adapter recognizes a statement the database refused for complexity (ADR 0027,
// "Emitted statement complexity"). PolicySQL measures the statement it emits (core, exact counts
// on the AST); what only the database can know is classified here, from the Hrana error object
// of a statement request.
//
// A match requires the code of SQLite's general error (SQLITE_ERROR, which structurally excludes
// SQLITE_BUSY, SQLITE_CONSTRAINT, SQLITE_FULL, and every other code) AND a message that starts
// with one entry of a fixed allowlist derived from SQLite's SQLITE_LIMIT_* family. The message is
// read only to classify: it is never logged, returned, or kept, since SQLite's messages can name
// functions, tables, and columns.
//
// What the real Turso database sends differs from what ADR 0027 assumed, and the release smoke
// (scripts/smoke-sections.mjs) is what found it: Turso reports the general error as the code
// `SQLITE_UNKNOWN` with the message `SQLite error: <SQLite's text>`, and an error found while
// the statement is parsed (too many function arguments, too many SQL variables) as the code
// `SQL_INPUT_ERROR` with the message `SQLite input error: <SQLite's text> (at offset <n>)`. The
// code `SQLITE_ERROR` with SQLite's bare text is what SQLite itself, and a Hrana server that
// forwards the primary result code, sends. Each code has exactly one message wrapper, so a code
// and a wrapper never mix.
//
// Only statement requests are classified. BEGIN, COMMIT, and ROLLBACK are not, so a COMMIT is
// never reported as a complexity failure (ADR 0007).
import { EngineError } from "./errors.ts";

/** One allowlist entry: a message prefix and the fixed cause name core logs for it. */
export type ComplexityEntry = Readonly<{ prefix: string; cause: string; smokeVerified: boolean }>;

/**
 * The allowlist, one entry per SQLITE_LIMIT_* message that a statement can reach at prepare or
 * step time. `smokeVerified`: the release smoke sends a statement that produces the entry to the
 * real Turso database and fails when it stops matching (scripts/smoke-sections.mjs); an entry
 * without it is derived from SQLite's source and covered by unit tests only. A test asserts that
 * the smoke has a statement for exactly the verified entries.
 */
/**
 * The error codes that can carry a complexity refusal, each with the wrapper its server puts
 * before SQLite's text: SQLite's own `SQLITE_ERROR`; Turso's `SQLITE_UNKNOWN` (the general
 * error) and `SQL_INPUT_ERROR` (a refusal while the statement is parsed).
 */
export const COMPLEXITY_CODES: Readonly<Record<string, string>> = Object.freeze({
  SQLITE_ERROR: "",
  SQLITE_UNKNOWN: "SQLite error: ",
  SQL_INPUT_ERROR: "SQLite input error: ",
});

export const COMPLEXITY_ALLOWLIST: readonly ComplexityEntry[] = Object.freeze([
  // SQLITE_LIMIT_COLUMN: "too many columns in result set" (and in ORDER BY clause, GROUP BY
  // clause, set list, index, and the other "too many columns in ..." forms).
  { prefix: "too many columns in ", cause: "columns", smokeVerified: true },
  // SQLITE_LIMIT_VARIABLE_NUMBER.
  { prefix: "too many SQL variables", cause: "parameters", smokeVerified: true },
  // SQLITE_LIMIT_FUNCTION_ARG.
  { prefix: "too many arguments on function", cause: "function_arguments", smokeVerified: true },
  // SQLITE_LIMIT_COMPOUND_SELECT.
  { prefix: "too many terms in compound SELECT", cause: "compound_terms", smokeVerified: true },
  // The 64-table join limit.
  { prefix: "at most 64 tables in a join", cause: "join_tables", smokeVerified: true },
  // SQLITE_LIMIT_LIKE_PATTERN_LENGTH.
  { prefix: "LIKE or GLOB pattern too complex", cause: "like_pattern", smokeVerified: true },
  // SQLITE_LIMIT_EXPR_DEPTH.
  { prefix: "Expression tree is too large", cause: "database_expression_depth", smokeVerified: true },
]);

/** The statement the database refused for complexity. Carries a fixed cause name, never text. */
export class SqlComplexityError extends Error {
  readonly statement: number;
  readonly complexityCause: string;

  constructor(statement: number, cause: string) {
    super("The database refused the statement for complexity.");
    this.statement = statement;
    this.complexityCause = cause;
  }
}

/**
 * A statement the database refused for any other reason: a 503 as before. `databaseCode` is
 * the Hrana `code` only (never the message), restricted to `[A-Z0-9_]{1,64}`, for the
 * `database_error_unclassified` log.
 */
export class DatabaseStatementError extends EngineError {
  readonly databaseCode: string;

  constructor(databaseCode: string) {
    super("POLICYSQL_DATABASE_UNAVAILABLE", "The database is temporarily unavailable.");
    this.databaseCode = databaseCode;
  }
}

const SAFE_CODE = /^[A-Z0-9_]{1,64}$/u;

/** The cause name of a refused statement's Hrana error object, or null when it is not on the allowlist. */
export const complexityCause = (error: unknown): string | null => {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code !== "string" || typeof message !== "string" || !Object.hasOwn(COMPLEXITY_CODES, code)) return null;
  const wrapper = COMPLEXITY_CODES[code];
  if (!message.startsWith(wrapper)) return null;
  const text = message.slice(wrapper.length);
  return COMPLEXITY_ALLOWLIST.find((entry) => text.startsWith(entry.prefix))?.cause ?? null;
};

/** The failure of statement `index` of a pipeline, from its Hrana error object. */
export const statementFailure = (error: unknown, index: number): Error => {
  const cause = complexityCause(error);
  if (cause !== null) return new SqlComplexityError(index, cause);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return new DatabaseStatementError(typeof code === "string" && SAFE_CODE.test(code) ? code : "UNKNOWN");
};
