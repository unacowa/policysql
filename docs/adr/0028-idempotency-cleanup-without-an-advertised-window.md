# ADR 0028: Cleanup of `policysql_idempotency` without an advertised window

- Status: accepted (maintainer decision of 2026-11-02: the narrow option, "A"); amended by the
  maintainer decision of the same day below ("Amendment: the procedure is published, the
  schedule is not")
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
(`deploy/cloudflare/src/idempotency-cleanup.ts` for the procedure,
`deploy/cloudflare/wrapper/idempotency-retention.ts` for the transport and credentials,
`wrapper/index.ts`, `wrangler.jsonc`, `scripts/provision-dev.mjs`, and the two example
`idempotency.sql` files).

- **Window: fixed, 30 days.** `IDEMPOTENCY_RETENTION_DAYS = 30`. It is a constant of the
  wrapper, not a setting, and it is **not advertised**. A client keeps the ADR 0007 promise it
  had: a replay "while retained", with no stated duration. The 30 days is long compared with
  any real retry (seconds to minutes), so in practice no retry a client makes loses its
  replay.
- **Mechanism: the proposed ADR 0026's sections 3, 4 and 6, unchanged.**
  `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP` filled by the database (core's `INSERT`
  names only its three columns, so no ABI bump and no snapshot change); the lookup stays
  unfiltered; deletion is by age only, in batches of 500 rows by `rowid`, repeated until a batch
  is short, capped at 128 batches per run; each batch is its own short write transaction (three
  subrequests: BEGIN, DELETE, COMMIT), so the cap fits `limits.subrequests` in
  `wrangler.jsonc`, which is raised to 400 for it (a test checks
  `3 x (cap + 1) <= subrequests`, the `+ 1` being the PRAGMA's own three); the table must not be
  `WITHOUT ROWID`. 128 batches is 64,000 rows an hour, above what the wrapper's 100
  requests/minute rate limit can add in the hour, so a steady-state run drains completely.
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

## Amendment: the procedure is published, the schedule is not

Maintainer decision of 2026-11-02, after this ADR was merged: keep the window unadvertised and
the deletion rule fixed, but put the **fixed procedure** in the published library and leave the
**periodic invocation** in the deployment, because only that half depends on infrastructure.

This replaces the "no library helper" part of the decision above. The rule it keeps is the one
the decision was about: the deletion logic is not copied per deployment, and the deployment
still decides when, where, and with whose credentials it runs.

- **Published (`deploy/cloudflare/src/idempotency-cleanup.ts`, exported from
  `package.ts`):** `cleanupIdempotency(run, options)` and the constants it needs —
  `IDEMPOTENCY_CLEANUP_SQL`, `IDEMPOTENCY_COLUMNS_SQL`, `IDEMPOTENCY_CLEANUP_BATCH_SIZE`,
  `IDEMPOTENCY_CLEANUP_MAX_BATCHES`, `IDEMPOTENCY_RETENTION_DAYS` /
  `IDEMPOTENCY_RETENTION_SECONDS` — plus the `CleanupRunner` port and the option and result
  types. It imports nothing: no driver, no `env`, no platform type. The runner is the caller's,
  and the section above's rule (each batch its own short transaction) is stated as the runner's
  obligation, not implemented here.
- **Not published (`deploy/cloudflare/wrapper/idempotency-retention.ts`):**
  `transportCleanupRunner`, which builds the library's Turso transport from the deployment's
  own credentials, and `cleanupFromEnv`, which reads `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`
  and reports `not_configured` when either is missing. With them stay the `scheduled` handler
  and the Cron Trigger, which are the deployment's by nature.
- **`retentionSeconds` stays an argument.** The procedure does not fix the window; the reference
  wrapper passes its 30-day constant. The window is a per-deployment decision (ADR 0019: the
  wrapper owns what only the deployment knows), and fixing it inside the procedure would make
  every deployment that wants another window copy the loop — the thing this amendment exists to
  prevent. `IDEMPOTENCY_RETENTION_SECONDS` is published as a documented default, not as
  the value every caller must use.
- **Still not advertised.** Nothing in `Capabilities`, `PolicySqlConfig`, or the request path
  changed: publishing the procedure adds no setting, no `null` value, no range validation, and
  no client rule, which is what separates it from ADR 0026's section 5 and its library helper.

What a deployment that is not the reference wrapper does: supply a `CleanupRunner` over its own
database driver (a function, as `test/idempotency-cleanup.test.mjs` does over `node:sqlite`),
choose its window and its schedule, and call `cleanupIdempotency`.

## The window an input-limit rule refers to

ADR 0007's #100 amendment, `docs/operations-runbook.md` and `docs/database-routing.md` tell an
operator who needs a keyed retry to replay that it must not lower an input limit
(`maxRequestBytes`, the body-side `maxJsonValues`) below a body accepted in the last `W`, the
idempotency retention window. Those passages were written against the proposed ADR 0026, whose
`W` was the advertised window; this ADR advertises none. The rule is unchanged, and its `W` is
now the window the deployment deletes by:

- **The reference wrapper's `W` is the fixed 30 days** (`IDEMPOTENCY_RETENTION_DAYS`), the same
  value its cleanup deletes by. An operator of that wrapper uses 30 days.
- **Any other deployment's `W` is the window it chooses and deletes by.** A deployment that runs
  no cleanup never deletes a row, so no window bounds it: lowering an input limit there loses the
  replay of every such body permanently.

The rule exists because a refused body never reaches the lookup: the row is still there, but the
retry cannot use it, and the answer is the unknown 500 rather than a replay.

## What this does not promise

- **No advertised window.** Nothing tells a client how long a reply is replayable: no property
  is added to `Capabilities`, and `spec/openapi.yaml` only gains a sentence on the
  `Idempotency-Key` parameter saying that a deployment may delete old rows and that no
  retention duration is advertised. A client that resends a keyed write more than 30 days after
  the first send finds no row and executes it again. That was already
  true of every duration: before this ADR the row would have been found only because nothing
  ever deleted it.
- **No configured setting, no client margin `M`.** The proposed ADR 0026's section 5 and its
  open questions 2, 3 and 5 stay open. It also does not adopt the library helper of open
  question 4; the procedure it publishes instead is narrower, and is described in the
  amendment above. If section 5 is later adopted, the migration order is "migrate, then
  advertise, then enable cleanup", and an advertised window shorter than this wrapper's 30 days
  would need the larger one kept until the old one has elapsed: a client that read a longer
  window must stay covered.
- **No deletion by size, by snapshot change, or by hand.** A size cap breaks whatever floor a
  client assumed, and a row stores only hashes, with no snapshot to delete by.

## Consequences

- Rows are bounded at roughly "keyed writes per second × 30 days"; the
  reference wrapper's rate limit is 100 requests/minute per client, so the ceiling is generous
  but finite, and `RETURNING` payloads no longer accumulate indefinitely.
- `policysql_idempotency` gains a column and an index; core's statements and the ABI are
  unchanged, so a deployment can migrate at any time.
- A deployment that already has the table without `created_at` keeps working with no cleanup
  until it is rebuilt, and the release smoke fails its shape check until then: a deployment
  whose table is not the canonical one fails the gate rather than passing quietly. (The
  development database already had the column; `provision-dev.mjs` keeps creating it with
  `CREATE TABLE IF NOT EXISTS` and now also creates the index.)
- The index is named `policysql_idempotency_created_at`, in the same namespace as the table.

## Alternatives

- **Adopt ADR 0026 in full (parts 2 and 3 as well).** Rejected for now by the maintainer's
  decision: it makes a required setting a breaking change and commits the library to an
  exported helper, for a benefit (clients know the window) that no current client asks for.
  Nothing here prevents adopting it later. (The amendment above publishes a narrower procedure
  that takes the window as an argument; it is not that helper.)
- **Bound storage by row count instead of age.** Rejected: it deletes
  rows inside whatever window a client would assume, so a committed write could execute twice
  sooner than any floor.
- **Delete on snapshot change.** Rejected: the row stores hashes only, with no snapshot to
  compare; and a retry that differs only in the snapshot replays since #80.
- **Leave it to operators (no scheduled cleanup).** Rejected: the default answer must be
  bounded retention for security-critical state; ADR 0007 already requires storage to be
  "bounded".
