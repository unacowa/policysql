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

Issue #67 observed that the request fingerprint includes the database binding and thus the
runtime snapshot (ADR 0014, ADR 0025), so after a snapshot-changing deployment an earlier row
could never be *replayed*. That premise no longer holds: #80 (PR #84) removed `snapshot` from
the request fingerprint while keeping `generation`, so a retry that differs from the original
only in the runtime snapshot now finds the same row and replays the committed reply, provided
the body still compiles and is authorized under the new deployment (otherwise the #85 rule
answers the unknown 500, ADR 0007). A row written before a deployment is therefore live in the
ordinary way: a snapshot-only retry replays rather than conflicting. It does not follow that
such a row may be deleted when the snapshot changes. The fingerprint still keeps `version`,
`scope`, `databaseId`, and `generation`, so a keyed retry with another payload or another
`generation` still finds the row and gets `POLICYSQL_IDEMPOTENCY_CONFLICT`. ADR 0025 relies
on exactly this: "No committed keyed request executes twice."
(`deploy/cloudflare/test/abi-bump-retry.test.mjs` pins it.)
Deleting a row turns that conflict into a second execution of a committed write. A row from
an earlier snapshot is a tombstone for its key, and is exactly as important as a current one
until its retry window ends.

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

The split itself follows from ADR 0019 and is proposed as the answer to #67 question (a). Its
library-side deliverables are still proposed pending maintainer confirmation: the fixed SQL
text (`idempotencyCleanupStatements`, open question 4) and the required configured window
(open question 5). The deletion and DDL rules of sections 4 and 6 follow from the split
regardless, but the helper and the configuration setting are what those two questions confirm.

### 2. The retention contract

A deployment chooses a **retention window** `W` (seconds) per deployment, the same for every
database it serves.

**Wrapper obligation.** A row may be deleted only when its `created_at` is more than `W`
seconds before the database's current time, where `W` is the window the deployment advertises
(section 5; a deployment that advertises none deletes nothing). Rows may be kept longer; nothing else may delete
them (not a size cap, not a snapshot change, not manual cleanup).

