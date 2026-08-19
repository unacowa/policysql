# PolicySQL implementation progress

This ledger records verified progress against `implementation-plan.md` and
`operational-deployment-implementation-plan.md`. A milestone is complete only when its exit gate
is satisfied; code presence alone is not completion.

## Current focus

User-document conformance: close one externally visible contract difference at a time with
regression, bypass, protected-egress, and differential evidence before advertising it.

## Milestones

| Milestone | Status | Evidence |
| --- | --- | --- |
| 0. Test contract first | complete | SQL surface registry, strict fixture manifests, digest-bound execution evidence, coverage checker, recording executor, negative controls, JSON/Markdown reports, and twenty-one fixture pairs verified |
| 1. Backend-neutral core and sealed execution | complete | Stable identities, logical Catalog, string-only trusted session, parameter namespaces, bound IR, protected plan, opaque verified plan, and profile-typed Turso boundary verified |
| 2. SQLite parser and single-table binder | complete | Turso parser 0.7.2, exact statement count, initial SELECT subset, source range, parameter discovery, stable binding, logical typing, limits, and fail-closed unsupported nodes verified |
| 3. Policy loading and SELECT compiler | complete | Catalog-aware immutable activation, closed typed predicates, role/resource selection, column-context authorization, row-filter/limit composition, and independent fixture oracle verified |
| 4. SQLite emission and structural verification | complete | Protected IR is converted to `turso_parser` statement/expression nodes, SQL is emitted only by `ToTokens`, emitted SQL is reparsed and compared as an AST, and parameter/result/snapshot/profile plus mutation negative controls are verified |
| 5. Explain, oracle, reference execution | complete | Verified initial fixture executes against in-memory SQLite with exact descriptor/storage-class and row/byte validation; independent policy oracle agrees |
| 6. Gateway without Turso dependency | partial / reopened | Library orchestration is verified; concrete HTTP listener, request/response codecs, JWKS adapter, and real HTTP fixtures remain |
| 7. Turso executor profile | partial / reopened | Typed ports and result validation are verified; concrete remote transport, enforced timeout, usage metrics, and remote conformance remain |
| 8. Read surface expansion | complete | ORDER BY columns/projection aliases, LIMIT/OFFSET, IN/NOT IN, IS NULL/IS NOT NULL, LIKE/GLOB, registered LOWER/UPPER/JSON_EXTRACT, policy-filtered JSON_EACH/JSON_TREE collection, INNER/LEFT JOIN, filtered provenance-preserving derived/CTE, correlated EXISTS, gated COUNT/GROUP/HAVING, and gated ROW_NUMBER have positive/negative/bypass/differential fixtures, golden SQL, reference SQLite execution, and advertised coverage |
| 9. Mutations and transaction integrity | complete | INSERT/UPDATE/DELETE, independent RETURNING authorization, presets, row filters, TRUE-only operation checks, cardinality expectations, sealed mutation plans, owned transactions, read-only callbacks, rollback/commit failure injection, and differential fixtures verified |
| 10. PostgreSQL profile readiness | out of initial Goal scope | ADR 0011 defines the boundary; no profile is advertised |
| D0. Operational ledger | complete | Compiler and deployment completion are separate; release artifacts are required |
| D1. Worker and Rust/Wasm ABI | complete | Persistent package, ABI v1, current Wrangler dry-run artifact 1,730.19 KiB raw / 589.68 KiB gzip with Durable Object, startup-safe lazy activation |
| D2. Immutable config and JWT | complete for development issuer | ES256/RS256 allowlist, issuer/audience/time/access/role/session validation, encrypted Worker secrets |
| D3. Catalog/Capabilities/Explain | complete for advertised surface | Real authenticated curl acceptance on the persistent Worker; Explain performs no query execution |
| D4. Remote Turso SELECT | complete for advertised surface | Protected-SQL-only atomic batch, real Turso execution, Rust raw-result validation, timeout and result limits |
| D5. Cost observation | complete for advertised surface | `EXPLAIN QUERY PLAN` commands are constructed in the Rust AST, run after the response, and logged with versioned conservative Catalog bounds; unstable planner prose is never parsed or used as an authorization gate |
| D6. Atomic mutations | complete for advertised surface | Real Turso INSERT/UPDATE/DELETE, in-transaction post-state validation, persistent identity-bound idempotency replay/conflict gates pass |
| D7. Interactive transactions | complete for advertised surface | Durable Object owns the Turso baton; auth/session fingerprint, monotonic sequence, exact retry, commit/rollback retention, expiry and owner-loss fail-closed tests pass. Capabilities advertises adapter support and separately reports `commitChecksConfigured: false` until the deployed policy activates a hook |
| D8. Operations/hardening | complete for development deployment | Hashed issuer/IP/subject/role/tenant rate key, invocation and safe structured logs, exact Turso usage, 50 ms CPU cap, secret rotation, alert thresholds/runbook and version-pinned rollback drill |
| D9. Release acceptance | complete for development deployment | Persistent Worker/Turso URL passes health, Catalog, Explain, fourteen-statement advertised read-surface execution, seven-statement mutation rollback, deny, join-bomb, mutation/idempotency and interactive exact-retry/commit gates; release artifact records runtime and acceptance |

## Milestone 0 evidence

