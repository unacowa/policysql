# Phase 7 concerns: implementation feasibility spike

## Scope and environment

The spike ran on 2026-08-04 with:

- `turso_parser` 0.7.2;
- `@tursodatabase/database` 0.7.2;
- `@tursodatabase/serverless` 1.4.0;
- Node.js 26.4.0;
- Wrangler 4.111.0;
- a disposable Turso Cloud database in the `default` Tokyo group;
- a disposable Cloudflare Worker with a SQLite-backed Durable Object.

The Turso database and Worker were deleted after each run. Database credentials were uploaded as Cloudflare secrets, the temporary local secret file was removed, and `.env`, `.dev.vars`, Wrangler state, and spike artifacts are ignored by Git.

## Verified results

### Parser and binder

A narrow SELECT binder using the Turso 0.7.2 parser successfully assigned stable Catalog `ResourceId` and `ColumnId` values through aliases, joins, predicates, ordering, and a statically provable correlated subquery.

The binder rejected:

- ambiguous and unknown columns;
- unknown resources;
- implicit `rowid`, `_rowid_`, and `oid` access;
- star projection;
- protected-resource CTE shadowing;
- multiple statements;
- every unsupported statement, table source, and expression shape.

This verifies that resource and column discovery is feasible for a closed subset. Parsing alone remains insufficient. The initial binder keeps every broader shape disabled; the following extension tests selected shapes individually rather than enabling the whole SQLite grammar.

An extended binder then verified representative shapes for:

- sequential non-recursive CTEs and aliased derived tables, preserving base `ResourceId` and `ColumnId` provenance through their output columns;
- `GROUP BY`, aggregate arguments, `HAVING`, and inline window partition/order expressions with distinct usage contexts;
- INSERT target writes and `RETURNING` reads;
- UPDATE target writes, right-hand-side reads, filters, and `RETURNING` reads;
- DELETE filters and `RETURNING` reads.

The extended tests prove that the Turso parser exposes enough structure to implement these features. They do not prove all SQLite syntax variants. CTE column lists, compound SELECTs, named windows, window frames, `UPDATE FROM`, conflict clauses, mutation ordering/limits, and `INSERT SELECT` remain fail-closed in the spike.

### Emission and second-pass verification

A typed bound representation containing only Catalog resource IDs, column ordinals, compiler-owned aliases, and a server parameter was emitted as a protected LEFT JOIN. The emitted SQL was parsed again, rebound to Catalog IDs, and checked by a separate AST invariant checker. The checker required the exact access set, one LEFT JOIN, the right-resource tenant predicate in `ON`, the left-resource tenant predicate in `WHERE`, and the server-owned parameter in both predicates.

Negative controls removed the joined-resource policy and appended a second statement. The invariant checker rejected both. This establishes the architecture for typed emission and second-pass checking without trusting the emitter. It does not establish complete emitter correctness; every newly accepted bound-IR node still requires its own positive, negative, bypass, and differential fixtures.

### LEFT JOIN policy placement

A local Turso data fixture compared policy placement for a left join from posts to authors. Placing the author policy in the join `ON` clause returned all three allowed posts: the allowed author remained visible and the denied or missing authors became NULL-extended rows. Moving the same author predicate to `WHERE` collapsed the outer join and returned only the allowed-author post.

The compiler must therefore place a protected nullable-side resource filter in that join's `ON` predicate. A left-side resource filter remains in `WHERE`. Nested outer joins require null-extension-boundary analysis rather than a blanket rule based only on table order.

### Values, redaction, and types

A protected SELECT returned the direct value and a server-only visibility marker in one statement. The visible row returned `visible-note` with marker `1`; the denied row returned SQL NULL with marker `0`. This is sufficient for the gateway to remove the marker and produce cell-level redaction metadata.

Both embedded and remote Turso returned empty `columnTypes` for `SELECT 1`, `datetime('now')`, CASE expressions, and policy-generated CASE/visibility expressions. A direct TEXT base column retained `TEXT`, but the CASE-derived value did not. Therefore database result metadata cannot be the PolicySQL logical type source. Explain and runtime response descriptors must come from the PolicySQL Catalog, expression typer, and function registry, followed by runtime value validation.

### Mutation checks

SQLite/Turso rejected a DML `RETURNING` clause used as a CTE input. A separate transaction test inserted a row with an invalid tenant, received its uncommitted `RETURNING` post-state, evaluated the operation check outside SQL, rolled back, and verified that zero rows persisted.

Atomic mutation checks are therefore feasible as a transaction-owned multi-stage operation. They are not generally expressible as one rewritten SQL statement.

### Turso Cloud serverless transport

