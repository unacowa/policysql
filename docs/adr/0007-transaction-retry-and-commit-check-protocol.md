# ADR 0007: Transaction retry and commit-check protocol

- Status: accepted (retry and callback rules amended by [ADR 0024](0024-transaction-step-machine.md) from
  its pull request 7)

## Context

Edge and HTTP clients can lose a response after a database action has completed. Sequence-only rejection makes a safe retry impossible, while unrestricted retries can duplicate writes. External commit checks also require deterministic ordering and same-transaction reads without exposing a database connection.

## Decision

`Idempotency-Key` is optional for atomic mutations and interactive transaction start (amended by issue #3). A supplied key is validated and scoped to the trusted session's principal (replacing the JWT issuer, ADR 0020), subject, selected role, session, endpoint, and database identity. Its canonical request fingerprint includes the pinned DB binding except its deployment snapshot (amended by #80, [ADR 0014](0014-wrapper-provided-database-bindings.md#amendment-the-request-fingerprint-has-no-snapshot-80)). Reusing a key with the same payload returns the stored result while retained, also after a deployment that changed the snapshot, so a committed keyed atomic write is not answered with a rejection on retry; a different payload, or another database generation, is rejected. Atomic mutation results are stored in `policysql_idempotency` within the same DB transaction as the mutation, preserving the keyed retry contract.

Without a key, each request is a new execution without request-level deduplication. Atomic execution does not look up, insert into, probe for, or create `policysql_idempotency`. This applies to both direct execution and the commit-check DO path. The latter creates a random owner/validation ID per request, preserving callback isolation without enabling idempotency storage. A malformed supplied key is an error; it is never treated as omission. The key syntax is 16-128 ASCII characters from letters, digits, and `. _ : - + / =` (amended by #65: `+ / =` were added so standard and URL-safe base64 keys, padded or not, are accepted unchanged; the comma stays rejected because a repeated header is comma-joined, and so do internal whitespace, controls, and non-ASCII; leading and trailing spaces and tabs of a header value are removed by Fetch `Headers` before core sees the key). The minimum of 16 keeps guessable keys out of the principal's key space. A key that fails the syntax is `400 POLICYSQL_IDEMPOTENCY_KEY_INVALID` (renamed by #65 from `POLICYSQL_IDEMPOTENCY_KEY_REQUIRED`, which read as "missing"; an absent key is valid, so there is no "required" case), rejected before any database work, so the client treats it as a definite rejection. `keyHash` is `sha256(identity + ":" + key)` of the key text as sent and is unchanged. The change bumped `ABI_VERSION` to 10 (a malformed key is answered differently and `+ / =` keys now hash). A keyed atomic mutation still fails if the table is missing.

Interactive transaction start uses the same optional-key rule; an unkeyed start creates a fresh random transaction ID/owner. Its state and retries remain in DO storage, independent of the user's DB schema. Each statement, commit, and rollback has a monotonic sequence. Retrying the immediately completed sequence with an identical canonical payload returns its stored response. Reusing a sequence with a different payload, skipping a sequence, or concurrently submitting different commands fails and rolls back an active transaction. Terminal commit and rollback responses remain queryable by repeating the identical terminal command during retention.

Commit checks trigger only when an operation actually changes at least one row in a configured resource. Triggered checks execute sequentially by ascending check identifier. Each gets a distinct short-lived callback capability. Callback SELECTs are processed serially and use the same response and retry rule as transaction statements. Callback role is immutable policy data; trusted session remains the initiating session.

The callback capability authorizes only policy-compiled SELECT against the owned open transaction. It cannot mutate, choose a role, commit, roll back, or obtain credentials. Owner loss, timeout, deny, malformed protocol, or query failure rolls back, scoped to a running validation: see "Callback rules of the step machine", which `TransactionOwnerCore` also follows since [#73](https://github.com/unacowa/policysql/issues/73).

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
- checks the deadline again after that put. If it has passed, COMMIT is not sent: the owner
  rolls back, records `expired` without `commitSent`, and only then answers 409
  `POLICYSQL_TRANSACTION_UNAVAILABLE`. If `expired` cannot be stored, it answers 500 and the
  record stays `committing`, so a retry gets the unknown outcome;
- after COMMIT succeeds, writes the terminal record (`committed`, the next sequence, and the
  reply as `last`) in one put, so no record says `committed` without that commit's reply. If
  the put fails, the reply is still `committed`, because the commit applied. The live owner
  keeps that terminal record in memory and stores it again on the next retry of that commit,
  then replays the reply; a successor, which has no such memory, or a second failed put
  answers with the unknown outcome;
- after a COMMIT error, records `failed`, keeps `commitSent`, and answers the commit with
  `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`, also when that record cannot be stored (the record then
  stays `committing`). A transport error does not prove that nothing committed. An error
  result for COMMIT from the database is treated the same way: neither the Hrana protocol nor
  the remote server documents that such a result means COMMIT did not apply;
- never ends a `committing` transaction from its timer or from a failing callback query: the
  commit's outcome alone decides.

`commitSent` is never removed. It records explicitly that every later status of the record was
reached after COMMIT was sent; nothing is inferred from the status alone.

A commit command is checked in this order:

1. The stored record must have the command's transaction id.
2. The caller must be the record's caller: its auth fingerprint and database binding must
   equal the record's. Both include the snapshot. For a commit command only, a caller that
   differs in nothing but the snapshot is also accepted: the database binding must be equal
   except for `snapshot` (version, scope, database id, and generation are the same), and the
   fingerprint the caller presents must equal the one the owner computes from the record's
   stored `auth` (principal, subject, role, session) and the caller's binding. The owner first
   checks that the stored `auth` and binding still produce the stored fingerprint. Another
   principal, subject, role, session, or database is rejected with 409
   `POLICYSQL_TRANSACTION_UNAVAILABLE`, as before.
3. If the command's sequence and digest equal `commitSent` (or the record is one of the
   previous release's, described below), the commit is answered now, before any snapshot,
   route, or expiry check. It gets the recorded reply when the record is `committed` with this
   commit as `last`, or when the live owner has just stored the terminal record it kept in
   memory. Otherwise it gets the new public code `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` (HTTP 503,
   ADR 0024): the record is `committing`, `failed`, or `expired` after COMMIT was sent, or
   `committed` with another `last`.
4. Every other command, and a commit that step 3 does not answer, must be on the record's
   snapshot (otherwise 409 `POLICYSQL_TRANSACTION_UNAVAILABLE`), and then passes the route and
   expiry checks and the sequence rules as before.

A deployment between a commit and its retry therefore changes nothing for that commit: it
gets its recorded reply or the unknown outcome. A commit that waits on its validator has not
sent COMMIT, so its expiry still answers 409 `POLICYSQL_COMMIT_CHECK_REJECTED`.

Records written by the previous release carry neither `commitSent` nor `commitRecording: 1`,
which this release writes into every record it starts. The previous release wrote nothing
before COMMIT and could leave `committed` with the preceding command's `last` (between its two
puts), `active` (owner lost after COMMIT), `failed` (a COMMIT error, or its successor's fail
closed), or `expired` (its timer during COMMIT) after a COMMIT that may have applied. Nothing in
such a record proves that COMMIT was not sent (ADR 0024), so a commit at the record's next
sequence is answered with the unknown outcome, never a rejection, when no open transaction of
this owner belongs to it. The cost is that a commit that really was rejected or never sent by
the previous release also gets the unknown outcome; `validating` and `rolled_back` records,
and a commit at any other sequence, are still rejected because they prove that no COMMIT was
sent for that command. What remains is a retry that the previous release's own owner serves
before the deployment replaces it: that code answers as it always did, possibly with 409, and
no change in this release can reach it. This needs a retry that overlaps the deployment
itself, so it occurs only during the rollout: an interactive transaction lives at most a few
seconds, and a deployment restarts every owner.

### Retry rules of the step machine (amended by ADR 0024, effective from its pull request 7)

The transaction step machine of [ADR 0024](0024-transaction-step-machine.md) replaces
`TransactionOwnerCore` at the switch-over (ADR 0024 pull request 7; pull request 4 adds it
unused). It keeps the guarantee above (no commit retry is answered with a definite rejection
when COMMIT may have been sent) with these rules, which replace the numbered order and the
in-memory re-recording above once it is in use:

- **Exact retries are answered before the snapshot and liveness checks, for every command.**
  A statement, commit, or rollback whose sequence is the last completed one and whose
  canonical payload digest equals the recorded `last.digest` gets `last.response`, also when
  the caller's snapshot differs from the record's, the owner was lost, or the deadline passed.
  The caller must match the record's *replay identity*: a hash of the principal, subject,
  role, session, and the database binding without its `snapshot` (version, scope, database id,
  and generation). This is safe because the replay identity carries everything the auth
  fingerprint carries except the deployment snapshot: another principal, subject, role,
  session, database, or generation is still rejected with `POLICYSQL_TRANSACTION_UNAVAILABLE`,
  a replay executes nothing and returns only the reply the same caller already received, and
  every command that does work still requires the full fingerprint, the record's snapshot, the
  runtime's snapshot, and a live connection. Item 4 above therefore no longer requires the
  record's snapshot for an exact retry of a non-commit command.
- **`committing` and `commit_unknown`.** A commit at the sequence of a commit whose
  `committing` record was persisted is answered with `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` unless
  the terminal `committed` record (with that commit as `last`) was stored; the successor rule
  persists `commit_unknown` first. Other commands get `POLICYSQL_TRANSACTION_UNAVAILABLE`.
- **No in-memory re-recording.** When the terminal record cannot be stored after COMMIT
  succeeded, the reply is still `committed`, and the owner then resets: it drops its memory and
  answers the next event from the store, exactly as a successor would. A commit retry
  therefore gets `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` (the store holds `committing`), also after
  the store recovers. This replaces "the live owner keeps that terminal record in memory and
  stores it again on the next retry": a same-owner retry and a successor give the same answer,
  and neither is a rejection.
- **A failed ROLLBACK** keeps the decided phase (`rolled_back` for a rollback command,
  `expired` or `failed` otherwise). The phase means that the transaction will never be
  committed (no COMMIT is ever sent for it), not that the server confirmed the rollback; the
  server transaction, and any locks it holds, may persist until the database deadline ends it.
- **Records written before the switch-over**, `commitRecording` ones included, are discarded:
  a commit gets `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`, every other command
  `POLICYSQL_TRANSACTION_UNAVAILABLE` (ADR 0024, "Old-format records are discarded, not read").

`POLICYSQL_COMMIT_OUTCOME_UNKNOWN` is never a rejection. The client library does not list it
among definite rejections, so it raises `PolicySqlOutcomeUnknownError` and keeps the commit
pending for `retryPending()`; the Kysely dialect then does not send a contradictory rollback.
An earlier Worker that forwards an owner's reply unchanged passes 503 through; one that maps
codes by its own table serves an unknown code as 500, which the client also treats as unknown.

Atomic Execute on the owner does not answer from the owner record. A keyed retry runs again
and resolves through the `policysql_idempotency` row written in the same database transaction,
and an unkeyed request is never retried, so it has no such window. A failed put of the owner
record after its COMMIT succeeded no longer turns the committed reply into an error.

### Callback rules of the step machine (amended by ADR 0024, effective from its pull request 7)

The rule "owner loss, timeout, deny, malformed protocol, or query failure rolls back" is
scoped to the validation a callback belongs to. In the step machine of
[ADR 0024](0024-transaction-step-machine.md) (pull request 5 adds it unused):

- **No live capability: nothing changes.** A callback query that reaches an owner with no
  validation running (the transaction is active, committing, or terminal, the owner is a
  successor, or the validator's verdict already revoked the capability) is answered 409
  `POLICYSQL_TRANSACTION_UNAVAILABLE` and has no other effect. It is not a callback of any
  validation, so it cannot end the transaction; otherwise anyone holding a validation id could
  end an active transaction.
- **A live capability: any failure rolls back.** While a validator is awaited, a callback with a
  malformed, wrong, or expired token is an authentication failure of that validation: it is
  answered `POLICYSQL_TRANSACTION_UNAVAILABLE`, the transaction rolls back and records
  `failed`, and the waiting commit gets `POLICYSQL_COMMIT_CHECK_REJECTED`. So does every other
  callback failure (malformed command, sequence conflict, compile error, non-read or multi-
  statement query, binding rejection, query or result failure, a callback limit). The commit is
  answered at once, not when the validator returns.

A caller that knows the validation id can therefore end the transaction only while one of its
validations is running, which is today's behavior during validation. `TransactionOwnerCore`
follows the same rule since [#73](https://github.com/unacowa/policysql/issues/73) (it failed an
active transaction on a stray callback before), and the differential harness asserts that both
owners agree. In both, any close also revokes the capability, and a callback query still running
when its capability is revoked is answered `POLICYSQL_TRANSACTION_UNAVAILABLE`, returns no rows,
and does not restore it. `TransactionOwnerCore` reads its record from the store to find the live
capability; a failed read while a validator is awaited is a failure of that validation (it
rolls back), so a store fault cannot leave a capability live (the machine keeps the record in
memory and has no such read).

Amendment (#85): an owner that does not share the Worker's snapshot answers an atomic input with the version-skew answer `POLICYSQL_INTERNAL` (500), never `POLICYSQL_TRANSACTION_CONFLICT`, because the retry may be of a commit that already applied; the client takes it as an unknown outcome and the retry replays once the snapshots agree (ADR 0024, ABI 11). The limit: a committed keyed write that carried `expected` is checked against it before the idempotency lookup, so after a rollout that changed the policy its retry is `POLICYSQL_STALE_OPERATION`, a definite rejection; that remains open as #85 path 1.


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
