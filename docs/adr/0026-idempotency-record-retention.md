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
- The table has two shapes today. `examples/database-routing/idempotency.sql` creates
  `(key_hash, fingerprint, response_json)`. `deploy/cloudflare/scripts/provision-dev.mjs`
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
current one until its retry window ends.

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
  how that window is advertised. It does not delete, schedule, or verify deletion.

This is an instance of the wrapper rule, like ADR 0014 (database registration) and ADR 0018
(rate limiting). The library cannot verify that a wrapper honors its advertised window, just as
it cannot verify that a database identity is never reused; both are wrapper obligations.

### 2. The retention contract

A deployment chooses a **retention window** `W` (seconds) per deployment, the same for every
database it serves.

**Wrapper obligation.** A row may be deleted only when its `created_at` is more than `W`
seconds before the database's current time. Rows may be kept longer; nothing else may delete
them (not a size cap, not a snapshot change, not manual cleanup).

**Client-facing guarantee.** For a keyed atomic write, let `t0` be the instant the client first
sent it. A retry with the same key, authenticated context, endpoint, database binding, and
payload, whose idempotency lookup runs before `t0 + W`, is answered from the row when the
original committed: replayed, or `POLICYSQL_IDEMPOTENCY_CONFLICT` if the fingerprint changed
(another payload, generation, or snapshot). It never executes the write a second time. If the
original did not commit, no row exists and the retry executes, as today.

Why this holds: the row's `created_at` is set by the database during the original's
transaction, which runs after `t0`, so `created_at >= t0`. A cleanup that runs at database time
`tc` deletes the row only if `created_at < tc - W`, that is only if `tc > t0 + W`. A lookup
before `t0 + W` therefore cannot follow such a cleanup. A concurrent cleanup cannot make the
lookup wrong either: cleanup only removes rows, so a lookup that sees the row replays the
committed reply (correct even if the row is deleted a moment later), and a lookup that does not
see it ran after a deletion that was already allowed.

**Client rule.** The client measures only elapsed time on its own clock, never a difference
between its clock and the database's: a keyed write may be resent while
`elapsed since first send + D < W`, where `D` bounds how long one request can take to reach its
lookup (the engine's own deadlines are seconds: `transactionMs` is 4 s in the reference
wrapper) plus clock drift. The documentation states this as "do not resend a keyed write more
than `W - M` after first sending it", with a fixed margin `M` (see open questions). After that
the outcome must be resolved another way (by reading the data), never by resending.

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
  without `created_at`; such a database must be migrated (section 6) before the deployment
  advertises a window.

### 5. Advertising the window

- `PolicySqlConfig` (ADR 0021) gains an optional `idempotencyRetentionSeconds`: an integer
  within `[3600, 31_536_000]` (one hour to one year; the floor is an open question), validated
  at construction like every other setting. The library uses it only to advertise it.
- Capabilities `idempotency` gains `retentionSeconds`: the configured value, or `null` when the
  setting is absent. `null` means the deployment declares that it does not delete rows; a
  wrapper that deletes rows must configure the window it deletes by. `spec/openapi.yaml` gives
  `idempotency` this property (`integer` with the bounds above, or `null`).
- Documentation (`docs/http-api.md`, `website/api/execute.md`, `website/clients/kysely.md`,
  `examples/database-routing/README.md`) replaces "while the record remains available" with the
  guarantee and client rule of section 2, naming `retentionSeconds`.

The value is advisory data from the wrapper, like `commitChecksConfigured`; changing it does
not change the snapshot. A wrapper that lowers `W` must keep deleting by the larger of the old
and new windows until the old one has elapsed, so a client that read the old value is still
covered.

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

**Existing tables.** SQLite rejects `ALTER TABLE ... ADD COLUMN` with a `CURRENT_TIMESTAMP`
default on a table that has rows ("Cannot add a column with non-constant default"; checked on
SQLite 3.53), and a constant default would give every future row the same timestamp. A table
without `created_at` is therefore rebuilt in one write transaction (one Turso batch):

```sql
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
```

Every existing row gets the migration time as `created_at`, so it is kept for a full window
from the migration: never shorter than the guarantee, at worst one window longer. Keyed writes
that arrive during the rebuild wait on its lock or fail with a database timeout or unavailable
code (never a rejection) and are answered from the rebuilt table on retry, because the rows are
copied in the same transaction.

**Compatibility.** Core's statements do not change, so the library works with both shapes and
the migration can happen at any time, independently of a library release. The only ordering
rule is the wrapper's: migrate, then enable cleanup, then advertise `retentionSeconds`.

