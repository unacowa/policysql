# External commit checks

Commit checks delegate transaction-wide integrity validation to trusted external code after all statements and mutation-level operation checks have completed, but before commit.

## Principles

- PolicySQL owns the Turso transaction for the entire validation phase.
- The external validator may issue SELECT statements through PolicySQL against that same transaction.
- Callback SELECT statements pass through the normal parser, binder, policy compiler, emitter, and invariant verifier.
- The configured role is policy-owned. If omitted, the initiating role is inherited. If present, it may intentionally elevate privileges independently of JWT allowed roles.
- The validator cannot select a role, mutate data, commit, or roll back.
- Callback authentication uses a short-lived opaque capability stored in transaction state, not a JWT.
- Timeout, malformed messages, authentication failure, query rejection, owner loss, or transport failure roll back the transaction.
- Validators must be side-effect free because MVCC conflicts may cause replay.
- Checks trigger only for configured resources with at least one changed row and run serially in ascending check-identifier order.
- Callback query retries are idempotent only for the immediately completed sequence with an identical payload.

## Lifecycle

```text
begin transaction
  -> execute statements
  -> run operation checks
  -> enter validating phase
  -> invoke external validator
  -> execute scoped callback SELECT statements
  -> receive allow or deny
  -> commit or rollback
```

The old pre-execution validation hook does not exist. Single mutations and multi-statement transactions use the same commit-check lifecycle.

## Transaction owner

Core code depends on a transaction-owner abstraction capable of serializing commands and routing callback queries to the owner of the open Turso transaction. It must not depend directly on Cloudflare APIs.

The first Cloudflare Workers adapter uses one Durable Object per transaction. Native and server deployments may use an in-process registry, sticky routing, or another coordinator that preserves owner affinity.

Loss of the owner or connection is terminal. An open transaction is never reconstructed on another connection.

## Security boundary

The external validator is trusted application code but is still constrained to SELECT statements and the configured role's resource policies. Explicit privileged-role execution is intentional system authorization because the role comes from immutable policy, not client or hook input.

The opaque callback capability is random, single-session, read-only, short-lived, stored hashed, and revoked before commit or rollback. Database credentials, Turso connection state, client JWTs, and server-owned SQL are never delegated.