- An atomic batch rolled back its earlier INSERT after a later statement failed.
- Interactive write transactions provided read-your-writes.
- Holds of 1.5, 3.5, 5.5, and 15 seconds completed successfully in the measured environment.
- A second ordinary write transaction waited until the first released its write transaction; this was serialization, not MVCC concurrency.
- Requesting transaction mode `concurrent` failed after approximately 30 seconds with HTTP 404.

The serverless Cloudflare/Turso Cloud adapter must not advertise MVCC concurrent transactions. Transaction duration remains a deployment capability and must not be inferred from this single timing result.

### Embedded Turso MVCC

With `journal_mode=mvcc`, two concurrent transactions both read an account total of 150, updated different rows, committed, and produced a final total of -50. This reproduces snapshot-isolation write skew.

When both transactions additionally updated one invariant guard row, one committed, one was rejected, and the final total remained 50. Guard-row conflict is therefore effective for serializing transactions that enforce the same cross-row invariant.

The JavaScript transaction wrapper reported the rejected transaction as `cannot rollback - no transaction is active`, masking the original conflict. The PolicySQL adapter must detect this behavior and normalize it to a commit-conflict error without exposing the raw engine message.

### Cloudflare transaction owner

A deployed Durable Object retained a Turso Cloud transaction handle across separate public HTTP requests:

1. one request started the transaction and inserted a row;
2. a later request read the uncommitted row;
3. a third request rolled back;
4. a final request verified that zero rows persisted.

The measured cross-request hold was approximately 1.6 seconds. This proves the transaction-owner shape needed by commit-check callback queries. It does not make owner recovery possible: Durable Object eviction, deployment, connection loss, or baton expiry remains terminal and must roll back or expire the transaction.

The deployed Worker was also tested with Cloudflare's `DurableObjectState.abort()` while a Turso transaction was open. The abort request returned a non-JSON HTTP 500, the replacement instance reported no active transaction, the uncommitted row count was zero, and a new transaction could begin and roll back. The transaction handle was not recoverable after reset, as expected.

PolicySQL must persist only a terminal transaction record or lease state, never connection material intended to reconstruct the old transaction. A caller that reaches a replacement owner receives a stable transaction-lost error and must restart the whole unit of work. Cleanup may be immediate on connection close or eventual on the database side; correctness must not depend on which occurs.

Worker route propagation was operationally variable. Successful runs required between a few attempts and 40 seconds, and one run had not propagated after 45 seconds. Deployment health checks must tolerate propagation delay and must never report a new transaction service ready before its route and Durable Object migration are reachable.

## Required specification changes

1. Separate adapter capabilities for embedded Turso MVCC and Turso Cloud serverless transactions. Cloudflare-first support does not imply MVCC support.
2. Define operation checks as protected DML plus server-only post-state capture and in-transaction validation, not as one SQL rewrite.
3. State that logical result metadata is compiler output. Engine `columnTypes` is advisory input at most.
4. Require a policy-owned serialization guard for commit checks that claim concurrent cross-row or cross-resource integrity under snapshot isolation. The guard key may be global, per check, or partitioned by a statically derived invariant key.
5. Keep unsupported SQL capabilities false until their binder, policy placement, emitter, invariant verifier, and differential tests exist.
6. Normalize MVCC conflict and already-rolled-back driver errors into one safe retryable error.
7. Treat Durable Object and connection loss as terminal. Never reconstruct an open transaction from a transaction ID on another connection.

## Remaining feasibility work

- Expand emission and second-pass verification from the representative LEFT JOIN IR to every advertised SELECT and mutation IR node.
- Test nested LEFT JOINs, right-side subqueries, nullable join keys, and policy predicates containing subqueries at each null-extension boundary.
- Extend the proven binder subset one syntax shape at a time; the advanced spike deliberately leaves several variants fail-closed.
- Define and test schema-version guard and idempotency-record atomicity.
- Test callback timeout and Turso baton expiry. Forced Durable Object reset is now covered; natural eviction timing cannot be made deterministic and uses the same terminal-owner path.
- Run parser/binder/emitter fuzzing and SQLite/Turso differential suites for every advertised capability.

## Reproduction

```sh
cargo test --manifest-path spikes/sql-binder/Cargo.toml

set -a
. ./.env
set +a
npm --prefix spikes/turso-cf install
npm --prefix spikes/turso-cf run compiler
npm --prefix spikes/turso-cf run spike
```

Set `POLICYSQL_SPIKE_FAST=1` to skip the longer remote hold cases and the unsupported remote `concurrent` probe while retaining the core embedded, mutation, redaction, and Durable Object checks.
