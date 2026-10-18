# ADR 0007: Transaction retry and commit-check protocol

- Status: accepted

## Context

Edge and HTTP clients can lose a response after a database action has completed. Sequence-only rejection makes a safe retry impossible, while unrestricted retries can duplicate writes. External commit checks also require deterministic ordering and same-transaction reads without exposing a database connection.

## Decision

`Idempotency-Key` is optional for atomic mutations and interactive transaction start (amended by issue #3). A supplied key is validated and scoped to authenticated issuer, subject, selected role, session, endpoint, and database identity. Its canonical request fingerprint includes the pinned DB binding. Reusing a key with the same payload returns the stored result while retained; a different payload is rejected. Atomic mutation results are stored in `policysql_idempotency` within the same DB transaction as the mutation, preserving the keyed retry contract.

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
