# Phase 5 concerns: types and clients

## Decisions

- Logical type, JSON representation, format, constraints, SQLite storage, and nullability are separate contracts.
- Physical introspection and a versioned Catalog manifest compile into one immutable logical catalog.
- Public Catalog is role- and operation-specific and includes select usage, insert requiredness, update inputs, and mutation returning outputs.
- Query result metadata remains mandatory because expressions and aliases cannot be described by base Catalog alone.
- INTEGER defaults to string-represented int64; dates, booleans, JSON, UUIDs, and safe-number refinements require explicit metadata.
- Kysely generation excludes conditional output columns from ordinary table types and exposes them through `policySelect`.
- Static query parameter/result types are generated online by the authoritative Explain compiler; normal TypeScript compilation and runtime remain offline.

## Residual risks

- Existing SQLite data may violate a newly activated logical contract. Activation should scan where feasible, but runtime validation must still fail closed.
- Custom logical types and formats can fragment client compatibility. Drivers need explicit unknown-type behavior and registry version checks.
- JavaScript `number` cannot represent all SQLite integers. Any conversion from int64 string requires an opt-in range check.
- Kysely raw SQL and TypeScript casts bypass compile-time ergonomics, never gateway authorization.
- Result metadata adds response bytes. It is intentional protocol data and must be included in result-byte accounting.
- Online regeneration depends on gateway availability and a narrowly scoped build credential. Checked-in or cached artifacts keep ordinary builds independent, but must never bypass snapshot staleness checks.

## Implementation checks

- Hash physical schema, manifest, and registries into `schemaVersion` deterministically.
- Reject duplicate resource/column names and incompatible type/representation/format/constraint combinations.
- Validate every non-null adapter value against the compiled descriptor before encoding.
- Generate independent Selectable, Insertable, Updateable, Returning, and conditional-output projection types per role.
- Test zero-row expression typing, outer-join nullability, CASE unification, aggregate nullability, unknown formats, and stale generated types.
- Test role/snapshot/endpoint cache isolation, `SELECT 1`, parameter inference failure, partial-generation rollback, and build-token denial on execute endpoints.
