# ADR 0011: Use versioned backend profiles for multi-database support

- Status: accepted

## Context

PolicySQL initially targets SQLite-compatible SQL and Turso/libSQL. A future deployment may need to protect PostgreSQL or another relational database without duplicating policy semantics or weakening the default-deny compiler boundary.

A database target is more than an execution transport. SQL grammar, identifier resolution, parameter syntax, functions, logical-to-physical type mapping, collation, mutation forms, transaction behavior, result decoding, and error behavior can differ by engine. Replacing only the Turso transport while continuing to use SQLite parsing, emission, or verification would create an unsafe mixed-dialect pipeline.

ADR 0002 remains the decision for the initial public API: the first backend profile accepts a strict SQLite SQL subset. This ADR defines how later, versioned profiles may introduce another public SQL dialect without silently broadening the SQLite contract or adding implicit cross-dialect transpilation.

## Decision

### Backend profile is the deployment unit

PolicySQL groups all dialect- and engine-specific behavior into one immutable, versioned backend profile. A profile contains compatible implementations of:

- public SQL dialect and accepted syntax capabilities;
- parser integration and dialect-specific syntax validation;
- Catalog introspection and physical-type mapping;
- binder dialect rules, including identifier and parameter semantics;
- function, operator, collation, cast, and type registries;
- protected SQL emitter;
- emitted-SQL parser and invariant verifier;
- parameter and result-value codecs;
- database executor and transaction adapter;
- engine conformance metadata and enforced limits.

The gateway selects one configured backend profile for an endpoint or deployment. A public request cannot select a parser, emitter, verifier, executor, dialect, or database independently. It also cannot switch backend profiles inside an atomic or interactive transaction.

The profile identifier and version participate in the pinned request snapshot, capabilities response, Explain metadata, audit record, idempotency binding, and generated-artifact identity.

### Backend-neutral policy kernel

The following concepts remain owned by backend-neutral Rust crates:

- stable resource and column identities;
- logical Catalog descriptors;
- trusted-session and role model;
- policy selection by resource, role, and operation;
- closed policy predicate language;
- row and column permission semantics;
- preset ownership;
- operation-check and commit-check requirements;
- result identity and redaction semantics;
- authorization and Explain trace vocabulary;
- common resource-limit and safe-error categories.

Parser-library ASTs and database-driver values do not enter this backend-neutral model. A project-owned bound relational representation records proven resource and column provenance, logical types, expression behavior, and operation intent. It contains no unvalidated SQL fragments.

The policy kernel produces a protected relational plan. A backend profile lowers that plan to its SQL dialect and proves dialect-specific invariants before execution.

### Typed verified execution plans

An executor accepts only an opaque verified execution plan produced by the matching backend profile. It does not accept an arbitrary SQL string through the internal execution port.

Verified plans are associated with a dialect/profile marker and contain at least:

- protected SQL or a driver-native equivalent;
- separated client and server-owned parameters after validation;
- result descriptors and runtime validation rules;
- operation-check and transaction requirements;
- resource limits;
- policy, Catalog, registry, compiler, and backend-profile fingerprints.

A plan produced by one profile cannot be submitted to another profile's executor. Constructors and fields that would permit bypassing emission verification remain private to the compiler and profile implementation.

If a verified plan crosses a process or WASM boundary, that boundary is trusted infrastructure. The receiver authenticates the producer and binds the plan to the request, trusted session, endpoint, and pinned snapshot. Protected SQL and server-owned parameters are never exposed to the public caller.

### Public SQL dialects

PolicySQL does not implicitly translate SQLite SQL into PostgreSQL SQL or the reverse. A deployment advertises exactly one public SQL dialect for an execution endpoint. Adding a PostgreSQL profile therefore adds a separately capability-gated PostgreSQL SQL subset; it does not broaden the SQLite profile.

An installation that exposes more than one dialect uses separate configured endpoints or deployments with independent capability and version identities. Atomic requests, interactive transactions, generated artifacts, and idempotency keys remain bound to one endpoint and one profile.

