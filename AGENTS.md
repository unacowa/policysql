# AGENTS.md — Codex instructions

## Mission

Build PolicySQL as a default-deny SQL policy compiler for SQLite/Turso.

The trusted boundary is the PolicySQL process. Incoming SQL, parameters, headers, session claims, validation-hook responses, database metadata, and generated code must all be treated as potentially hostile or malformed unless explicitly validated.

## Read order

1. `README.md`
2. `docs/codex-handoff.md`
3. `docs/security-model.md`
4. `docs/policy-semantics.md`
5. `docs/sql-subset.md`
6. Relevant ADRs in `docs/adr/`

## Implementation rules

- Default deny. Unknown statements, nodes, functions, clauses, or metadata are rejected.
- Accept exactly one SQL statement per request.
- Never enforce row policy with a check-then-query sequence when it can be compiled into the protected statement.
- Resolve all identifiers before policy application. A syntax AST alone is not sufficient.
- Track column provenance through aliases, joins, CTEs, subqueries, expressions, `ORDER BY`, grouping, and `RETURNING`.
- Treat forbidden columns as forbidden everywhere, not only in result projection.
- Keep client parameters and server-owned session parameters in separate namespaces.
- Never let a client override a preset column or server-owned parameter.
- Re-parse emitted SQL and run a second invariant checker before execution.
- Avoid string concatenation for SQL generation. Use a typed AST/emitter.
- No DDL, `PRAGMA`, `ATTACH`, transaction-control SQL, temp objects, triggers, extension loading, or multiple statements in the public endpoint.
- Every added SQL feature requires positive, negative, bypass, and differential tests.
- Security fixes require a regression fixture.

## Scope discipline

Do not attempt full SQL compatibility first. The first vertical slice should support:

- single-table parameterized `SELECT`
- explicit projected columns
- simple boolean predicates
- policy row-filter composition
- column permission validation
- generated protected SQL
- explain output
- no database execution required until the compiler slice is tested

## Expected first milestones

1. Replace placeholder parser types with a real SQLite-capable parser.
2. Introduce a bound relational representation with stable table/column identities.
3. Implement a single-table `SELECT` policy compiler.
4. Add golden tests for protected SQL and adversarial tests for bypass attempts.
5. Add Turso execution only after compiler invariants are testable independently.

## Pull request checklist

- What new SQL surface is accepted?
- What policy behavior applies to every new AST node?
- What bypasses were considered?
- Are emitted statements re-parsed?
- Are resource/time/result limits preserved?
- Are errors safe to expose to an untrusted client?
