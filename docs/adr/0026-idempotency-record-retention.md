# ADR 0026: Retention and deletion of `policysql_idempotency` rows

- Status: proposed
- Issues: #67
- Related: [ADR 0007](0007-transaction-retry-and-commit-check-protocol.md),
  [ADR 0014](0014-wrapper-provided-database-bindings.md),
  [ADR 0018](0018-wrapper-owned-rate-limiting.md),
  [ADR 0019](0019-library-layers-and-the-wrapper-boundary.md),
  [ADR 0021](0021-explicit-engine-config.md),
  [ADR 0024](0024-transaction-step-machine.md),
  [ADR 0025](0025-core-defined-canonical-json.md)

## Context

A keyed atomic write stores its committed reply in `policysql_idempotency` in the application
database, in the same database transaction as the mutation (ADR 0007, ADR 0024). Core owns
the two statements that touch the table
(`crates/policysql-transaction/src/machine/step/atomic.rs`):

```sql
SELECT fingerprint, response_json FROM policysql_idempotency WHERE key_hash = :key_hash
INSERT INTO policysql_idempotency (key_hash, fingerprint, response_json)
  VALUES (:key_hash, :fingerprint, :response_json)
```

The lookup has three outcomes: no row executes the request, a row with the same fingerprint
replays it, and a row with another fingerprint is `POLICYSQL_IDEMPOTENCY_CONFLICT`.

Nothing deletes these rows, and nothing says how long they are kept:

- ADR 0007 promises a replay "while retained" and requires that idempotency storage be
  "bounded ... and retained at least as long as advertised", but no window is advertised.
  Capabilities reports `idempotency.persistent: true` and nothing else
  (`deploy/cloudflare/src/presenters.ts`).
- Client guidance asks applications to persist the key and payload "while the record remains
  available" (`examples/database-routing/README.md`, `website/clients/kysely.md`), without a
  duration.
- `response_json` holds the full reply, including `RETURNING` rows. Unbounded retention keeps
  that data indefinitely (`docs/review-concerns/phase-4-transactions.md` lists retention and
  deletion as operational security requirements).
- The table has two shapes today. `examples/database-routing/idempotency.sql` and
  `examples/in-process/idempotency.sql` create `(key_hash, fingerprint, response_json)`. `deploy/cloudflare/scripts/provision-dev.mjs`
  creates the same three columns plus `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`.
  The library works with both, because its `INSERT` names only its three columns.

### Rows from an earlier snapshot are not dead

