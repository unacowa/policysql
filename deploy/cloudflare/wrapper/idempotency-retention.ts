// Idempotency record retention (ADR 0028). Not part of the published library.
//
// Keyed atomic writes store their committed reply in `policysql_idempotency` in the
// application database, in the same transaction as the mutation (ADR 0007, ADR 0024). Nothing
// in the library deletes those rows: the lookup of core's step machine is unfiltered by design
// (deleting a tombstone can only add executions, `crates/policysql-transaction/src/machine/
// step/atomic.rs`). This wrapper therefore deletes them administratively, outside the public
// endpoint, where the table is outside the catalog and default deny rejects it.
//
// The rules (ADR 0028; ADR 0026 sections 3, 4 and 6 without its public contract):
//
// - deletion is by age only (`created_at`, filled by the database's clock, never written by
//   core), in bounded batches by `rowid`, each batch its own short write transaction;
// - nothing is deleted for a table that does not exist or has no `created_at` (ADR 0007 allows
//   a deployment that never uses keys to have no table);
// - the window is fixed here and is not advertised: ADR 0026 section 5 (the configured,
//   advertised `idempotencyRetentionSeconds`, and the client rule that depends on it) is not
//   adopted. A client is told the reply is replayed "while retained" (ADR 0007) and nothing
//   more.
//
// The table must not be `WITHOUT ROWID`: the batch selects by `rowid`, and on such a table the
// DELETE fails with `no such column: rowid`, which stops cleanup. That is a longer retention,
// not a wrong answer, so it is logged as a failure and retried next hour.
import { TursoHttpTransport } from "../src/turso-http.ts";
import { RUNTIME_LIMITS } from "./limits.ts";

/** Days a keyed reply is retained. Longer retention is safe; shorter is not (see below). */
export const IDEMPOTENCY_RETENTION_DAYS = 30;
export const IDEMPOTENCY_RETENTION_SECONDS = IDEMPOTENCY_RETENTION_DAYS * 24 * 60 * 60;
/**
 * Rows one DELETE removes at most. The cleanup repeats the DELETE until one removes fewer than
 * this, so a large backlog never holds the write lock for long and a keyed write that waits on
 * it is delayed, not blocked for the whole run.
 */
export const IDEMPOTENCY_CLEANUP_BATCH_SIZE = 500;
/**
 * Batches one hourly run sends at most, so a runaway loop cannot run for the whole hour. It is
 * bounded by the Worker's `limits.subrequests` (three per batch: BEGIN, DELETE, COMMIT), and
 * 128 batches is 64,000 rows an hour, above what a 100 requests/minute rate limit can add in
 * the hour, so a steady-state run always drains completely; a larger backlog drains over
 * several runs.
 */
export const IDEMPOTENCY_CLEANUP_MAX_BATCHES = 128;

/**
 * The batch DELETE. `created_at` and `datetime('now')` are both the
 * database's clock and both truncate to whole seconds, so truncation can only delay a deletion;
 * it never advances one. The lookup core runs is never filtered by age.
 */
export const IDEMPOTENCY_CLEANUP_SQL =
  "DELETE FROM policysql_idempotency WHERE rowid IN (" +
  "SELECT rowid FROM policysql_idempotency " +
  "WHERE created_at < datetime('now', '-' || :retention_seconds || ' seconds') LIMIT :batch_size)";

/**
 * The table's columns, or no rows when the table does not exist. `PRAGMA table_info` never
 * fails for a missing table, so an absent table is a skip rather than a failure; a table
 * without `created_at` is a skip with a log line (an older deployment, created before this
 * wrapper's DDL and never rebuilt).
 */
export const IDEMPOTENCY_COLUMNS_SQL = 'PRAGMA table_info("policysql_idempotency")';

/** One statement, bound and read exactly as the wrapper's own transport returns it. */
export type CleanupRunner = (
  sql: string,
  args: Record<string, unknown>,
  mode: "read" | "write",
) => Promise<{ columns: string[]; rows: unknown[][]; rowsAffected: number }>;

export type CleanupResult = Readonly<{
  outcome: "deleted" | "nothing_to_delete" | "skipped" | "failed" | "not_configured";
  /** Rows the run deleted (0 for every other outcome). */
  deleted: number;
  /** DELETE statements the run sent. */
  batches: number;
  /** Why the run skipped or failed; absent otherwise. Never row contents or a key hash. */
  reason?: string;
}>;

export type CleanupOptions = Readonly<{
  retentionSeconds: number;
  batchSize: number;
  maxBatches: number;
  log: (event: Record<string, unknown>) => void;
}>;

/**
 * Deletes the rows older than the window. Never throws: a cleanup failure must not fail the
 * Cron Trigger, and the next run retries. The log line names the outcome and counts only.
 */
