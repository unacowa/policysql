# ADR 0017: NULL named parameters in direct nullable assignments

- Status: accepted
- Issues: #20, #21

## Context

The Catalog describes nullable columns, but request validation matched every
client value against a non-null logical type before considering where the value
is used. A JSON `null` therefore could not clear a nullable column through the
normal SQL HTTP API, and SQL `NULL` literals are outside the accepted subset.
Omitting the column, `""`, `0` or a JSON document containing `null` are not
substitutes for storing SQL NULL. #21 consolidated client parameter analysis into
one bound-tree pass that already computes a conservative per-parameter NULL proof,
but left acceptance unchanged.

## Decision

A named client parameter whose value is JSON `null` binds SQL NULL only when the
#21 proof holds: every occurrence of the parameter in the bound statement is the
whole value of a direct `INSERT ... VALUES` or `UPDATE ... SET` assignment to a
Catalog column declared `nullable: true`. This applies to every logical type,
bytes and json included. For a json column JSON `null` means SQL NULL, not the JSON
text `null`.

- Any other occurrence makes the parameter non-nullable: comparisons, `IN`,
  `LIKE`/`GLOB`, functions, `CASE`, `IS NULL`, projections, ordering, `LIMIT`,
  `OFFSET`, nested reads, and assignment values that are expressions. Reusing the
  parameter in a non-nullable assignment also denies NULL. Unresolvable column
  identities deny NULL.
- The proof is statement-wide and never depends on the supplied value or on the
  first occurrence encountered. The existing one-type-per-parameter rule still
  applies first. Non-NULL values keep their type, format and constraint checks.
- A rejected NULL fails exactly like any other invalid parameter value
  (`POLICYSQL_INVALID_PARAMETER`, 400), before any database egress.
- The decision lives in the shared SQLite compiler (`validate_client_parameters`
  inside `compile_verified_*`), so every gateway caller enforces it. Hosts decode
  JSON `null` to SQL NULL for every type and leave the decision to the compiler.
- SQL `NULL` literals and NULL inside expressions remain unsupported. Stored NULLs
  are queried with `column IS NULL`, unchanged.

Explain reports the same proof. The gateway returns the parameter contracts that
the compiler validated against the protected statement, and the parameter
descriptor's `nullable` is that proof for every type. Omitting values (`params:
{}`) uses SQL NULL as the placeholder for a proven-nullable parameter and a
non-NULL typed placeholder otherwise. A supplied sample is validated like an
execute value: a NULL sample for a non-nullable parameter is rejected with
`POLICYSQL_INVALID_PARAMETER` rather than ignored, and a NULL sample for a
nullable parameter does not change any descriptor.

## Security

Client and server-owned parameter namespaces stay separate; presets and server
parameters cannot be overridden, and preset or non-writable columns remain
forbidden assignment targets whatever their nullability. Column permissions,
tenant filters, independent `RETURNING` permission, emitted-SQL reparse and the
second invariant check are unchanged: the NULL travels as an ordinary bound client
parameter, so the protected SQL text and parameter-name set are the same as for a
non-NULL value.

Post-state checks keep TRUE-only semantics. The emitter folds each check into
`CASE WHEN <check> THEN TRUE ELSE FALSE END` and the adapters accept only exact
TRUE. A NULL written to a column makes comparisons such as `neq`, `not_in` or
`not: { eq }` UNKNOWN, and UNKNOWN fails exactly like FALSE, so NULL cannot make a
check pass that would otherwise fail. Checks that are TRUE for NULL, such as
`is_null: true` or an `or` whose other branch is TRUE, pass. Physical `NOT NULL`
violations, trigger failures and later statement failures roll back all earlier
writes; replay reproduces NULL results.

## Validation

Native tests cover acceptance equal to the proof, every logical type, rows and
columns sharing one parameter, forbidden, preset and tenant columns, and policy
checks evaluated by an independent SQLite database on the NULL-assigned row
(`crates/policysql-sqlite/tests/parameter_contracts.rs`,
`crates/policysql-testkit/tests/nullable_assignments.rs`). The shared fixture
`tests/fixtures/nullable` (the issue example) runs at the WASM ABI and through real
WASM, JWT, HTTP and SQLite, including Explain, rollback, idempotent replay and
interactive transactions. This local evidence does not establish real Turso
deployment conformance.
