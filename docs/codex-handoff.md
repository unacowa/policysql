# Codex handoff

## Project statement

PolicySQL is a security gateway whose external query language is parameterized SQLite SQL.

It parses incoming SQL, resolves all referenced resources, applies declarative Hasura-inspired data policies, optionally validates mutations through an HTTP service, and emits protected SQLite SQL for Turso/libSQL.

The product is the **policy-preserving compiler**, not the HTTP server and not the SQL parser alone.

## Current repository state

The SQLite/Turso v1 compiler profile is implemented through its profile-typed transport boundary:

- the SQLite parser/binder produces project-owned IR with stable Catalog provenance;
- SELECT and INSERT/UPDATE/DELETE policies compile to typed protected plans;
- an independent canonical renderer, emitted-SQL reparse, and invariant verifier seal execution plans;
- gateway compilation, owned transaction coordination, TRUE-only mutation checks, cardinality expectations, and Turso result validation are implemented;
- advertised SQL leaves are backed by positive, negative, bypass, differential fixtures and reference SQLite execution.

Deployment-specific HTTP listeners, concrete embedded/remote Turso driver handles, external hook networking, and transaction-owner routing must still be supplied and conformance-tested by each deployment. They must consume the existing sealed-plan ports and must not add a raw-SQL path.

The required Cloudflare/Turso implementation sequence and operational completion gate are defined in
[`operational-deployment-implementation-plan.md`](operational-deployment-implementation-plan.md).
Do not mark Gateway or Turso execution operationally complete until its persistent deployment and
real-environment curl acceptance artifacts exist.

## Recommended implementation sequence

### Milestone 0 — make the workspace build

- Confirm the chosen minimum supported Rust version.
- Add CI dependency auditing and license checks if desired.
- Keep crates free of unnecessary dependencies.

### Milestone 1 — single-table SELECT compiler

Support only this shape:

```sql
SELECT <explicit columns>
FROM <single base table> [AS alias]
[WHERE <simple boolean expression>]
[LIMIT <literal or parameter>]
```

Required work:

1. Select a SQLite-compatible parser.
2. Enforce exactly one statement in each compiler input item.
3. Reject `SELECT *` initially.
4. Bind table and column identifiers against a supplied catalog.
5. Convert parser AST into a small bound representation.
6. Validate column permission in every expression.
7. Combine the client predicate with the policy predicate using `AND`.
8. Enforce the policy maximum limit.
9. Emit protected SQLite SQL using server-owned parameters.
10. Re-parse emitted SQL and run invariant checks.
11. Produce an explain document.

Suggested acceptance example:

Input:

```sql
SELECT id, title
FROM posts
WHERE status = :status
LIMIT 200
```

Policy:

```yaml
select:
  columns: [id, title, status]
  filter:
    author_id:
      eq:
        session: subject_id
  limit: 100
```

Expected protected shape:

```sql
SELECT id, title
FROM posts
WHERE (status = :status)
  AND (author_id = :__policysql_session_subject_id)
LIMIT 100
```

Exact formatting is not part of the contract; bound semantics are.

### Milestone 2 — joins, subqueries, and provenance

- Add joins one type at a time.
- Prefer wrapping each base relation with its row policy where this preserves outer-join semantics.
- Track column provenance through aliases and expressions.
- Reject any form whose provenance cannot be proven.

### Milestone 3 — mutations

Implement in this order:

1. `INSERT ... VALUES` with explicit columns and literals/parameters only.
2. `DELETE` with policy pre-filter.
3. `UPDATE` with direct parameter/literal assignment.
4. `RETURNING` with independent column-permission checks.
5. Server presets.
6. Post-operation checks within an explicit transaction.
7. Transaction ownership and external commit checks with read-only callback queries.

Delay `INSERT ... SELECT`, expression-based updates, and arbitrary functions. Atomic orchestration may accept multiple items only after the scalar compiler is independently testable.

### Milestone 4 — Turso execution

- Add a transport abstraction first.
- Implement a Turso/libSQL adapter after protected SQL generation is independently testable.
- Preserve transaction state required for mutation checks.
- Normalize errors without leaking credentials, policies, or hidden schema details.

### Milestone 5 — HTTP gateway

Proposed endpoints:

- `POST /v1/transactions:execute`
- `POST /v1/transactions:explain`
- `POST /v1/transactions` and sequenced interactive transaction commands
- `GET /v1/catalog`
- `GET /v1/capabilities`
- `GET /healthz`

Authentication should resolve a trusted session object before SQL compilation.

## First issue candidates

1. `core: define catalog identities and bound column references`
2. `parser: evaluate SQLite parsers against required grammar`
3. `policy: parse and validate example policy metadata`
4. `compiler: protect a single-table SELECT`
5. `security: add adversarial fixtures for forbidden-column inference`
6. `explain: define stable per-statement explain results`
7. `testkit: run input/protected SQL against reference SQLite`

## Definition of done for the first vertical slice

- The compiler accepts the documented SELECT subset only.
- Unknown syntax is rejected.
- A policy predicate is always present for protected tables.
- Forbidden columns cannot appear in projection, predicates, ordering, grouping, or subqueries.
- Client parameters cannot impersonate session parameters.
- The output SQL is re-parsed and checked.
- Security fixtures run in CI.
- No Turso credentials are required for unit tests.
