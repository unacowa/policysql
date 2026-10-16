import { HttpError } from "./errors.ts";
import { stableJson } from "./idempotency.ts";
import type { WorkerBindings } from "./types.ts";

/** Server-owned identity. Never put credentials or a client-selected URL here. */
export type DatabaseBinding = Readonly<{
  version: 1;
  scope: string;
  databaseId: string;
  generation: string;
  snapshot: string;
}>;

export type DatabaseUsage = { rowsRead: number; rowsWritten: number; queryDurationMs: number };
export type DatabaseResult = {
  columns: string[];
  rows: unknown[][];
  rowsAffected: number;
  usage: DatabaseUsage;
};
export interface DatabaseTransaction {
  readonly open: boolean;
  readonly usage: DatabaseUsage[];
  execute(statements: { sql: string; args?: Record<string, unknown> }[]): Promise<DatabaseResult[]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
export interface DatabaseTransport {
  /** Bound each operation by timeoutMs and the shared absolute deadline when supplied. */
  begin(mode: "read" | "write", timeoutMs: number, deadlineMs?: number): Promise<DatabaseTransaction>;
}
export interface DatabaseProvider {
  /** Must return exactly true. Called in the Worker and DO, including before callbacks/commit. */
  check(binding: DatabaseBinding, env: WorkerBindings): boolean | Promise<boolean>;
  /** Construct a transport only; PolicySQL owns BEGIN and the transaction lifecycle. */
  connect(binding: DatabaseBinding, env: WorkerBindings, requestId: string): DatabaseTransport | Promise<DatabaseTransport>;
}

export const databaseRequired = () => new HttpError(500, "POLICYSQL_DATABASE_REQUIRED", "A database must be supplied by the application wrapper.");

const denied = () => new HttpError(403, "POLICYSQL_DATABASE_BINDING_REJECTED", "The database binding is not permitted.");
const unavailable = () => new HttpError(503, "POLICYSQL_DATABASE_UNAVAILABLE", "The database is temporarily unavailable.");
const stale = () => new HttpError(409, "POLICYSQL_STALE_OPERATION", "The operation was compiled for a different active snapshot.");
const timedOut = () => new HttpError(504, "POLICYSQL_DATABASE_TIMEOUT", "The database operation timed out.");

export const remainingDatabaseTime = (deadlineMs?: number) => {
  if (deadlineMs === undefined) return Number.POSITIVE_INFINITY;
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw timedOut();
  return remaining;
};

export const validateDatabaseProvider = (provider: unknown) => {
  if (!provider || typeof provider !== "object" ||
    ["check", "connect"].some((key) => typeof provider[key] !== "function")) {
    throw new TypeError("database is required and must provide check and connect functions");
  }
};

// A wrapper failure must neither leak its error text nor hold a transaction indefinitely.
const bounded = async <T>(operation: () => T | Promise<T>, deadlineMs?: number): Promise<T> => {
  const remaining = remainingDatabaseTime(deadlineMs);
  const providerDeadline = Date.now() + 1_000;
  let timer: ReturnType<typeof setTimeout>;
  try {
    const value = await Promise.race([
      // Normalize only provider failures; preserve our own deadline error.
      Promise.resolve().then(operation).catch(() => { throw unavailable(); }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(remaining <= 1_000 ? timedOut() : unavailable()), Math.min(1_000, remaining));
      }),
    ]);
    remainingDatabaseTime(deadlineMs);
    if (Date.now() >= providerDeadline) throw unavailable();
    return value;
  } finally { clearTimeout(timer); }
};

export const validateDatabaseBinding = (value: unknown, snapshot: string): DatabaseBinding => {
  let binding: DatabaseBinding;
  try { binding = structuredClone(value) as DatabaseBinding; } catch { throw denied(); }
  const keys = ["version", "scope", "databaseId", "generation", "snapshot"];
  if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
    Object.keys(binding).length !== keys.length || Object.keys(binding).some((key) => !keys.includes(key)) ||
    binding.version !== 1 ||
    ![binding.scope, binding.databaseId, binding.generation, binding.snapshot].every((part) =>
      typeof part === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(part))) throw denied();
  if (typeof snapshot !== "string" || binding.snapshot !== snapshot) throw stale();
  return Object.freeze({ ...binding });
};

export const sameDatabaseBinding = (left, right) => stableJson(left ?? null) === stableJson(right ?? null);

export const checkDatabaseBinding = async (provider: DatabaseProvider, binding, env, snapshot, deadlineMs?: number) => {
  validateDatabaseProvider(provider);
  if (binding === undefined || binding === null) throw databaseRequired();
  const checked = validateDatabaseBinding(binding, snapshot);
  if (await bounded(() => provider.check(checked, env), deadlineMs) !== true) throw denied();
  return checked;
};

export const databaseTransportFactory = (provider: DatabaseProvider, binding: DatabaseBinding, deadlineMs?: number) => {
  const pinned = validateDatabaseBinding(binding, binding?.snapshot);
  return async (env: WorkerBindings, requestId: string, executionDeadlineMs?: number): Promise<DatabaseTransport> => {
    const startedAt = Date.now();
    const deadline = deadlineMs === undefined ? executionDeadlineMs
      : executionDeadlineMs === undefined ? deadlineMs : Math.min(deadlineMs, executionDeadlineMs);
    await checkDatabaseBinding(provider, pinned, env, pinned.snapshot, deadline);
    const transport = await bounded(() => provider.connect(pinned, env, requestId), deadline);
    if (!transport || typeof transport.begin !== "function") throw unavailable();
    return {
      async begin(mode, timeoutMs) {
        // Even callers without an explicit deadline count preparation toward the budget.
        const expiresAt = deadline ?? startedAt + timeoutMs;
        const transaction = await transport.begin(mode, Math.min(timeoutMs, remainingDatabaseTime(expiresAt)), expiresAt);
        try { remainingDatabaseTime(expiresAt); } catch (error) {
          try { await transaction.rollback(); } catch { /* remote timeout is terminal */ }
          throw error;
        }
        return {
          get open() { return transaction.open; },
          get usage() { return transaction.usage; },
          async execute(statements) {
            remainingDatabaseTime(expiresAt);
            const results = await transaction.execute(statements);
            remainingDatabaseTime(expiresAt);
            return results;
          },
          rollback: () => transaction.rollback(),
          async commit() {
            try {
              await checkDatabaseBinding(provider, pinned, env, pinned.snapshot, expiresAt);
              remainingDatabaseTime(expiresAt);
            }
            catch (error) {
              try { await transaction.rollback(); } catch { /* remote timeout is terminal */ }
              throw error;
            }
            await transaction.commit();
          },
        };
      },
    };
  };
};
