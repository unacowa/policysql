# Phase 4 concerns: transactions

## Decisions

- `POST /v1/transactions:execute` is the only stateless SQL endpoint. Its `statements[]` contains one or more scalar SQL items and its response always contains ordered `results[]`.
- Transaction mode is inferred from all bound statements. Clients do not provide atomic mode or statement IDs; errors and results use array indexes.
- Interactive flow remains scalar and sequenced because later statements may depend on earlier results.
- Every public write entry point requires a scoped idempotency key and canonical payload hash.
- Interactive and callback commands support safe retry of the immediately completed sequence only when the payload is identical.
- Commit checks run after all statements, only for resources with changed rows, in deterministic check-name order.
- A policy-owned callback role may elevate independently of caller roles. The initiating trusted session is retained.
- Callback authentication uses a per-check opaque capability, not JWT or database credentials.

## Residual risks

- Turso engine variants may differ in conflict detection, transaction lifetime, and read-your-writes behavior. Each advertised adapter needs conformance tests.
- External validation extends transaction duration and raises conflict/timeout probability. Multiple checks are serialized intentionally.
- Commit checks do not provide serializable predicate locking or atomicity with external services. Guard rows, database constraints, and outbox patterns remain necessary.
- Idempotency records contain request hashes and response data. Retention, encryption, tenant isolation, capacity bounds, and deletion are operational security requirements.
- Owner loss is terminal. Edge adapters must not reconstruct a transaction on another connection.
- A large atomic request buffers multiple results until commit. `maxStatements`, result-row, result-byte, execution-time, and transaction-duration limits must be enforced cumulatively.
- The array-only response adds one level for a single query. Official clients hide this in scalar query APIs while retaining access to the complete transaction response.

## Implementation checks

- Canonicalize request hashes without including hop-by-hop headers and bind them to issuer, subject, role, and endpoint.
- Persist terminal idempotency state before acknowledging success.
- Keep one owner for client statements, callback SELECTs, checks, and final commit; serialize all commands.
- Test response loss before and after commit, duplicate sequence, conflicting payload, expiry, owner loss, hook replay, and multi-check ordering.
- Count callback queries and bytes against stricter commit-check-specific and transaction-wide limits.
- Compile and authorize every item, infer mode, and validate mutation idempotency requirements before opening the database transaction.
- Test empty arrays, statement smuggling inside one `sql` field, mixed read/write mode inference, index mapping, cumulative limits, and rollback without partial results.
