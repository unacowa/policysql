// How a database adapter recognizes a statement the database refused for a constraint (ADR 0030).
//
// A constraint violation is a definite refusal only when the adapter can show that the failed
// statement is the last one that ran and that the transaction is still open. The statement batch
// of #144 runs each step only if the previous one succeeded, and the reply keeps its baton while
// the transaction is open, so the classification happens only for a step error of such a reply
// (turso-http.ts). A reply that ends the stream proves neither, and stays a 503.
//
// The class is chosen by the code alone, and only by an exact match of SQLITE_CONSTRAINT: an
// extended code (SQLITE_CONSTRAINT_UNIQUE) is not classified. The kind is read from the message
// only to classify. The message is never logged, returned, or kept, since SQLite's messages name
// tables, columns, and constraints, and a trigger's message is whatever string its author wrote.

export const CONSTRAINT_CODE = "SQLITE_CONSTRAINT";
export const CONSTRAINT_WRAPPER = "SQLite error: ";
export const CONSTRAINT_KINDS = Object.freeze(["unique", "not_null", "foreign_key", "check", "other"] as const);
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

/**
 * The messages SQLite gives each kind (a PRIMARY KEY has the UNIQUE message). `smokeVerified`:
 * the release smoke sends a statement that produces the prefix to the real database.
 */
export const CONSTRAINT_PREFIXES: readonly Readonly<{ prefix: string; constraint: ConstraintKind; smokeVerified: boolean }>[] =
  Object.freeze([
    { prefix: "UNIQUE constraint failed", constraint: "unique", smokeVerified: true },
    { prefix: "NOT NULL constraint failed", constraint: "not_null", smokeVerified: true },
    { prefix: "FOREIGN KEY constraint failed", constraint: "foreign_key", smokeVerified: true },
    { prefix: "CHECK constraint failed", constraint: "check", smokeVerified: true },
  ]);

/** A statement the database refused for a constraint. It holds a fixed kind and the statement's index, never text. */
export class SqlConstraintError extends Error {
  readonly statement: number;
  readonly constraint: ConstraintKind;
  /** The database's code, for the log. Always CONSTRAINT_CODE. */
  readonly databaseCode = CONSTRAINT_CODE;

  constructor(statement: number, constraint: ConstraintKind) {
    super("The database refused the statement for a constraint.");
    this.statement = statement;
    this.constraint = constraint;
  }
}

/** The kind of a refused statement's Hrana error object, or null when its code is not CONSTRAINT_CODE exactly. */
export const constraintKind = (error: unknown): ConstraintKind | null => {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (code !== CONSTRAINT_CODE) return null;
  if (typeof message !== "string" || !message.startsWith(CONSTRAINT_WRAPPER)) return "other";
  const text = message.slice(CONSTRAINT_WRAPPER.length);
  return CONSTRAINT_PREFIXES.find((entry) => text.startsWith(entry.prefix))?.constraint ?? "other";
};
