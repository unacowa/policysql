# ADR 0013: Result types are post-execution client metadata

- Status: accepted

## Context

PolicySQL still needs deterministic type derivation before database execution to validate parameters,
operators, functions, physical result values, and JSON representations. The public meaning of a query
result descriptor is narrower: it helps the client decode a successful response and is not an
authorization token or a promise that lets a client bypass request-time compilation.

SQLite JSON table functions can expose a finite set of logical types. A parameterized JSON path can
also select a narrower type when its value is supplied. The descriptor model therefore needs finite
unions without inferring types from the first returned row.

## Decision

The compiler continues to derive internal descriptors from the compiled Catalog, bound SQL,
operator/function signatures, and available request parameters before database execution. The
execution adapter validates every returned value against that descriptor. It never changes the
descriptor after inspecting database rows.

After successful execution, the gateway attaches the derived descriptor to
`results[].meta.result.columns` as client metadata. Drivers use it to decode the accompanying result.
It is not a client-side authorization boundary or an independently executable prepared contract.

Explain returns a prediction produced by the same compiler without executing SQL. For a
parameterized JSON path:

- without a path value, Explain returns the finite union of every type reachable in the Catalog JSON
  Schema;
- with a path value, Explain validates it and returns the same narrowed descriptor Execute would use;
- Execute always validates the supplied path and returns the narrowed descriptor after success.

Logical types may be finite unions. Public JSON represents a union as a stable, duplicate-free array
in `type`. JSON columns may carry a Draft 2020-12 Schema restricted to the closed subset documented
by the user guide. Public SQL remains a strict subset composed only of valid SQLite syntax;
`json_each`, `json_tree`, and JSON aggregates are used directly rather than through PolicySQL-only SQL
syntax.

## Consequences

- Empty result sets still have metadata because derivation does not depend on returned rows.
- Explain output is a prediction for generation and tooling; Execute recompiles and validates every
  request.
- Generated clients must accept an Execute descriptor that is a narrowing of an Explain union.
- Runtime value validation remains mandatory inside the trusted gateway.
- ADR 0008 and ADR 0010 remain valid for Catalog construction, credentials, versioning, and build
  workflow, but their description of query result descriptors as an authoritative pre-execution
  client contract is superseded by this ADR.