The policy metadata format remains portable where its closed operators have proven equivalent semantics. Backend-specific operators or functions require an explicit profile capability and must not change the meaning of the portable policy language.

### Rust and TypeScript boundary

The backend-neutral model, binder contracts, policy kernel, protected plan, emission verification, result descriptors, and transaction safety state machine remain authoritative Rust code.

TypeScript may implement generated clients, build-time generation through Explain, documentation tooling, and platform adapters such as a Cloudflare Worker or Durable Object host. A TypeScript platform adapter performs transport and platform lifecycle work; it does not reimplement policy selection, binding, SQL rewriting, or invariant verification.

If a TypeScript runtime hosts a Rust/WASM compiler, raw database results return through the Rust-owned result descriptor validation path before a public response is encoded. Moving any authorization decision into TypeScript requires a separate ADR and equivalent security, fuzz, and differential test evidence.

### Initial and future profiles

The initial profile is:

- public dialect: the documented SQLite subset;
- emitter and verifier: SQLite-compatible;
- executor: Turso/libSQL adapter;
- status: the only profile that may be advertised by the initial implementation.

A future PostgreSQL profile requires its own parser/binder coverage, Catalog adapter, emitter, independent verifier, executor, transaction tests, and SQLite-independent conformance fixtures before it can be advertised. Its existence does not imply that every policy or SQL capability is shared with the SQLite profile.

## Required module boundaries

The implementation should converge on boundaries equivalent to:

```text
policysql-core
  backend-neutral identities, logical types, snapshots, errors

policysql-ir
  project-owned bound relational representation and protected plan

policysql-policy
  backend-neutral policy validation and composition

policysql-frontend-sqlite
policysql-backend-sqlite
policysql-executor-turso

policysql-frontend-postgres       # future
policysql-backend-postgres        # future
policysql-executor-postgres       # future

policysql-gateway
  request orchestration using one configured backend profile
```

Exact crate names may change, but the dependency direction may not allow an executor or platform adapter to construct a verified plan, and backend-neutral crates may not depend on parser- or driver-specific types.

## Security requirements for a new profile

Every new profile or newly advertised capability requires:

1. positive, negative, bypass, and differential fixtures;
2. complete binder provenance for every accepted syntax node;
3. policy behavior defined for every accepted expression and operation context;
4. typed emission without unvalidated SQL concatenation;
5. re-parsing with the same public dialect and an independent invariant checker;
6. engine conformance tests for NULL, comparison, collation, cast, parameter, function, transaction, and result-codec behavior;
7. safe error normalization and resource-limit enforcement;
8. capability metadata that narrows to the actually proven intersection;
9. regression fixtures for every security fix;
10. evidence that a plan cannot be executed by a mismatched profile or without verification.

Unknown, ambiguous, unimplemented, or cross-profile behavior remains denied.

## Consequences

- PostgreSQL support is possible without copying the portable policy model.
- Adding an executor alone is intentionally insufficient to claim support for a new database.
- Parser, emitter, verifier, value codec, and transaction semantics cannot be accidentally mixed across dialects.
- The initial SQLite/Turso milestone remains narrow and unchanged.
- Backend profile versions become part of compatibility, cache, idempotency, audit, and generated-client contracts.
- Some SQL and policy capabilities will differ across profiles and must be advertised explicitly.
- Cross-dialect transpilation is not provided; clients target the dialect advertised by their endpoint.
- Additional traits and crate boundaries add implementation structure before a second backend exists, but prevent SQLite-specific types from becoming the permanent core model.

## Follow-up work

1. Move database-neutral logical and wire values out of the SQLite emitter crate.
2. Replace raw internal `ExecuteRequest { sql: String }` construction with an opaque verified-plan type.
3. Remove the Turso executor's direct dependency on SQLite-owned value types.
4. Introduce stable `ResourceId`, `ColumnId`, snapshot, and backend-profile identities.
5. Add backend profile and dialect identifiers to Capabilities, Explain, audit, and generated-artifact manifests before advertising a second profile.
6. Record PostgreSQL grammar, type, transaction, and conformance decisions in a separate implementation ADR when PostgreSQL enters the delivery roadmap.