- `tests/sql-surface/sqlite-v1.yaml` classifies the initial SQLite surface as planned or disabled; nothing is advertised prematurely.
- `tests/sql-surface/threats.yaml` gives stable IDs to the first bypass classes.
- `tests/schemas/sql-surface.schema.json` and `tests/schemas/fixture-case.schema.json` publish the manifest contracts.
- `policysql-testkit` rejects duplicate IDs, unknown coverage IDs, profile mismatches, incomplete fixture pairs, malformed deny expectations, and uncovered advertised leaves.
- `coverage-check` writes reviewable Markdown and CI-oriented JSON artifacts beneath `target/policysql-test-coverage/sqlite-turso-v1`.
- Twenty-one self-contained fixture pairs cover the initial security cases, expanded reads, JSON collections, typed projections, subquery/CTE forms, and all three mutation operations.
- Missing advertised coverage, incomplete allow pairs, and incomplete deny proofs each have a failing negative-control test.
- The specification validator checks both new JSON Schemas, both surface documents, and all five compiler fixture manifests.
- Strict workspace Clippy and all workspace tests pass after the initial implementation.

## Assumptions recorded

- Only leaves with complete compiler/verifier/fixture evidence are `advertised`; unproven grammar remains `planned` or `disabled` and fails closed.
- `common` threat IDs may be covered by any backend profile, while dialect-specific surface IDs must match the fixture profile.
- Canonical protected SQL golden files are review artifacts; semantic plan assertions and second-pass verification become the security assertions in milestones 4 and 5.
- Rust crates are trusted compiled code. The sealed-plan constructor always invokes a matching `PlanVerifier`; profile marker and private fields prevent executors and transport adapters from accepting or mutating raw candidates.

## Milestone 1 evidence

- `policysql-core` now owns stable resource, column, policy, snapshot, and backend-profile identities.
- Trusted session values are strings only and client-supplied reserved keys are rejected, matching ADR 0005.
- Client and server parameter names are distinct types; client names reject the reserved prefix.
- `policysql-catalog` provides immutable backend-neutral resolution with case-collision rejection.
- `policysql-ir` contains project-owned bound expressions and protected plans without parser or driver types.
- `policysql-execution` seals candidates only after profile match and verifier success.
- Compile-fail doc tests prove that verified-plan fields are private and a PostgreSQL-marked plan cannot cross the Turso boundary.
- The Turso boundary no longer accepts a raw SQL request and no longer uses SQLite-owned value types.
- Strict Clippy, workspace tests, and compile-fail doc tests pass.

## Milestone 2 evidence

- Production `policysql-parser` uses the parser version proven by the feasibility spike rather than the placeholder parser.
- Exactly one SELECT is required; all other statements and multiple statements fail closed.
- The accepted shape is one base resource, explicit direct-column projections, the closed initial boolean subset, and non-negative literal or named-parameter LIMIT.
- Every accepted column becomes a stable `ColumnId` with projection or filter usage and a logical type.
- Named parameters are discovered and typed from bound usage; positional, reserved, unsupported-prefix, and unprovable parameter forms are rejected.
- Source range, projection count, distinct parameter count, and expression depth are recorded or bounded.
- Star, JOIN, CTE, compound, ORDER, GROUP, WINDOW, derived projection, implicit rowid, unknown resource/column, duplicate result name, NULL comparison, and negative LIMIT controls are rejected.
- The `turso_parser::ast::Expr` 0.7.2 inventory is pinned in the SQL surface registry so parser upgrades produce a reviewable classification diff.
- Production binder tests consume the same SQL files used by the security fixture pairs.

## Current release boundary

- `policysql-gateway` compiles SELECT and mutations through the same pinned snapshot and routes mutations only through the owned-transaction API.
- `policysql-turso` exposes profile-typed read and transaction transports; concrete deployment code supplies embedded or remote driver handles without receiving arbitrary SQL.
- The Cloudflare deployment supplies JWT/HTTP adapters, direct Turso HTTP transport, exact billing metrics, post-response conservative cost observation, and Durable Object transaction ownership without adding a raw-SQL execution path.
- The Cloudflare online subset now connects the compiler-proven INNER/LEFT JOIN, filtered provenance-preserving CTE/derived source, correlated EXISTS, gated COUNT/GROUP/HAVING, gated ROW_NUMBER, LIKE/GLOB, registered LOWER/UPPER/JSON_EXTRACT, typed CASE/concatenation/TEXT CAST, JSON collection, projection-alias ordering, LIMIT/OFFSET, and Durable Object-owned external commit checks to protected Turso egress. PostgreSQL remains a separate future backend profile.
- Cloudflare egress tests prove positive protected SQL for those SELECT variants and zero Turso calls when a joined resource policy, `allow_aggregations`, `allow_windows`, or a referenced-column permission is missing.

## Milestone 3 evidence

- Policy bundles are deserialized with unknown-field denial and activated immutably against stable Catalog identities.
- Unsupported mutation metadata and aggregation/window gates fail closed before any policy becomes usable.
- Missing resource/role policy denies; regular and conditional columns are enforced in every currently accepted usage context.
- Policy predicates use a closed, typed operator set and trusted-session values become server-owned parameters.
- Caller and policy predicates are composed with AND, while the effective limit is the stricter caller/policy value.
- An independently implemented three-valued oracle agrees with the initial differential fixture for visible and hidden tenants.

## Milestone 4 evidence

- The production emitter walks typed protected IR and resolves every table/column name from Catalog IDs.
- Compiler aliases, identifier quoting, client/server namespaces, literal allocation, and output ordering are deterministic.
- The production emitter constructs only `turso_parser::ast` nodes; identifier quoting and SQL token layout are delegated to the pinned parser library.
- Emitted SQL is parsed again and must be exactly one ordinary statement of the expected operation before the candidate can be sealed.
- The verifier compares the reparsed statement with the protected statement structurally, then checks operation, profile, snapshot, exact parameter ownership sets, mutation invariants, and result descriptors.
- Negative controls for statement addition, projected-column replacement, parameter replacement, and policy weakening all fail verification.