**Client-facing guarantee** (proposed; open question 5 confirms the required
`idempotencyRetentionSeconds`, so no deployment can leave this window unadvertised). For a
keyed atomic write, let `t0` be the instant the client first sent it. A retry with the same
key, authenticated context, endpoint, database binding (which includes `generation` but not
the deployment `snapshot`, #80; ADR 0014), and payload, whose idempotency
lookup runs within `W` of `t0`, where `W` is the window the deployment advertised at `t0`
(section 5 keeps that window honored when it is later lowered), is answered from the row when
the original committed: it is
replayed, and the write never executes a second time. A retry that differs only in the runtime
snapshot, because a snapshot-changing deployment happened in between, is inside this guarantee
and replays (#80), provided the body still compiles and is authorized under the new deployment
(otherwise the #85 rule answers the unknown 500, ADR 0007). A retry with the same key but another
payload or another `generation` gets `POLICYSQL_IDEMPOTENCY_CONFLICT`, as today. A request
whose binding names another snapshot than the runtime's is `POLICYSQL_STALE_OPERATION` before
the lookup, as today. If the original did not commit, no row exists and the retry executes, as
today.

**Snapshot changes (the former limitation, closed by #80).** The draft of this ADR recorded
that a retry which differed from the original only in the runtime snapshot was outside the
guarantee and got `POLICYSQL_IDEMPOTENCY_CONFLICT`, a definite rejection although the write
committed: a false conflict (ADR 0024). [#80](https://github.com/unacowa/policysql/issues/80)
removed `snapshot` from the request fingerprint while keeping `generation` (PR #84), so a
snapshot-only difference now replays, as the guarantee above states. Retention does not reopen
the conflict, and two facts keep the deletion rule of section 4 unchanged: a row whose
fingerprint mismatches is still a tombstone for a changed payload or generation, and deletion
by snapshot is still unimplementable because the row stores only hashes and no snapshot.

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
reference wrapper, `deploy/cloudflare/wrapper/limits.ts`), drift, and forward steps of the
database clock. After that the outcome must
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
    straddling the rollout is affected by it (ADR 0024, ADR 0025);
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

**Lowering an input limit.** The replay contract also depends on the body being accepted at
retry time. Since #100 the body-side limits are checked before the compile and the idempotency
lookup, and a keyed atomic execute whose body is refused by `maxRequestBytes` or the body-side
`maxJsonValues` is answered 500 `POLICYSQL_INTERNAL`, the unknown outcome (ADR 0007, #100
amendment), never a definite rejection. A deployment that lowers either limit below a body it
accepted within the last `W` therefore turns that write's retry into an unknown outcome for the
rest of the window, although its row is still present: the lookup is never reached, so the
replay the guarantee promises is lost and the caller cannot tell whether the write committed.
Lowering a limit is not a correctness migration, because no retry becomes a definite rejection,
but a deployment that must honor replays within its advertised `W` **must not lower an input
limit below a body accepted in the last `W`** — `maxRequestBytes`, the body-side
`maxJsonValues`, or the depth limit tightened in ABI 16; if it does, it stops honoring that
window for those bodies. The depth limit is the one input limit no window can preserve: a
depth-65 body is refused before the lookup under every current build, so unlike the other two
its lowering cannot be honored even by keeping the larger window.

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
  (not those two) as `connection.batch(statements, "write")`. This is safe **only if** the
  `"write"` mode opens the transaction, stops at the first error, and rolls back. That is a
  required property, not observed behavior: nothing on `main` exercises an erroring statement
  inside such a batch (the `"write"` batches in `provision-dev.mjs` all succeed, including a
  one-statement `ALTER TABLE`), so no test pins it. Follow-up pull request 1 must verify it
  against the driver and Turso before anything relies on it; a driver that continued and
  committed after a failed statement would commit an empty `policysql_idempotency` and lose
  every tombstone, exactly as the statement-by-statement case above does.
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
not changed here. The false conflict for retries across a snapshot change was
[#80](https://github.com/unacowa/policysql/issues/80), closed by PR #84; section 2 records it
because retention must not reintroduce it.

**Delivery.** This pull request closes the design question in #67, not the issue. #67 also asks
for a deletion procedure or an implementation in the reference wrapper or an example; that
criterion is met by follow-up pull request 3, so #67 stays open (or its own text is updated)
until that PR lands. Nothing here claims the implementation criterion is already met.

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
   statement with stop-at-first-error and through the serverless driver's `"write"` batch, the
   latter run against the driver and Turso so that the property section 6 requires (stops at
   the first error, rolls back) is verified rather than assumed; a
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
   retry whose row was deleted executes again (pins the documented post-window behavior); a
   row written before a snapshot change, younger than `W`, survives cleanup and still replays
   its stored response on retry (bypass regression for snapshot-based deletion: deleting it
   would let the retry execute the committed write again). Real smoke
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
  including across snapshot changes: after #80 a retry that differs only in the runtime
  snapshot replays.
- A deployment that must keep replays cannot lower an input limit (`maxRequestBytes`, the
  body-side `maxJsonValues`, or the ABI 16 depth limit) below a body accepted in its advertised
  window: lowering one turns those retries into the unknown 500, not a definite rejection
  (#100). The depth limit cannot be honored even by keeping the larger window.
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
  change), a column the library would then require, and makes window changes non-retroactive.
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

Items 1 to 5 are the review's recommendations, **pending maintainer confirmation**; the
decision sections above already assume them. Item 6 records a closed issue and needs no
confirmation.

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
6. **Earlier-snapshot conflicts.** Closed: [#80](https://github.com/unacowa/policysql/issues/80)
   was fixed by PR #84 (a snapshot-only difference replays, section 2). Retained here only to
   record that deletion must not reintroduce the conflict.