### 7. Scope

This ADR covers `policysql_idempotency` only. Keyed interactive starts and the terminal
interactive records ADR 0007 calls "queryable ... during retention" live in transaction-owner
storage (Durable Objects in the reference wrapper), not in the application database, and are
not changed here.

## Follow-up pull requests

Each ships on its own; none changes core or the ABI.

1. **Schema and documentation.** `examples/database-routing/idempotency.sql` gets the canonical
   DDL and the rebuild script (as a separate, documented file). `provision-dev.mjs` creates the
   index and rebuilds an existing table that lacks `created_at`. Documentation of section 5.
   Tests: core's `INSERT_SQL` and `LOOKUP_SQL` never name `created_at` (pins section 3); the
   atomic differential harness (`step-atomic-differential.test.mjs`) runs its keyed cases
   against both table shapes; the rebuild keeps every row and its replay (a keyed retry before
   and after the rebuild replays the same reply).
2. **Config and Capabilities.** `idempotencyRetentionSeconds` in `PolicySqlConfig` (validation
   and `ConfigError` tests for bounds and type), `idempotency.retentionSeconds` in Capabilities
   (`null` without the setting), `spec/openapi.yaml`, and the HTTP conformance suite.
3. **Reference wrapper cleanup.** A `scheduled` handler in `deploy/cloudflare/wrapper/` with an
   hourly Cron Trigger, and the same in `examples/database-routing/worker.ts` over both tenant
   databases. Tests (node:sqlite): only rows older than `W` are deleted; a row exactly at the
   boundary is kept; batching terminates and bounds each statement; a missing table is a no-op;
   a table without `created_at` is skipped and logged; a keyed retry within `W` replays after a
   cleanup ran; a keyed retry whose row was deleted executes again (pins the documented
   post-window behavior); an earlier-snapshot row younger than `W` survives cleanup and still
   yields `POLICYSQL_IDEMPOTENCY_CONFLICT` (bypass regression for snapshot-based deletion).
   Real smoke (`provision-dev.mjs`, then the deployed dev Worker): a keyed write creates a row
   with `created_at`; a second row is back-dated administratively; triggering the scheduled
   handler (`wrangler dev --test-scheduled` locally, then the deployed cron) deletes only the
   back-dated row; a retry of the fresh write still replays.
4. **Client guidance (optional, see open questions).** If the maintainer wants enforcement, the
   client library reads `retentionSeconds` and refuses to resend a pending keyed operation past
   `W - M`, raising an error that says the outcome must be resolved by reading.

## Consequences

- ADR 0007's "retained at least as long as advertised" becomes concrete: the window is
  advertised in Capabilities, and the guarantee is stated in terms of it.
- A committed keyed write can execute twice only when its retry arrives after the window,
  which the documented client rule excludes. Within the window nothing changes, including
  across snapshot changes (conflict, never a second execution).
- Stored replies, including `RETURNING` data, live for a bounded time.
- Core, the ABI, and the snapshot are unchanged; the library gains one optional config setting
  and one Capabilities field.
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

## Open questions for the maintainer

1. **Reference window and floor.** Proposed: the reference wrapper uses `W = 86_400` (24 h), and
   config accepts `[3600, 31_536_000]`. Is 24 h right for the client guidance "persist the key
   and payload to retry after an application reload", or should it be longer (7 days)?
2. **Client margin `M`.** Proposed: a fixed `M = 300` seconds in the documentation (covers the
   seconds-long request deadlines and clock drift with room). Alternatively `W / 10`.
3. **Client enforcement.** Should the client library read `retentionSeconds` and refuse to
   resend past `W - M` (follow-up 4), or is documentation enough? Enforcement needs the client
   to remember the first-send time of a persisted operation across reloads.
4. **Library helper.** Should the library export the cleanup SQL and the rebuild script as
   constants (fixed text, no decision, so an adapter-like helper per ADR 0019), so wrappers do
   not copy them, or should they stay in documentation and the reference wrapper only?
5. **Required window.** Should `idempotencyRetentionSeconds` become required (a breaking change
   allowed in beta), so that no deployment advertises `null` by omission?
6. **Earlier-snapshot conflicts.** Out of scope here, but surfaced by this analysis: a committed
   keyed write retried across a snapshot change gets `POLICYSQL_IDEMPOTENCY_CONFLICT`, which the
   client takes as a definite rejection although the write committed (ADR 0024 calls this a
   false conflict). Should a separate issue replay such retries by a snapshot-free replay
   identity, as ADR 0007 does for exact interactive retries?