export const cleanupIdempotency = async (
  run: CleanupRunner,
  { retentionSeconds, batchSize, maxBatches, log }: CleanupOptions,
): Promise<CleanupResult> => {
  // Counted outside the try so a failure part-way reports what the run did delete.
  let deleted = 0;
  let batches = 0;
  const report = (result: CleanupResult) => {
    log({
      event: "idempotency_cleanup",
      outcome: result.outcome,
      deleted: result.deleted,
      batches: result.batches,
      retentionSeconds,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    });
    return result;
  };
  try {
    const table = await run(IDEMPOTENCY_COLUMNS_SQL, {}, "read");
    const nameIndex = table.columns.indexOf("name");
    if (table.rows.length === 0) return report({ outcome: "skipped", deleted: 0, batches: 0, reason: "no_table" });
    // A reply whose shape this build does not recognize is a failure, not a silent skip: the
    // columns are SQLite's own PRAGMA contract, and guessing could delete the wrong way.
    if (nameIndex < 0) return report({ outcome: "failed", deleted: 0, batches: 0, reason: "unreadable_columns" });
    if (!table.rows.some((row) => row[nameIndex] === "created_at")) {
      return report({ outcome: "skipped", deleted: 0, batches: 0, reason: "no_created_at" });
    }
    for (;;) {
      const result = await run(
        IDEMPOTENCY_CLEANUP_SQL,
        { retention_seconds: retentionSeconds, batch_size: batchSize },
        "write",
      );
      deleted += result.rowsAffected;
      batches += 1;
      if (result.rowsAffected < batchSize) {
        return report({ outcome: deleted === 0 ? "nothing_to_delete" : "deleted", deleted, batches });
      }
      if (batches >= maxBatches) {
        // Still a full batch after the cap: a backlog larger than one run's budget. The next
        // run continues; nothing is lost and the window only gets longer.
        return report({ outcome: "deleted", deleted, batches, reason: "batch_budget_exhausted" });
      }
    }
  } catch {
    // The failure is classified, never echoed: a database error can name tables and columns.
    return report({ outcome: "failed", deleted, batches, reason: "database_error" });
  }
};

/**
 * The runner the reference wrapper uses: the library's own Turso transport, with the
 * deployment's administrative credentials (never a client's). Each statement is its own short
 * transaction, so a batch DELETE commits on its own and a failed statement rolls back.
 */
export const transportCleanupRunner = (
  connection: Readonly<{ url: string; authToken: string }>,
  requestId: string,
): CleanupRunner => {
  const transport = new TursoHttpTransport(connection, requestId);
  return async (sql, args, mode) => {
    const transaction = await transport.begin(mode, 5_000, undefined, {
      maxBytesPerValue: RUNTIME_LIMITS.maxBytesPerValue,
    });
    try {
      const [result] = await transaction.execute([{ sql, args }], {
        maxResponseBytes: RUNTIME_LIMITS.maxResponseBytes,
      });
      await (mode === "write" ? transaction.commit() : transaction.rollback());
      return result;
    } catch (error) {
      await transaction.rollback().catch(() => { /* the failure is already terminal */ });
      throw error;
    }
  };
};

/** The env names the cleanup reads: the deployment's own administrative credentials. */
export type CleanupEnv = Readonly<{ TURSO_DATABASE_URL?: unknown; TURSO_AUTH_TOKEN?: unknown }>;

/**
 * The `scheduled` handler's body (ADR 0028): a missing credential is `not_configured` and deletes
 * nothing, and every other outcome comes from `cleanupIdempotency`, which never throws. `create`
 * is the runner factory; a test injects one instead of the deployment's transport.
 */
export const cleanupFromEnv = async (
  env: CleanupEnv,
  log: (event: Record<string, unknown>) => void,
  create: typeof transportCleanupRunner = transportCleanupRunner,
): Promise<CleanupResult> => {
  const options = {
    retentionSeconds: IDEMPOTENCY_RETENTION_SECONDS,
    batchSize: IDEMPOTENCY_CLEANUP_BATCH_SIZE,
    maxBatches: IDEMPOTENCY_CLEANUP_MAX_BATCHES,
    log,
  };
  const url = env.TURSO_DATABASE_URL;
  const authToken = env.TURSO_AUTH_TOKEN;
  if (typeof url !== "string" || !url || typeof authToken !== "string" || !authToken) {
    // The same empty values the library's configuration rejects. Nothing is deleted without
    // them, and this is reported the same way as every other outcome.
    const result = { outcome: "not_configured", deleted: 0, batches: 0 } as const;
    log({ event: "idempotency_cleanup", ...result });
    return result;
  }
  return cleanupIdempotency(create({ url, authToken }, "idempotency-cleanup"), options);
};
