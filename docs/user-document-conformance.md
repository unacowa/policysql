# User-document conformance ledger

This ledger compares the VitePress user documentation in `website/` with executable behavior.
The user documentation is authoritative. A row is complete only when its public schema, compiler,
adapter, and relevant HTTP response are backed by regression evidence.

## Closed in the current conformance loop

| Contract | Implementation evidence |
| --- | --- |
| Atomic limits apply per statement and cumulatively | Worker rejects cumulative rows, bytes, and elapsed time before commit and suppresses partial results |
| Conditional output distinguishes denied NULL from visible database NULL | Compiler-owned visibility companions are emitted, validated, stripped, and reported as cell redactions |
| SQL coverage is based on execution, not fixture declarations alone | Coverage checker requires digest-bound `executed-fixtures.json`; twenty-one fixture pairs execute before evidence is written |
| Execute requires concrete parameter values and types | Verified compilation rejects missing, extra, and mismatched client parameters |
| Explain may omit parameter values when use proves the type | Bound-expression traversal supplies typed placeholders only for Explain |
| Catalog JSON Schema accepts the documented Draft 2020-12 safe subset | Activation accepts the closed finite subset and rejects remote `$ref` |
| `IN`, `NOT IN`, `IS NULL`, and `IS NOT NULL` | Binder, policy compiler, AST emission/reparse, structural invariant check, negative control, and reference SQLite differential fixture pass |
| Mutation metadata reports operation-check state | Sealed plan exports only whether an operation check existed; Worker returns `passed` or `not_configured` after successful validation |
| Public SQL errors use the documented stable taxonomy | Parser, policy, parameter, limit, snapshot, authentication, and result-contract failures are normalized without resource or column detail; denied E2E cases prove zero database egress |
| Statement failures expose a safe RFC 6901 path | Gateway preserves the failing index and HTTP returns `/statements/N`; no resource, column, predicate, or parameter value is included |
| Explain publishes safe resource usage | Internal numeric IDs remain in the private compile/cost ABI; HTTP resolves role-visible Catalog names and client-referenced columns from bound provenance |
| JSON object/array parameters require a Catalog-proven JSON use | Binder-derived expected types are consulted before conversion; JSON values become lossless internal text only for `json` parameters and are rejected for scalar uses |
| Explain parameter descriptors come from compilation | Private ABI carries the verified logical parameter type, so missing-value placeholders are never reinterpreted as another type by JavaScript |
| Catalog build and value contracts | Deployment Catalog build captures `PRAGMA table_xinfo`, activation checks physical mappings and derives omitted basic types, compiled descriptors retain storage/format/constraints/JSON Schema, and both client parameters and remote results are revalidated |
| JSON path result typing | Execute uses the supplied SQLite JSON path to narrow the retained JSON Schema; missing-path Explain emits a stable finite logical-type union and remote rows are validated against that union |
| JSON table and collection queries | The closed SQLite-compatible `json_each`/`json_tree` plus `json_group_array(value)` shape retains root-column provenance, composes the row policy in the same SQL, returns exactly one JSON-array row with element Schema, and is covered by sealed SQL and reference-SQLite differential execution |
| Typed projection expressions and function registry | Searched `CASE`, string `||`, and `CAST(... AS TEXT)` have closed typed IR nodes; every input/branch is permission checked, converted to a SQLite AST, emitted by the parser library, structurally reparsed, and differentially executed, while the deployed function registry matches Capabilities (`count`, `lower`, `upper`, `json_extract`, `row_number`) |
| Subqueries and CTEs | Capabilities now names the accepted closed forms: qualified correlated `EXISTS`, transparent derived source, and one transparent/filtered nonrecursive CTE feeding an optional outer JOIN; each form has provenance, shadowing, row-policy, sealed-SQL, and reference-SQLite evidence |
| Cloudflare commit checks | Activated check metadata is exported only to the trusted adapter; Atomic Execute and interactive commit run sorted triggered checks in the owning Durable Object, sign HTTPS hooks, expose hashed short-lived SELECT-only capabilities, compile callback SQL through the gateway on the same Turso transaction, and roll back on deny, timeout, protocol/sequence error, callback failure, or owner loss |
| Constant `SELECT` | Resource-free numeric literal projections compile as a distinct default-safe IR, are AST-emitted/reparsed/verified, expose no fake resource or policy, and report `integer`/`number` descriptors |
| Generated TypeScript and Kysely boundary | `policysql generate` uses Catalog/Capabilities/Explain, pins snapshots and hashes, atomically replaces artifacts, and the client/Kysely packages route named SQL only through the gateway without database credentials |
| Development deployment SQL surface | The deployed Catalog and physical Turso schema contain the documented author/post/comment/archive resources; compile regression covers every advertised SQL family and the release gate executes fourteen read statements plus a seven-statement mutation/expectation rollback batch, then proves the probe row is absent |

## Remaining externally visible differences

None in the audited scope. Future backend profiles and newly advertised SQL leaves require their own
conformance rows and evidence before release.

## Audit rule

Do not remove a difference by weakening the user documentation unless a new accepted specification
decision explicitly changes the contract. For each row, add the user-document clarification first,
then regression and bypass tests, then implementation, then rerun workspace Clippy/tests, execution
coverage, schema validation, Worker tests, and the documentation build.
