# Phase 3 concerns: SQL and policy

## Decisions

- Policy predicates use a closed, recursively defined operator language; generic SQL fragments and relationship predicates are excluded.
- Structural JSON Schema validation is followed by Catalog-aware semantic validation.
- The published user contract authorizes JOIN through per-resource select policies and regular-column permissions, and gates aggregate/window use with default-false booleans. Deployment Capabilities remain runtime upper bounds only; ADR 0012's finer-grained proposal was rejected.
- Preset and client-write columns are disjoint. Client attempts to provide preset columns are rejected, not overwritten.
- Operation checks apply to every changed row, succeed only on SQL TRUE, and pass vacuously for zero changed rows.
- Cross-resource, aggregate, subquery, or application-code invariants use commit checks.

## Residual risks

- Correct row-filter placement for outer joins is compiler-sensitive and requires differential tests for NULL-extension behavior.
- Correlated subqueries and CTE provenance remain high-risk even with conservative shadowing rules. Unsupported AST shapes must fail closed.
- Projection permission must not imply GROUP BY, HAVING, aggregate, window partition, or window ordering permission. Missing allowlist entries must fail closed before executor call.
- Query cost is not controlled by aggregation permission. Runtime time, scan, group, row, byte, depth, and expression limits remain mandatory.
- SQLite trigger side effects cannot be authorized by statement rewriting and therefore remain outside supported public mutation semantics.

## Implementation checks

- Give every accepted AST node positive, negative, bypass, and SQLite differential fixtures.
- Bind identifiers before applying policy and track provenance through every expression and output.
- Compile multi-row checks into the mutation or validate atomically from captured post-state; never use a racy check-then-write sequence.
- Re-parse emitted SQL and prove every base-resource access, server parameter, preset, and returning expression.
- Property-test predicate schema/parser agreement, including FALSE and UNKNOWN behavior.
