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
  begin(mode: "read" | "write", timeoutMs: number): Promise<DatabaseTransaction>;
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

export const validateDatabaseProvider = (provider: unknown) => {
  if (!provider || typeof provider !== "object" ||
    ["check", "connect"].some((key) => typeof provider[key] !== "function")) {
    throw new TypeError("database is required and must provide check and connect functions");
  }
};

// A wrapper failure must neither leak its error text nor hold a transaction indefinitely.
const bounded = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), 1_000); }),
    ]);
  } catch { throw unavailable(); }
  finally { clearTimeout(timer); }
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

export const checkDatabaseBinding = async (provider: DatabaseProvider, binding, env, snapshot) => {
  validateDatabaseProvider(provider);
  if (binding === undefined || binding === null) throw databaseRequired();
  const checked = validateDatabaseBinding(binding, snapshot);
  if (await bounded(() => provider.check(checked, env)) !== true) throw denied();
  return checked;
};

export const databaseTransportFactory = (provider: DatabaseProvider, binding: DatabaseBinding, deadlineMs?: number) => {
  const pinned = validateDatabaseBinding(binding, binding?.snapshot);
  return async (env: WorkerBindings, requestId: string): Promise<DatabaseTransport> => {
    await checkDatabaseBinding(provider, pinned, env, pinned.snapshot);
    const transport = await bounded(() => provider.connect(pinned, env, requestId));
    if (!transport || typeof transport.begin !== "function") throw unavailable();
    return {
      async begin(mode, timeoutMs) {
        const expiresAt = deadlineMs ?? Date.now() + timeoutMs;
        const assertTime = () => {
          if (Date.now() >= expiresAt) {
            throw new HttpError(504, "POLICYSQL_DATABASE_TIMEOUT", "The database operation timed out.");
          }
        };
        assertTime();
        const transaction = await transport.begin(mode, timeoutMs);
        try { assertTime(); } catch (error) {
          try { await transaction.rollback(); } catch { /* remote timeout is terminal */ }
          throw error;
        }
        return {
          get open() { return transaction.open; },
          get usage() { return transaction.usage; },
          execute: (statements) => { assertTime(); return transaction.execute(statements); },
          rollback: () => transaction.rollback(),
          async commit() {
            try {
              await checkDatabaseBinding(provider, pinned, env, pinned.snapshot);
              assertTime();
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
