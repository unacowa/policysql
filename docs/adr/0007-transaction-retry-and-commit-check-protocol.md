# ADR 0007: Transaction retry and commit-check protocol

- Status: accepted

## Context

Edge and HTTP clients can lose a response after a database action has completed. Sequence-only rejection makes a safe retry impossible, while unrestricted retries can duplicate writes. External commit checks also require deterministic ordering and same-transaction reads without exposing a database connection.

## Decision

Every public write entry point requires an `Idempotency-Key`. The key is scoped to authenticated issuer, subject, selected role, and endpoint. PolicySQL stores a canonical request hash and terminal response for the advertised retention period. Reusing a key with the same payload returns the stored result; a different payload is rejected. A request already executing returns a retryable in-progress response and never starts a second execution.

Interactive transaction start uses the same rule. Each statement, commit, and rollback has a monotonic sequence. Retrying the immediately completed sequence with an identical canonical payload returns its stored response. Reusing a sequence with a different payload, skipping a sequence, or concurrently submitting different commands fails and rolls back an active transaction. Terminal commit and rollback responses remain queryable by repeating the identical terminal command during retention.

Commit checks trigger only when an operation actually changes at least one row in a configured resource. Triggered checks execute sequentially by ascending check identifier. Each gets a distinct short-lived callback capability. Callback SELECTs are processed serially and use the same response and retry rule as transaction statements. Callback role is immutable policy data; trusted session remains the initiating session.

The callback capability authorizes only policy-compiled SELECT against the owned open transaction. It cannot mutate, choose a role, commit, roll back, or obtain credentials. Owner loss, timeout, deny, malformed protocol, or query failure rolls back.

## Consequences

- Clients can resolve ambiguous network outcomes without duplicating writes.
- Idempotency storage is security and availability state and must be bounded, encrypted as appropriate, and retained at least as long as advertised.
- Validators can inspect any resource visible to the configured role, including unchanged tables and uncommitted post-state, without receiving raw SQL or a database connection.
- Multiple validators increase transaction hold time because checks and callback queries are serialized.
