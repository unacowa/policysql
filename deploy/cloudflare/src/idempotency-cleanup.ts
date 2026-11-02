// Idempotency record cleanup (ADR 0028). Part of the published engine: a fixed procedure over a
// caller-supplied statement runner, with no decision of its own beyond the outcomes the ADR
// defines.
//
// Keyed atomic writes store their committed reply in `policysql_idempotency` in the application
// database, in the same transaction as the mutation (ADR 0007, ADR 0024). Nothing in the library
// deletes those rows: the lookup of core's step machine is unfiltered by design (deleting a
// tombstone can only add executions, `crates/policysql-transaction/src/machine/step/atomic.rs`).
// A deployment deletes them administratively, outside the public endpoint, where the table is
// outside the catalog and default deny rejects it.
//
// The rules (ADR 0028; ADR 0026 sections 3, 4 and 6 without its public contract):
//
// - deletion is by age only (`created_at`, filled by the database's clock, never written by
//   core), in bounded batches by `rowid`;
// - nothing is deleted for a table that does not exist or has no `created_at` (ADR 0007 allows
//   a deployment that never uses keys to have no table);
// - the window is an argument, neither a setting nor something advertised: ADR 0026 section 5 is
//   not adopted, so the caller chooses the window and tells no client what it is.
//
// The table must not be `WITHOUT ROWID`: the batch selects by `rowid`, and on such a table the
// DELETE fails with `no such column: rowid`, which stops cleanup. That is a longer retention,
// not a wrong answer, so it is reported as a failure and retried next run.
//
// The transport is the caller's (ADR 0019): this module sends statements through `CleanupRunner`
// and knows no driver, no `env`, and no platform type. The reference wrapper supplies the runner
// over the library's Turso transport and owns the schedule; another deployment supplies its own.

/** Days a keyed reply is retained by the reference wrapper. Longer retention is safe; shorter is not. */
export const IDEMPOTENCY_RETENTION_DAYS = 30;
export const IDEMPOTENCY_RETENTION_SECONDS = IDEMPOTENCY_RETENTION_DAYS * 24 * 60 * 60;
/**
 * Rows one DELETE removes at most. The cleanup repeats the DELETE until one removes fewer than
 * this, so a large backlog never holds the write lock for long and a keyed write that waits on
 * it is delayed, not blocked for the whole run.
 */
export const IDEMPOTENCY_CLEANUP_BATCH_SIZE = 500;
/**
 * Batches one run sends at most, so a runaway loop cannot run for the whole hour. The reference
 * wrapper bounds it by its `limits.subrequests` (three per batch: BEGIN, DELETE, COMMIT), and
 * 128 batches is 64,000 rows an hour, above what a 100 requests/minute rate limit can add in
 * the hour, so a steady-state run always drains completely; a larger backlog drains over
 * several runs.
 */
export const IDEMPOTENCY_CLEANUP_MAX_BATCHES = 128;

/**
 * The batch DELETE. `created_at` and `datetime('now')` are both the database's clock and both
 * truncate to whole seconds, so truncation can only delay a deletion; it never advances one.
 * The lookup core runs is never filtered by age.
 */
export const IDEMPOTENCY_CLEANUP_SQL =
  "DELETE FROM policysql_idempotency WHERE rowid IN (" +
  "SELECT rowid FROM policysql_idempotency " +
  "WHERE created_at < datetime('now', '-' || :retention_seconds || ' seconds') LIMIT :batch_size)";

/**
 * The table's columns, or no rows when the table does not exist. `PRAGMA table_info` never
 * fails for a missing table, so an absent table is a skip rather than a failure; a table
 * without `created_at` is a skip with a log line (an older deployment, created before the
 * canonical DDL and never rebuilt).
 */
export const IDEMPOTENCY_COLUMNS_SQL = 'PRAGMA table_info("policysql_idempotency")';

/**
 * One statement, bound and read exactly as the caller's transport returns it. A runner is
 * expected to run each statement in its own short transaction, so a batch DELETE commits on its
 * own and a failed statement leaves nothing behind; that choice belongs to the caller.
 */
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
  /** The window the caller keeps rows for. The reference wrapper passes 30 days. */
  retentionSeconds: number;
  batchSize: number;
  maxBatches: number;
  log: (event: Record<string, unknown>) => void;
}>;

/**
 * Deletes the rows older than the window. Never throws: a cleanup failure must not fail the
 * scheduled run, and the next run retries. The log line names the outcome and counts only.
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
