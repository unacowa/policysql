# ADR 0028: Cleanup of `policysql_idempotency` without an advertised window

- Status: accepted (maintainer decision of 2026-11-02: the narrow option, "A")
- Issues: #67
- Supersedes in part: ADR 0026, "Retention and deletion of `policysql_idempotency` rows"
  (proposed, [PR #79](https://github.com/unacowa/policysql/pull/79); its sections 3, 4 and 6
  are adopted here, its section 5 is not). That ADR is not on `main`, so this document states
  everything it relies on itself.
- Related: [ADR 0007](0007-transaction-retry-and-commit-check-protocol.md),
  [ADR 0014](0014-wrapper-provided-database-bindings.md),
  [ADR 0018](0018-wrapper-owned-rate-limiting.md),
  [ADR 0019](0019-library-layers-and-the-wrapper-boundary.md),
  [ADR 0021](0021-explicit-engine-config.md),
  [ADR 0024](0024-transaction-step-machine.md)

## Context

A keyed atomic write stores its committed reply in `policysql_idempotency` in the application
database, in the same transaction as the mutation (ADR 0007, ADR 0024). `response_json` holds
the whole reply, including `RETURNING` rows, whose size is bounded only by `maxResponseBytes`
(129,536 bytes in the reference wrapper). Nothing deleted these rows, and ADR 0007 only
promises a replay "while retained" without saying how long that is.

The proposed ADR 0026 (not on `main`) designs the fix in full. It has three parts that are
easy to separate:

1. **The mechanism** (sections 3, 4, 6): a `created_at` column the database fills, an age-only
   batch `DELETE` by `rowid`, a Cron Trigger, and the canonical DDL and rebuild.
2. **The public contract** (section 5): a required `idempotencyRetentionSeconds` setting, the
   advertised `idempotency.retentionSeconds` in Capabilities, and the client rule
   `elapsed since first send < W - M`.
3. **The library helper** (section 5, open question 4): exported
   `idempotencyCleanupStatements(...)` in the published library.

The maintainer held the whole of ADR 0026 (PR #79, "保存期間 W は、ひとまず現状から変更しない"
— do not change the retention window for now). The concern behind the hold is the one the
mechanism answers: rows keep growing. Parts 2 and 3 are what makes the answer a breaking
change (a required setting) and a library-surface decision, and neither is needed to stop the
growth.

## Decision

Adopt **part 1 only**, in the reference wrapper
(`deploy/cloudflare/wrapper/idempotency-retention.ts`, `wrapper/index.ts`,
`wrangler.jsonc`, `scripts/provision-dev.mjs`, and the two example `idempotency.sql` files).

- **Window: fixed, 30 days.** `IDEMPOTENCY_RETENTION_DAYS = 30`. It is a constant of the
  wrapper, not a setting, and it is **not advertised**. A client keeps the ADR 0007 promise it
  had: a replay "while retained", with no stated duration. The 30 days is long compared with
  any real retry (seconds to minutes), so in practice no retry a client makes loses its
  replay.
- **Mechanism: ADR 0026 sections 3, 4 and 6, unchanged.** `created_at TEXT NOT NULL DEFAULT
  CURRENT_TIMESTAMP` filled by the database (core's `INSERT` names only its three columns, so
  no ABI bump and no snapshot change); the lookup stays unfiltered; deletion is by age only, in
  batches of 500 rows by `rowid`, repeated until a batch is short, capped at 128 batches per
  run; each batch is its own short write transaction (three subrequests: BEGIN, DELETE,
  COMMIT), so the cap fits `limits.subrequests` in `wrangler.jsonc`, which is raised to 400 for
  it (a test checks `3 x (cap + 1) <= subrequests`, the `+ 1` being the PRAGMA's own three); the
  table must not be `WITHOUT ROWID`.
  128 batches is 64,000 rows an hour, above what the wrapper's 100 requests/minute rate limit
  can add in the hour, so a steady-state run drains completely.
- **Schedule:** a Cloudflare Cron Trigger, hourly (`"17 * * * *"`), running the wrapper's
  `scheduled` handler. It uses the deployment's own `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`,
  never a client's, and never the public endpoint (where the table is outside the catalog and
  default deny rejects it).
- **Failure handling:** the run never throws. A missing table or a table without `created_at`
  is a skip (`no_table`, `no_created_at`); a database error is `failed` with the classification
  only (`database_error`), never the error text, which can name tables and columns; an
  unrecognized `PRAGMA` reply is `failed`, never a guess. The log line is
  `idempotency_cleanup` with `outcome`, `deleted`, `batches`, `retentionSeconds` and an optional
  `reason`. A missed run only delays a deletion.
- **DDL:** the canonical shape in both examples and in `provision-dev.mjs`, plus
  `CREATE INDEX policysql_idempotency_created_at`. The shape is:

  ```sql
  CREATE TABLE policysql_idempotency (
    key_hash TEXT PRIMARY KEY NOT NULL,
    fingerprint TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX policysql_idempotency_created_at ON policysql_idempotency (created_at);
  ```

  Existing deployments must rebuild the table to add the column: SQLite refuses
  `ALTER TABLE ... ADD COLUMN` with a `CURRENT_TIMESTAMP` default on a table that has rows,
  and a constant default would give every future row one timestamp. The statements are:

  ```sql
  BEGIN IMMEDIATE;
  CREATE TABLE policysql_idempotency_next (
    key_hash TEXT PRIMARY KEY NOT NULL,
    fingerprint TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO policysql_idempotency_next (key_hash, fingerprint, response_json)
    SELECT key_hash, fingerprint, response_json FROM policysql_idempotency;
  DROP TABLE policysql_idempotency;
  ALTER TABLE policysql_idempotency_next RENAME TO policysql_idempotency;
  CREATE INDEX policysql_idempotency_created_at ON policysql_idempotency (created_at);
  COMMIT;
  ```

  The rebuild must stop at the first failed statement and send `ROLLBACK` instead of `COMMIT`.
  SQLite does not abort a transaction when a statement inside it fails: run statement by
  statement, a failing `INSERT ... SELECT` still lets the `DROP` and `RENAME` run, and the
  `COMMIT` then commits an empty `policysql_idempotency`, so every tombstone is gone and every
  keyed retry can execute a committed write a second time. A driver's batch mode has the same
  hazard unless it opens one transaction and stops at the first error. Every existing row gets
  the migration time as `created_at`, so it is kept for a full window from the migration.

  Until the rebuild, the cleanup skips that table (`no_created_at`): the library keeps working
  and nothing is deleted.
- **Release smoke:** a new section (`scripts/smoke-retention.mjs`) checks against the real
  database that the table has the canonical shape and is not `WITHOUT ROWID`, that one cleanup
  run deletes a row older than the window while keeping a fresh one in the same run, and that
  the deployed Worker reports a Cron Trigger through the Cloudflare API. The probe rows use a
  `smoke_retention_` key prefix no client can produce and are removed afterwards.

## What this does not promise

- **No advertised window.** Nothing tells a client how long a reply is replayable, and
  `spec/openapi.yaml` and `Capabilities` are unchanged. A client that resends a keyed write
  more than 30 days after the first send finds no row and executes it again. That was already
  true of every duration: before this ADR the row would have been found only because nothing
  ever deleted it.
- **No configured setting, no client margin `M`, no library helper.** ADR 0026 section 5 and
  open questions 4 and 5 stay open. If they are later adopted, the migration order of ADR 0026
  section 6 applies to this wrapper too ("migrate, then advertise, then enable cleanup"), and
  the value it advertises must cover this wrapper's existing rows: the ordering rule means a
  deployment cannot advertise a window shorter than the one it was already deleting by without
  keeping the larger one until the old one has elapsed.
- **No deletion by size, by snapshot change, or by hand.** A size cap breaks whatever floor a
  client assumed, and a row stores only hashes, with no snapshot to delete by.

## Consequences

- Rows are bounded at roughly "keyed writes per second × 30 days"; the
  reference wrapper's rate limit is 100 requests/minute per client, so the ceiling is generous
  but finite, and `RETURNING` payloads no longer accumulate indefinitely.
- `policysql_idempotency` gains a column and an index; core's statements and the ABI are
  unchanged, so a deployment can migrate at any time.
- A deployment that already has the table without `created_at` keeps working with no cleanup
  until it is rebuilt; the smoke's shape check fails for the development deployment until
  `provision-dev.mjs` recreates it, which it does with `CREATE TABLE IF NOT EXISTS`. An
  existing development table must be rebuilt once.
- The index is named `policysql_idempotency_created_at`, in the same namespace as the table.

## Alternatives

- **Adopt ADR 0026 in full (part 2 and 3 as well).** Rejected for now by the maintainer's
  decision: it makes a required setting a breaking change and commits the library to an
  exported helper, for a benefit (clients know the window) that no current client asks for.
  Nothing here prevents adopting it later.
- **Bound storage by row count instead of age.** Rejected: it deletes
  rows inside whatever window a client would assume, so a committed write could execute twice
  sooner than any floor.
- **Delete on snapshot change.** Rejected: the row stores hashes only, with no snapshot to
  compare; and a retry that differs only in the snapshot replays since #80.
- **Leave it to operators (no scheduled cleanup).** Rejected: the default answer must be
  bounded retention for security-critical state; ADR 0007 already requires storage to be
  "bounded".
