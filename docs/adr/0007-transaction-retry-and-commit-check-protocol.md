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
3. If the command's sequence and digest equal `commitSent`, the commit is answered now, before any snapshot,
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
- **An unreadable record** is discarded: a commit gets `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`,
  every other command `POLICYSQL_TRANSACTION_UNAVAILABLE` (ADR 0024, "Fail-closed rules").

`POLICYSQL_COMMIT_OUTCOME_UNKNOWN` is never a rejection. The client library does not list it
among definite rejections, so it raises `PolicySqlOutcomeUnknownError` and keeps the commit
pending for `retryPending()`; the Kysely dialect then does not send a contradictory rollback.

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

Amendment (#54): a failure that provably happened before any byte of COMMIT was sent (the transport's last binding check and deadline check, after which it rolls back) is reported as `not_committed` and answered with the definite `POLICYSQL_TRANSACTION_UNAVAILABLE` (409), in every placement; a retry of an atomic execution then runs as a new attempt, and a retry of an interactive commit finds a failed transaction. This does not weaken the rule above: only an error raised before the send began is classified so, and any failure of the COMMIT request itself, or after it, stays an unknown outcome (ADR 0024, "Failures before COMMIT is sent", ABI 12).

Amendment (#85 path 2): an owner that does not share the Worker's snapshot answers an atomic input with the version-skew answer `POLICYSQL_INTERNAL` (500), never `POLICYSQL_TRANSACTION_CONFLICT`, because the retry may be of a commit that already applied; the client takes it as an unknown outcome and the retry replays once the snapshots agree (ADR 0024, ABI 11).

Amendment (#85 path 1): the compile and its authorization run before the idempotency lookup, so a keyed execute whose compile fails (a policy or schema change, a role that lost the operation, or the body's `expected` check) is answered `POLICYSQL_INTERNAL` (500), the unknown outcome, on the direct and owner placements alike (WASM ABI 18). The request is not looked up: an absent row does not prove that no commit happened (the earlier attempt may still be in flight, may have committed in the #97 autocommit window, or its row may have expired), and a matching row is not replayed, because the current deployment's compile would not authorize its result to this principal. Nothing runs and the key is not consumed: a later deployment whose compile accepts the request replays the row. A request without a key keeps its definite compile error, because it has no replay contract. The wrapper's session gate follows the same rule: a keyed execute whose trusted session lost the `execute` access or role is 500, while an unkeyed one stays 403 `POLICYSQL_FORBIDDEN_ACCESS` (the body is not read and no database work happens in either case). A request pinned to a superseded wire snapshot is still answered 409 `POLICYSQL_STALE_OPERATION` before the compile: that tells the caller its snapshot is stale and does not depend on the policy; after refreshing, the same key reaches this rule. Residual risk: while the request is unknown, the caller cannot tell whether its write committed; it must not treat the 500 as a rollback, and a retry under the same key is the only resolution (until the row expires, when a retry is a new attempt). This is the price of not returning a definite answer without proof. The rule covers the compile and the wrapper's session gate. Interactive commands are outside this amendment: the session gate authorizes each command with `execute`, and a `commit` retry whose session lost access still answers 403 `POLICYSQL_FORBIDDEN_ACCESS`; that is the intentional exception defined by amendment #104 below. Rejections that happen before the body reaches the compile are covered by the next amendment where their answer can depend on the deployment.

Amendment (#100): the body-side input limits are checked before the compile and its idempotency lookup, and two of them can make a committed keyed write's retry hit a limit it did not hit when it committed: `maxRequestBytes` and the body-side `maxJsonValues` can be lowered by a deploy, and the JSON depth limit tightened from accepting 65 nested containers to 64 (ADR 0027 pull request 7, ABI 16). A keyed Atomic Execute whose body is refused by `POLICYSQL_REQUEST_TOO_LARGE` or `POLICYSQL_JSON_TOO_DEEP` is therefore answered `POLICYSQL_INTERNAL` (500), the unknown outcome, on the direct and owner placements alike (WASM ABI 18). The `Idempotency-Key` header is read before the body, so the engine knows the request is keyed; it does not look up, replay, execute, or COMMIT, and it does not consume the key. A declared `Content-Length` over `maxRequestBytes` is refused unread and a streamed body is cancelled at the same bound as before, so the unknown answer does not buffer a body over the limit. A request without a key, or with a key that fails the syntax above (which core could never have accepted or recorded), keeps its definite 413/400, because it has no replay contract. Rejections that were invalid under every deployment also stay definite: JSON syntax (including a number such as `1e400`, which the old engine rejected at compile and so never committed), duplicate keys, escaped and raw lone surrogates, invalid UTF-8, a missing body, and a wrong content type. A fresh key gets the same unknown answer: an absent row does not prove that no commit happened, for the same reasons as the compile rule. Residual risk: the caller cannot tell whether its write committed; it must not treat the 500 as a rollback, and a retry with the same key and body is the only resolution. After the row expires, a retry whose body is within the current limit is a new attempt; a body that still exceeds the limit stays unknown, so the caller must not retry it forever without operator action. This is the price of not returning a definite answer without proof. Lowering `maxRequestBytes` or `maxJsonValues` is not a correctness migration: no retry becomes a definite rejection. It can, however, turn a retry of a write committed under the old limits into this unknown outcome for the retention window W (ADR 0026, PR #79), so an operator who needs those retries to replay must not lower a limit below a body accepted in the last W. The ABI 16 depth tightening cannot preserve that: a depth-65 body is refused before the lookup under every current build, so a depth-65 commit from a pre-ABI-16 deployment stays unknown even after its row expires; expiry removes only the possibility of a replay, not the unknown, and the library is unpublished. Result-side limits need no such rule: the idempotency lookup's read cap uses the hard maximum of `maxResponseBytes`, so a lowered result limit still replays its stored response (ADR 0027, "Idempotent replay"). Interactive start and commit, interactive commands, and Explain keep their current behavior; a keyed interactive `commit` retry affected by a deploy is the intentional exception defined by amendment #104 below.

Amendment (#104): the wrapper's authentication and the engine's session gate are the one intended exception to the commit-retry rule. The wrapper authenticates every command, including `commit`, and the engine's `command` handler authorizes the trusted session for the endpoint's `execute` access before it routes to or looks up the transaction owner, so a `commit` whose credential the wrapper cannot verify is answered 401 (`POLICYSQL_UNAUTHENTICATED` in the reference wrapper, or the reserved `POLICYSQL_AUTHENTICATION_FAILED` a custom wrapper may use for failed verification) and one whose session lacks `execute`, or whose `PolicySQL-Role` is not in the session's `roles`, is answered 403 `POLICYSQL_FORBIDDEN_ACCESS`; nothing is sent to the owner in either case. The exception is intended: the caller must be authenticated before its transaction's state can be discussed at all; the owner is addressed by transaction id alone, so answering a commit retry without a successful session check would report commit state to a principal the wrapper no longer trusts; and stopping a transaction after token expiry or revocation is already the wrapper's obligation (docs/database-routing.md). The residual risk is plain: the caller cannot tell whether the COMMIT applied, must not treat the 403/401 as "not committed", and resolves the outcome by reading its own data. This is the price of not answering an unauthenticated caller. A deployment that wants its callers to resolve a commit retry this way must keep the session valid, or the credential renewable, for at least as long as a commit retry may arrive; a deploy that removes `execute` from a role, or whose credential expires mid-transaction, converts such retries into this exception. The contrast with keyed atomic execute (#85 path 1) keeps the exception narrow: there a present `Idempotency-Key` is evidence of a replay contract that does not need the session, so a session denial is answered with the unknown 500; an interactive commit retry carries no such key, so nothing before the owner can distinguish it from a fresh command, and the sequence and digest that could are exactly what the session gate prevents reaching. Keyed atomic execute, #100, and every command that reaches the owner are unchanged.


## Consequences

- Clients using keys can resolve ambiguous network outcomes without duplicating writes while the records remain available. Unkeyed requests can execute again when resent.
- A commit retry denied by the wrapper's authentication (401) or by the engine's session gate (403 `POLICYSQL_FORBIDDEN_ACCESS`) is the intended exception to the rule that a commit retry is never a definite rejection: the denial stops the transaction before the owner, so the caller cannot tell whether an earlier COMMIT applied, must not read the 403/401 as "not committed", and resolves the outcome by reading its own data (amendment #104).
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