Issue #67 observes that the request fingerprint includes the database binding and thus the
runtime snapshot (ADR 0014, ADR 0025), so after a snapshot-changing deployment an earlier row
can never be *replayed*. It does not follow that such a row is unused. `keyHash` does not
include the snapshot, so a keyed retry that straddles the deployment still finds the row and
gets `POLICYSQL_IDEMPOTENCY_CONFLICT`. ADR 0025 relies on exactly this: "No committed keyed
request executes twice." (`deploy/cloudflare/test/abi-bump-retry.test.mjs` pins it.) Deleting
an earlier-snapshot row turns that conflict into a second execution of a committed write. A
row from an earlier snapshot is a tombstone for its key, and is exactly as important as a
current one until its retry window ends. (That the conflict is itself a false answer, because
the write committed, is a separate problem: [#80](https://github.com/unacowa/policysql/issues/80),
see section 2.)

Deleting by snapshot is also not implementable: the row stores only hashes, so nothing in it
tells which snapshot wrote it.

## Decision

### 1. Placement: the wrapper deletes, the library defines the contract

Applying ADR 0019's placement questions in order:

- **Deleting rows needs deployment knowledge.** It needs the set of databases (the wrapper's
  registry, ADR 0014; the library sees one binding per request and never enumerates databases),
  credentials to reach them outside any request, a scheduler (a platform feature, for example a
  Cloudflare Cron Trigger), and a retention period that trades client retry behavior against
  storage and data exposure, which only the deployment can weigh. Every one of these puts
  deletion, its schedule, and the choice of window in the **wrapper**.
- **The table's DDL is wrapper (provisioning) work.** The library never runs DDL (AGENTS.md);
  the table is already provisioned administratively (`idempotency.sql`, `provision-dev.mjs`).
- **The library owns the meaning.** Core owns the lookup and insert statements and the replay
  rules. The library therefore defines the table contract (which columns it writes and reads,
  which columns it tolerates), the client-facing guarantee in terms of a retention window, and
  how that window is advertised. It may ship the fixed SQL text for these tasks (section 5),
  but it does not run it, schedule it, or verify deletion.

This is an instance of the wrapper rule, like ADR 0014 (database registration) and ADR 0018
(rate limiting). The library cannot verify that a wrapper honors its advertised window, just as
it cannot verify that a database identity is never reused; both are wrapper obligations.

### 2. The retention contract

A deployment chooses a **retention window** `W` (seconds) per deployment, the same for every
database it serves.

**Wrapper obligation.** A row may be deleted only when its `created_at` is more than `W`
seconds before the database's current time, where `W` is the window the deployment advertises
(section 5; a deployment that advertises none deletes nothing). Rows may be kept longer; nothing else may delete
them (not a size cap, not a snapshot change, not manual cleanup).

**Client-facing guarantee.** For a keyed atomic write, let `t0` be the instant the client first
sent it. A retry with the same key, authenticated context, endpoint, database binding (which
includes `generation` and the runtime `snapshot`, ADR 0014), and payload, whose idempotency
lookup runs within `W` of `t0`, where `W` is the window the deployment advertised at `t0`
(section 5 keeps that window honored when it is later lowered), is answered from the row when
the original committed: it is
replayed, and the write never executes a second time. A retry with the same key but another
payload or another `generation` gets `POLICYSQL_IDEMPOTENCY_CONFLICT`, as today. If the
original did not commit, no row exists and the retry executes, as today.

**Known limitation: retries across a snapshot change.** A retry that differs from the original
only in the runtime snapshot, because a snapshot-changing deployment happened in between, is
outside the guarantee above, since its binding is not the same. Today it gets
`POLICYSQL_IDEMPOTENCY_CONFLICT`, which the client takes as a definite rejection although the
write committed: a false conflict (ADR 0024), on every snapshot-changing deployment. It never
executes twice while the row exists, which is why section 4 forbids deleting by snapshot.
Fixing the false conflict (for example by removing `snapshot` from the request fingerprint
while keeping `generation`) is out of scope here and tracked in
[#80](https://github.com/unacowa/policysql/issues/80).

Why the guarantee holds, on one clock (the database's):

- Let `ti` be the database time at which the original's `INSERT` ran, and `tc` the database
  time of a cleanup `DELETE`. `CURRENT_TIMESTAMP` and `datetime('now')` both truncate to whole
  seconds; the delete condition `floor(ti) < floor(tc) - W` implies `tc - ti > W`, so truncation
  can only delay a deletion, never advance it.
- The `INSERT` runs in real time after `t0` (after the client sent the request, and after any
  commit checks, ADR 0024 step 5), so a deletion happens more than `W` after `t0`. A lookup
  within `W` of `t0` cannot follow it. The client never compares its clock with the database's;
  it measures elapsed time only.
- On Turso both `INSERT` and `DELETE` are writes evaluated on the primary, so they read the
  same clock. The remaining assumption is that this clock does not jump forward by more than the
  client margin `M` (an NTP step, or skew between the old and new primary on a failover); `M`
  absorbs it.
- A concurrent cleanup cannot make a lookup wrong: cleanup only removes rows, and the reference
  transport opens writes with `BEGIN IMMEDIATE`, so the keyed transaction and a cleanup
  serialize. A lookup that sees the row replays the committed reply; one that does not see it ran
  after a deletion that was already allowed.

**Client rule.** The client measures only elapsed time on its own clock: a keyed write may be
resent while `elapsed since first send < W - M`. The margin `M` covers how long one request can
take to reach its lookup (the engine's deadlines are seconds: `transactionMs` is 4 s in the
reference wrapper), drift, and forward steps of the database clock. After that the outcome must
be resolved another way (by reading the data), never by resending.

**After the window.** A retry whose row was deleted finds no row and **executes as a new
request**. Under ADR 0007 this is not a violation: ADR 0007 promises replay "while retained",
and this ADR defines "retained" as the window `W`. It is, however, the case in which a
committed write can run twice, so the guarantee above is the only one clients may rely on, and
the client rule exists to stay inside it. A retry after the window that happens to find a
not-yet-deleted row is still replayed or rejected as a conflict; the library never ignores a
row because of its age, because ignoring an existing tombstone can only add executions.

### 3. Expiry is a `created_at` column filled by the database

- **`created_at`, not `expires_at`.** `expires_at` would bake the window into every row at
  insert time, so the inserting code (core) would have to know `W`, and shortening or lengthening
  `W` would not apply to existing rows. With `created_at`, `W` is a parameter of the cleanup
  alone and changes take effect for every row at the next cleanup.
- **The database fills it.** The column is
  `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP` (UTC, `YYYY-MM-DD HH:MM:SS`, the format
  `provision-dev.mjs` already uses). Core's `INSERT` keeps naming only its three columns and
  never writes `created_at`. Consequences:
  - insert time and the cleanup's "now" come from the same clock (the database's), so Worker
    and owner clocks, and their skew against the database, do not matter;
  - core needs no time input and no change: no ABI bump, no snapshot change, so no keyed retry
    straddling the rollout gets a false conflict (ADR 0024, ADR 0025);
  - a table without the column keeps working for the library unchanged.
- **The lookup stays unfiltered.** Core does not add `created_at` to the lookup (section 2).

### 4. Deletion: by age only, in bounded batches, outside the public endpoint

The only deletion rule is age. The cleanup statement, run with the wrapper's own administrative
credentials (never through the public PolicySQL endpoint, where the table is outside the catalog
and default deny rejects it):

```sql
DELETE FROM policysql_idempotency
WHERE rowid IN (
  SELECT rowid FROM policysql_idempotency
  WHERE created_at < datetime('now', '-' || :retention_seconds || ' seconds')
  LIMIT :batch_size
)
```

repeated until it deletes fewer than `batch_size` rows, so one cleanup never holds the write
lock for a long time and a busy database delays, but does not block, keyed writes. A keyed write
that waits on the cleanup's lock and times out gets a database timeout or unavailable code,
which the client never takes as a definite rejection.

- **Schedule.** Periodic, chosen by the wrapper. The reference wrapper runs it from a
  Cloudflare Cron Trigger (`scheduled` handler, `triggers.crons` in `wrangler.jsonc`) once an
  hour, over every database in its registry. A missed run only delays deletion; it never
  shortens the window.
- **Not on snapshot change.** Rejected; see "Rows from an earlier snapshot are not dead".
- **Not by size.** Deleting the oldest rows to cap size breaks the advertised minimum. A
  deployment that must bound storage bounds it through the window and its request-rate limits
  (ADR 0018): rows are at most "keyed writes per second x `W`". A deployment that cannot afford
  that advertises a shorter `W`.
- **Missing table or missing column.** The cleanup is a no-op for a database without the table
  (deployments that never use keys need no table, ADR 0007). It skips, and logs, a table
  without `created_at`; such a database must be migrated (section 6) before cleanup is enabled
  for it.

### 5. Advertising the window

- `PolicySqlConfig` (ADR 0021) gains `idempotencyRetentionSeconds: number | null`, **required**
  (a breaking change, allowed in beta; pending maintainer confirmation, open question 5), so no
  deployment advertises "no window" by omission. A number must be an integer within
  `[3600, 31_536_000]` (one hour to one year), validated at construction like every other
  setting.
- Capabilities `idempotency` gains `retentionSeconds`: the configured value. `spec/openapi.yaml`
  gives `idempotency` this property (`integer` with the bounds above, or `null`).
- **`null` means "no window is advertised"**, not "rows are kept forever": clients must not rely
  on unbounded retention, and the only resend of a keyed write they may rely on is one inside a
  window they were told. A wrapper that advertises `null` has no window to delete by, so it runs
  no cleanup.
- **One source for both windows.** The window the wrapper deletes by is derived from the same
  configuration value it passes as `idempotencyRetentionSeconds`: the cleanup helper (below)
  takes `retentionSeconds` from that value, so the advertised and the enforced window cannot
  drift apart.
- Documentation (`docs/http-api.md`, `website/api/execute.md`, `website/clients/kysely.md`,
  `examples/database-routing/README.md`) replaces "while the record remains available" with the
  guarantee and client rule of section 2, naming `retentionSeconds`.

The value is advisory data from the wrapper, like `commitChecksConfigured`; changing it does
not change the snapshot. A wrapper that lowers a numeric `W` must keep deleting by the larger
of the old and new windows until the old one has elapsed, so a client that read the old value is
still covered. A client therefore relies on the value it read when it first sent the write,
not on a later one; the opt-in client enforcement (follow-up 4) persists that
`retentionSeconds` together with `firstSentAt`, so a client holding an old `W` stays safe after
`W` is lowered. Moving from `null` to a number is not a lowering (nothing was advertised); it
follows the ordering rule of section 6.

**Library helper (pending maintainer confirmation, open question 4).** The library exports
decision-free text: `idempotencyCleanupStatements({ retentionSeconds, batchSize })`, which
returns the parameterized `DELETE` of section 4 with its arguments, and constants for the
canonical DDL and the rebuild statements of section 6. It takes the configured value as is:
`retentionSeconds: null` returns no statements (no window advertised, so nothing may be
deleted), and it throws only for a type or range error (a `retentionSeconds` that is not `null`
or an integer within the config bounds, or a `batchSize` that is not a positive integer). Like an adapter (ADR 0019), it is fixed
translation with no decision: the wrapper still chooses the window, the schedule, the databases,
and the credentials, and runs the statements itself. Wrappers then do not copy SQL whose
correctness the guarantee depends on.

### 6. Schema and DDL

The canonical DDL, applied administratively by the wrapper or its provisioning:

```sql
CREATE TABLE policysql_idempotency (
  key_hash TEXT PRIMARY KEY NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX policysql_idempotency_created_at ON policysql_idempotency (created_at);
```

The table contract: core reads `fingerprint` and `response_json` by `key_hash` and inserts those
three columns; `created_at` is filled by its default; `key_hash` is unique. The table **must not
be `WITHOUT ROWID`**: the cleanup selects its batch by `rowid`, and on a `WITHOUT ROWID` table it
fails with `no such column: rowid`, so cleanup would stop and rows would outlive the window
unnoticed (longer retention is not a contract violation, but it breaks the storage bound of
section 4).

**Existing tables.** SQLite rejects `ALTER TABLE ... ADD COLUMN` with a `CURRENT_TIMESTAMP`
default on a table that has rows ("Cannot add a column with non-constant default"; checked on
SQLite 3.53), and a constant default would give every future row the same timestamp. A table
without `created_at` is therefore rebuilt, and the rebuild **must run as one explicit write
transaction**:

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

A transaction alone is not enough: **the rebuild must stop at the first failed statement and
roll back, and must never send `COMMIT` after a failed statement.** SQLite does not abort a
transaction when one statement in it fails. Run statement by statement, the script above with a
failing copy (`INSERT ... SELECT`) still executes the `DROP` and `RENAME`, and its `COMMIT`
commits an empty `policysql_idempotency`: every tombstone is gone, and every keyed retry can then
execute a committed write a second time (verified on SQLite 3.53.2). The same happens with
`@tursodatabase/serverless`'s `connection.batch(statements)` without a mode when the statements
include literal `BEGIN`/`COMMIT`, because such a batch runs each statement on its own and does
not stop at an error. Therefore:

- **`@tursodatabase/serverless`:** send the statements between `BEGIN IMMEDIATE` and `COMMIT`
  (not those two) as `connection.batch(statements, "write")`. The driver opens the transaction,
  stops at the first error, and rolls back (`provision-dev.mjs` already passes `"write"`).
- **Any other client** (a driver, a shell, an admin console): execute the statements one by one,
  stop at the first error, and send `ROLLBACK` instead of the remaining statements and `COMMIT`
  (in the `sqlite3` shell, `.bail on` with the script stops, and the open transaction is
  discarded when the connection closes without `COMMIT`). Send `COMMIT` only after every
  statement succeeded.

The copy and the `DROP` being in one transaction that commits only on full success is what
keeps the rebuild safe: otherwise a failure between `DROP` and `RENAME`, or a failed copy
followed by a `COMMIT`, loses every tombstone (keyed retries could then execute twice), and a
keyed write that commits between the copy and the `DROP` loses its row.

Every existing row gets the migration time as `created_at`, so it is kept for a full window
from the migration: never shorter than the guarantee, at worst one window longer. Keyed writes
that arrive during the rebuild wait on its lock or fail with a database timeout or unavailable
code (never a rejection); one that committed before the rebuild took its lock is copied, and one
that waited commits into the rebuilt table, so either replays on retry.

**Compatibility and ordering.** Core's statements do not change, so the library works with both
shapes and the migration can happen at any time, independently of a library release. The
wrapper's ordering rule is: **migrate, then advertise `retentionSeconds`, then enable cleanup.**
Advertising a window before deleting is harmless (rows may be kept longer); deleting while
`null` or a larger window is advertised is not.

### 7. Scope

This ADR covers `policysql_idempotency` only. Keyed interactive starts and the terminal
interactive records ADR 0007 calls "queryable ... during retention" live in transaction-owner
storage (Durable Objects in the reference wrapper), not in the application database, and are
not changed here. The false conflict for retries across a snapshot change is
[#80](https://github.com/unacowa/policysql/issues/80).

## Follow-up pull requests

Each ships on its own; none changes core or the ABI.

1. **Schema and documentation.** `examples/database-routing/idempotency.sql` and
   `examples/in-process/idempotency.sql` get the canonical DDL; the rebuild script (with
   `BEGIN IMMEDIATE ... COMMIT` and the stop-at-first-error and `ROLLBACK` instructions of
   section 6) ships as a separate, documented file. `provision-dev.mjs`
   creates the index and rebuilds an existing table that lacks `created_at` (in its `"write"`
   batch). Documentation of section 5. Tests: core's `INSERT_SQL` and `LOOKUP_SQL` never name
   `created_at` (pins section 3); the atomic differential harness
   (`step-atomic-differential.test.mjs`) runs its keyed cases against both table shapes; the
   rebuild keeps every row and its replay (a keyed retry before and after the rebuild replays
   the same reply); a rebuild whose copy step fails (and one that fails at any later step)
   leaves the original table and all its rows intact and commits nothing, both statement by
   statement with stop-at-first-error and through the serverless driver's `"write"` batch; a
   keyed write interleaved with the rebuild (one that commits just before
   the rebuild takes its lock, and one that waits on that lock) still replays after the
   rebuild.
2. **Config, Capabilities, and the helper.** `idempotencyRetentionSeconds: number | null`,
   required, in `PolicySqlConfig` (validation and `ConfigError` tests for absence, bounds, and
   type), `idempotency.retentionSeconds` in Capabilities, `spec/openapi.yaml`, the HTTP
   conformance suite, and `idempotencyCleanupStatements` with the DDL and rebuild constants
   (tests: the statements are exactly those of sections 4 and 6, parameters are bound, not
   interpolated, `retentionSeconds: null` returns no statements, and only a type or range error
   in `retentionSeconds` or `batchSize` throws). The in-process example
   has no scheduler: it configures `null` and runs no cleanup.
3. **Reference wrapper cleanup.** A `scheduled` handler in `deploy/cloudflare/wrapper/` with an
   hourly Cron Trigger, and the same in `examples/database-routing/worker.ts` over both tenant
   databases, both calling the helper with the configured window. Tests (node:sqlite): only rows
   older than `W` are deleted; a row exactly at the boundary is kept; batching terminates and
   bounds each statement; a missing table is a no-op; a table without `created_at` is skipped
   and logged; a `WITHOUT ROWID` table is reported, not silently skipped; with `null`
   configured no cleanup runs; a keyed retry within `W` replays after a cleanup ran; a keyed
   retry whose row was deleted executes again (pins the documented post-window behavior); an
   earlier-snapshot row younger than `W` survives cleanup and still yields
   `POLICYSQL_IDEMPOTENCY_CONFLICT` (bypass regression for snapshot-based deletion). Real smoke
   (`provision-dev.mjs`, then the deployed dev Worker): a keyed write creates a row with
   `created_at`; a second row is back-dated administratively; triggering the scheduled handler
   (`wrangler dev --test-scheduled` locally, then the deployed cron) deletes only the
   back-dated row; a retry of the fresh write still replays.
4. **Client guidance.** Documentation first (section 2's client rule). Enforcement in the client
   library is opt-in only: when the application passes `firstSentAt` for a persisted keyed
   operation, the client persists the `retentionSeconds` it read at that first send together with
   `firstSentAt`, and refuses to resend past that `W - M`, raising an
   error that says the outcome must be resolved by reading.

## Consequences

- ADR 0007's "retained at least as long as advertised" becomes concrete: the window is
  advertised in Capabilities, and the guarantee is stated in terms of it.
- A committed keyed write can execute twice only when its retry arrives after the window,
  which the documented client rule excludes. Within the window it never executes twice,
  including across snapshot changes, where it currently gets a false conflict instead (#80).
- Stored replies, including `RETURNING` data, live for a bounded time.
- Core, the ABI, and the snapshot are unchanged; the library gains one required config setting,
  one Capabilities field, and a decision-free SQL helper.
- Deployments that never delete rows keep today's behavior and advertise `null`.

## Rejected alternatives

- **The library deletes rows** (for example an engine operation, or deleting expired rows
  inside each keyed transaction). The library would need the window, a clock decision, and, for
  scheduled deletion, the database registry; per-request deletion also adds write work to every
  keyed request and touches rows of other principals in the caller's transaction.
- **`expires_at` written by core.** Needs time and the window in core, an ABI bump (a snapshot
  change and false conflicts for straddling retries), a column the library would then require,
  and makes window changes non-retroactive.
- **Ignoring rows older than `W` in the lookup.** Can only turn a replay or conflict into a
  second execution; it buys determinism at the cost of the guarantee.
- **Deleting on snapshot change.** Removes the tombstones that keep cross-snapshot retries from
  executing twice, and the row does not record its snapshot.
- **Size-based deletion.** Breaks the advertised minimum.
- **A trigger that sets `created_at`.** Avoids the table rebuild but adds a trigger to the
  application database, which PolicySQL otherwise avoids; the rebuild is a one-time cost.
- **`null` meaning "rows are never deleted".** Moving from it to any window would be a lowering
  from infinity, which the lowering rule of section 5 cannot honor.

## Open questions for the maintainer

The proposed answers below are the review's recommendations, **pending maintainer
confirmation**; the decision sections above already assume them.

1. **Reference window and range.** Proposed: the reference wrapper uses `W = 86_400` (24 h), and
   config accepts `[3600, 31_536_000]`.
2. **Client margin `M`.** Proposed: a fixed `M = 300` seconds, covering request deadlines,
   drift, and forward steps of the database clock (NTP steps, primary failover skew).
3. **Client enforcement.** Proposed: documentation first; enforcement in the client only as an
   opt-in when the application passes `firstSentAt` (follow-up 4).
4. **Library helper.** Proposed: export `idempotencyCleanupStatements({ retentionSeconds,
   batchSize })` and the canonical DDL and rebuild constants, and derive the advertised and the
   enforced window from the same configuration value.
5. **Required window.** Proposed: `idempotencyRetentionSeconds` is required as
   `number | null`.
6. **Earlier-snapshot conflicts.** Moved to [#80](https://github.com/unacowa/policysql/issues/80)
   (out of scope here).
