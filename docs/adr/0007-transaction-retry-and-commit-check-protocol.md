# ADR 0007: Transaction retry and commit-check protocol

- Status: accepted

## Context

Edge and HTTP clients can lose a response after a database action has completed. Sequence-only rejection makes a safe retry impossible, while unrestricted retries can duplicate writes. External commit checks also require deterministic ordering and same-transaction reads without exposing a database connection.

## Decision

`Idempotency-Key` is optional for atomic mutations and interactive transaction start (amended by issue #3). A supplied key is validated and scoped to the trusted session's principal (replacing the JWT issuer, ADR 0020), subject, selected role, session, endpoint, and database identity. Its canonical request fingerprint includes the pinned DB binding. Reusing a key with the same payload returns the stored result while retained; a different payload is rejected. Atomic mutation results are stored in `policysql_idempotency` within the same DB transaction as the mutation, preserving the keyed retry contract.

Without a key, each request is a new execution without request-level deduplication. Atomic execution does not look up, insert into, probe for, or create `policysql_idempotency`. This applies to both direct execution and the commit-check DO path. The latter creates a random owner/validation ID per request, preserving callback isolation without enabling idempotency storage. A malformed supplied key is an error; it is never treated as omission. A keyed atomic mutation still fails if the table is missing.

Interactive transaction start uses the same optional-key rule; an unkeyed start creates a fresh random transaction ID/owner. Its state and retries remain in DO storage, independent of the user's DB schema. Each statement, commit, and rollback has a monotonic sequence. Retrying the immediately completed sequence with an identical canonical payload returns its stored response. Reusing a sequence with a different payload, skipping a sequence, or concurrently submitting different commands fails and rolls back an active transaction. Terminal commit and rollback responses remain queryable by repeating the identical terminal command during retention.

Commit checks trigger only when an operation actually changes at least one row in a configured resource. Triggered checks execute sequentially by ascending check identifier. Each gets a distinct short-lived callback capability. Callback SELECTs are processed serially and use the same response and retry rule as transaction statements. Callback role is immutable policy data; trusted session remains the initiating session.

The callback capability authorizes only policy-compiled SELECT against the owned open transaction. It cannot mutate, choose a role, commit, roll back, or obtain credentials. Owner loss, timeout, deny, malformed protocol, or query failure rolls back.

### DO ownership

Atomic Execute uses a transaction-owner DO when the compiled request can trigger a commit
check; otherwise it executes directly. On the DO path, a fresh random owner/validation ID
is assigned per unkeyed atomic request. All its checks and callbacks use that owner and
the same open DB transaction.

Interactive execution allocates an owner at start. Every subsequent statement, commit,
rollback, and validation callback must route to that same owner using the transaction ID
or callback capability. Fresh random IDs apply to unkeyed start requests, not to each
command within a transaction. Internal IDs are for ownership/routing and do not turn an
unkeyed request into a keyed retry or require `policysql_idempotency`.

### Commit outcome recording (amended by issue #48)

A commit retry must never be answered with a definite rejection when COMMIT may have been
sent. The owner therefore:

- persists the record in status `committing`, with `commitSent: { sequence, digest }` (the
  commit command's sequence and canonical payload digest), before it sends COMMIT. If that put
  fails, COMMIT is not sent and the transaction rolls back as before;
- after COMMIT succeeds, writes the terminal record (`committed`, the next sequence, and the
  reply as `last`) in one put, so no record says `committed` without that commit's reply. If
  the put fails, the reply is still `committed`, because the commit applied;
- after a COMMIT error (the transport cannot prove that nothing committed), records `failed`
  and keeps `commitSent`, and answers the commit with `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`;
- never ends a `committing` transaction from its timer or from a failing callback query: the
  commit's outcome alone decides.

`commitSent` is never removed, so it records explicitly that the record's later status was
reached after COMMIT was sent; nothing is inferred from the status alone. A commit command
whose sequence and digest equal `commitSent` is answered after the transaction identity and
pinned database binding are checked, but before any snapshot, route, or
expiry check: with the recorded reply when the record is `committed` with that commit as
`last`, and otherwise (`committing`, `failed`, `expired`, or `committed` with another `last`)
with the new public code `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` (HTTP 503, ADR 0024). A record of
the previous release that says `committed` while its `last` is the preceding command's is
answered the same way for a commit at its next sequence. A commit that waits on its validator
has not sent COMMIT, so its expiry still answers 409 `POLICYSQL_COMMIT_CHECK_REJECTED`.

`POLICYSQL_COMMIT_OUTCOME_UNKNOWN` is never a rejection. The client library does not list it
among definite rejections, so it raises `PolicySqlOutcomeUnknownError` and keeps the commit
pending for `retryPending()`; the Kysely dialect then does not send a contradictory rollback.
An earlier Worker that forwards an owner's reply unchanged passes 503 through; one that maps
codes by its own table serves an unknown code as 500, which the client also treats as unknown.

Atomic Execute on the owner does not answer from the owner record. A keyed retry runs again
and resolves through the `policysql_idempotency` row written in the same database transaction,
and an unkeyed request is never retried, so it has no such window. A failed put of the owner
record after its COMMIT succeeded no longer turns the committed reply into an error.

## Consequences

- Clients using keys can resolve ambiguous network outcomes without duplicating writes while the records remain available. Unkeyed requests can execute again when resent.
- Idempotency storage is security and availability state and must be bounded, encrypted as appropriate, and retained at least as long as advertised.
- Validators can inspect any resource visible to the configured role, including unchanged tables and uncommitted post-state, without receiving raw SQL or a database connection.
- Multiple validators increase transaction hold time because checks and callback queries are serialized.

### Kysely client contract (Spec #6)

The Kysely Dialect does not expose or generate interactive start keys. As amended by
ADR 0015, the Client sends each operation once and never automatically retries begin or
any subsequent command. An explicitly repeated unkeyed begin may create a new owner;
unused empty transactions expire. This does not remove the HTTP
API's optional start-key support. Once started, the driver uses the same transaction ID,
command sequence and serialized payload for retries and never replays the callback.

An unresolved command blocks contradictory commands. In particular a lost commit response
is not proof of rollback: repeat that same commit to confirm it, and require a committed
response status. Kysely's rollback-on-error path must not reverse an unresolved commit.

Driver shutdown rejects new work but preserves the outcome of an in-flight command.
Kysely's rollback-on-error cleanup still consults the existing transaction after shutdown:
an uncertain or failed command retains its original error, while an already confirmed
rollback needs no further request. Shutdown completion is resource cleanup, not proof of
commit or rollback; the application must also observe its transaction promise.
