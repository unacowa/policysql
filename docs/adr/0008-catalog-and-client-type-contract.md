# ADR 0008: Catalog and client type contract

- Status: superseded in part by ADR 0013

## Context

SQLite storage classes do not express application-level dates, UUIDs, JSON formats, safe integers, or role-specific read/write permissions. Query results can also contain expressions with no base column. Client generators need stable input and output contracts without treating generated types as authorization.

## Decision

The compiled logical catalog combines physical schema introspection, an administrator-owned Catalog manifest, and versioned type/format/function registries. Storage, logical `type`, JSON `representation`, optional `format`, and constraints are separate fields.

The role-visible public Catalog publishes operation-specific contracts:

- select columns with usage contexts and `nullableOnDenied`;
- insert columns with `required` and value descriptors;
- update columns with value descriptors;
- independently authorized returning columns for each mutation.

Columns absent from an operation contract are unavailable for that operation. Preset-only and policy-internal columns need not be disclosed. Query-local `meta.result.columns` remains authoritative for aliases, expressions, joins, aggregation, and final nullability.

SQLite introspection derives only conservative defaults: TEXT to string, REAL to number, INTEGER to string-represented int64, and BLOB to base64 bytes. ANY or incompatible declarations require an explicit manifest entry. Date, datetime, instant, boolean, JSON, UUID, and safe-number refinements are never inferred from a name or declared type alone.

Function signatures include argument descriptors, result descriptor rules, nullability, and volatility. Volatility is separate from type: stable statement-time functions such as `datetime('now')` may be allowlisted without pretending they are immutable.

Role-specific Kysely generation excludes conditional output columns from ordinary table interfaces and exposes them through a dedicated projection helper. Generated types improve ergonomics but the gateway always revalidates SQL.

## Consequences

- Insert and update typing no longer has to be guessed from select permissions.
- Manifest changes and registry changes participate in `schemaVersion`.
- Runtime result validation detects physical data that violates the compiled logical contract.
- Client generators must support unknown logical types through known representations or fail explicitly.
