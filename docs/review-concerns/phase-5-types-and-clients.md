# Phase 5 concerns: types and clients

## Decisions

- Logical type, JSON representation, format, constraints, SQLite storage, and nullability are separate contracts.
- Physical introspection and a versioned Catalog manifest compile into one immutable logical catalog.
- Public Catalog is role- and operation-specific and includes select usage, insert requiredness, update inputs, and mutation returning outputs.
- Query result metadata remains mandatory because expressions and aliases cannot be described by base Catalog alone.
- INTEGER defaults to string-represented int64; dates, booleans, JSON, UUIDs, and safe-number refinements require explicit metadata.
- Conditional output columns must not be treated as ordinary filterable columns by generated types. The former `policySelect` wrapper is removed; standard projections remain subject to gateway validation and expose redactions through `policyOptions({ onResponse })`.
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

## Kysely Spec #6 implementation evidence

The implementation follows [Spec #6](https://github.com/unacowa/policysql/issues/6).
Kysely 0.29.5 uses the standard Dialect, SQLite compiler, Driver and Connection interfaces.
The public client requires an application-supplied function Transport; optional role selection and paired version
preconditions remain gateway-validated. The old Proxy wrappers are removed; see the
[migration table](../../website/clients/kysely.md#旧-api-からの移行).

| Acceptance conditions | Evidence |
| --- | --- |
| AC-01–04: minimal configuration, role selection, versions, invalid input | `packages/client/client.test.mjs`, `packages/type-tests/public-api.ts`, and the JWT/Wasm/SQLite role and snapshot cases in `deploy/cloudflare/test/kysely-client.test.mjs` |
| AC-05–08: standard results/plugins, isolated options and metadata, expect | `packages/kysely/kysely.test.mjs` exercises real Kysely, shared query IDs, compile-only calls, invalid plugin order and mutation counts; integration tests verify rollback on expect mismatch and raw redaction indices before result transforms |
| AC-09–12: optional atomic keys and interactive transactions | Client/Kysely key tests plus real SQLite deduplication, missing-table errors, callback/controlled commit/rollback, commit checks and validator post-state visibility in the integration tests |
| AC-13–17: retries, ambiguity, unsupported features, limits, cleanup | Single-attempt begin/statement/commit/rollback, explicit exact-command confirmation, failed/malformed responses, original exception retention, destroy during begin/commit, cleanup after a completed rollback, server-owned expiry and application-owned timeout; integration tests cover commit response loss and validator rejection during destroy, owner loss, binding revocation, snapshot changes, statement/result limits and unchanged committed state |
| AC-18: generator and migration | `packages/generator/generator.test.mjs` verifies role headers, version-pinned generated execution and preservation of output on stale generation; the migration table lists removed APIs and wrapper types |
| AC-19: public API, examples and docs | Strict public-package type tests, `examples/database-routing/client.mjs` executed by the Kysely tests, docs/spec validation and package contents/import checks |

Local verification uses real Kysely, the gateway's JWT verifier, Rust/Wasm policy compiler,
transaction-owner implementation and SQLite. Cloudflare storage/routing and the remote
Turso HTTP server are simulated. Live Cloudflare/Turso deployment, eviction and network
conformance have not been certified by these tests. No Rust/SQL compiler behavior changes
are included in this work.

The strictest reading of AC-07 (detect every possible later AST replacement before HTTP)
is not enforceable through the standard Dialect/Plugin interfaces alone: the Dialect has
no plugin-registration hook, and an arbitrary later plugin can discard the entire tree.
The implementation detects ordinary AST transformations, spreads that drop the modifier,
cloned/lost tokens, duplicates and nested options. It requires `policyOptions` last;
complete replacement by a later custom plugin is unsupported and documented. Enforcing
plugin registration itself would need a separate construction API and a Spec decision.

Metadata observers follow normal Promise completion without a library timeout. Kysely
holds its connection until the observer returns: awaiting another statement on that same
transaction inside the observer is unsupported and can wait indefinitely. Run dependent
SQL after awaiting the outer query. Observer failures never replay committed atomic updates.
