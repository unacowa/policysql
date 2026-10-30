# ADR 0014: Mandatory wrapper-provided databases

- Status: accepted

## Context

Fixed Turso env reads inside the adapter made database selection implicit. An optional
provider retained that fallback and coupled selection to JWT claims. The intended
boundary requires the application to supply the database explicitly.

## Decision

The wrapper owns database selection/authorization, registration, credentials, and
connection creation. `createApp` and `createPolicySqlWorker` require a `DatabaseProvider`
with `check` and `connect`. Each `app.fetch` call requires an already-selected
`DatabaseBinding` as `database` in its fourth argument (`{ database, session }` since
[ADR 0020](0020-trusted-session-input-and-jwt-identity-adapter.md)). No selection callback or
JWT routing claims exist in this library API. Authentication is also a wrapper concern; the
wrapper passes the trusted session next to the database.

Missing providers fail at construction. Missing per-request bindings fail with
`POLICYSQL_DATABASE_REQUIRED` before any database work. Fixed-env fallback is removed;
connection options must be explicitly supplied even to the Turso HTTP adapter.

PolicySQL pins the validated binding across transactions, DO delegation, callbacks,
cost observations, and retries. The DO provider resolves local credentials for the exact
binding supplied by the wrapper. `fetchCallback` accepts only the capability-protected
callback route and uses the binding already owned by that transaction.

Idempotency key identity includes scope/database identity; its fingerprint also includes
the binding's version and generation, but not its snapshot (amended by #80, see
[the amendment below](#amendment-the-request-fingerprint-has-no-snapshot-80)). Credentials do
not affect retry identity. Database identities must
never be reused for another physical DB. Schema compatibility, route retirement, and
cross-DB migration of unresolved writes remain wrapper responsibilities.

SQL authorization, rewriting, verification, and result validation remain in Rust as
required by ADR 0011. The TypeScript wrapper is trusted deployment code that supplies
transports for one compatible immutable runtime snapshot. It does not construct raw
public SQL execution paths or change backend profiles per request.

### Amendment: the request fingerprint has no snapshot (#80)

The request fingerprint was `sha256(identity + ":" + body + ":" + binding)` over the whole
binding, snapshot included ([ADR 0025](0025-core-defined-canonical-json.md)). Every deployment
that changes the snapshot (ABI, policy, or schema) therefore made the fingerprint of a
committed keyed atomic write unmatchable: a retry after such a deployment got
`POLICYSQL_IDEMPOTENCY_CONFLICT`, which the client takes as a definite rejection although the
write committed ([ADR 0007](0007-transaction-retry-and-commit-check-protocol.md)). Since ABI 9
the request fingerprint hashes the binding without its `snapshot` member
(`{version, scope, databaseId, generation}`), for both endpoints that use it (`execute` and the
keyed `interactive-start`):

- A same-key retry whose body, identity (principal, subject, role, session, endpoint,
  database), and binding are equal except for the snapshot replays the stored response. The
  replay executes nothing and returns the committed results the same caller already received,
  with the original request id and transaction id. Its `meta.policyVersion` and
  `meta.schemaVersion` are those of the deployment that answered (the stored record has no
  versions), as for every replay.
- Another body, or another generation of the same database, still conflicts. Another scope or
  database id has another key hash.
- The snapshot is still checked before any lookup: a request whose binding names another
  snapshot than the runtime's is `POLICYSQL_STALE_OPERATION`. A keyed `interactive-start`
  still requires the owner record's snapshot and auth fingerprint, so this changes nothing for
  interactive begin.
- The auth fingerprint of interactive records keeps the snapshot; commit retries already match
  by the replay identity, which has none (ADR 0007, ADR 0024).

**Transition.** Rows written before ABI 9 carry the old fingerprint (with the snapshot) and
never match the new one. A keyed retry that finds such a row gets
`POLICYSQL_IDEMPOTENCY_CONFLICT`, exactly as it would have on any snapshot-changing deployment
before #80; it never executes twice. This one-time incompatibility is accepted in beta (ADR
0019, ADR 0025). Matching the old fingerprint as well was rejected: the old value hashed the
snapshot of the deployment that wrote the row, which the row does not store, so core could
reproduce it only by guessing earlier snapshots (for example the previous ABI suffix under the
same schema and policy), a legacy path for a window that closes with the retention of those
rows. Answering an unknown outcome instead of a conflict for such rows was rejected for the
same reason: a row cannot tell a changed body from a changed snapshot.

## Consequences and evidence

- This is a breaking embedding API change. Legacy wrappers and unresolved retry windows
  require explicit migration. Compiler-only construction still needs no DB.
- The fixed deployment wrapper moved to `deploy/cloudflare/wrapper/`; the published
  execution library neither imports it nor reads fixed Turso env variables.
- Tests cover required inputs, no fallback despite legacy env credentials, no routing
  effect from JWT claims, two-DB isolation, callbacks, retries, rollback, revocation,
  snapshot changes, and owner loss.
- The library cannot independently identify the physical DB behind a trusted custom
  transport. Registration and conformance are wrapper obligations.
- Real Cloudflare/Turso acceptance remains a separate release gate.

See [the complete contract](../database-routing.md). Request-rate limiting follows the same
boundary and is also a wrapper responsibility
([ADR 0018](0018-wrapper-owned-rate-limiting.md)).
