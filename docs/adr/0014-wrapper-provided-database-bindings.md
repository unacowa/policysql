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
`DatabaseBinding` as its fourth argument. No selection callback or JWT routing claims
exist in this library API. Policy session authentication remains a separate gateway concern.

Missing providers fail at construction. Missing per-request bindings fail with
`POLICYSQL_DATABASE_REQUIRED` before any database work. Fixed-env fallback is removed;
connection options must be explicitly supplied even to the Turso HTTP adapter.

PolicySQL pins the validated binding across transactions, DO delegation, callbacks,
cost observations, and retries. The DO provider resolves local credentials for the exact
binding supplied by the wrapper. `fetchCallback` accepts only the capability-protected
callback route and uses the binding already owned by that transaction.

Idempotency key identity includes scope/database identity; its fingerprint also includes
generation/snapshot. Credentials do not affect retry identity. Database identities must
never be reused for another physical DB. Schema compatibility, route retirement, and
cross-DB migration of unresolved writes remain wrapper responsibilities.

SQL authorization, rewriting, verification, and result validation remain in Rust as
required by ADR 0011. The TypeScript wrapper is trusted deployment code that supplies
transports for one compatible immutable runtime snapshot. It does not construct raw
public SQL execution paths or change backend profiles per request.

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

See [the complete contract](../database-routing.md).
