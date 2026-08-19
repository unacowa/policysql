# Vision

## Problem

Applications increasingly generate SQL programmatically, including through AI-assisted development. Raw SQL is expressive and well understood, but exposing it directly to a remote database makes authorization, tenant isolation, mutation validation, auditing, and resource control difficult.

GraphQL engines such as Hasura demonstrate the value of declarative row/column permissions, session-variable predicates, write presets, mutation checks, and external validation. PolicySQL preserves those ideas while making SQL itself the application-facing query language.

## Product thesis

A useful data protection layer can be built as a compiler:

```text
untrusted SQL + trusted session + declarative policy + catalog
                              |
                              v
                    protected SQLite SQL
```

The compiler should be deterministic, explainable, testable without a live database, and default-deny.

## Primary users

- Developers building multi-tenant SaaS products on Turso/libSQL.
- Systems where clients and servers are generated programmatically.
- Teams that want SQL flexibility without giving callers unrestricted database access.
- AI-agent platforms that need a narrow, auditable SQL execution boundary.

## Design values

1. Security before compatibility.
2. Explicit limitations before silent semantic drift.
3. Compiler transformations before check-then-act authorization.
4. Machine-readable contracts and executable tests over prose alone.
5. SQLite common-subset portability over engine-specific convenience.
6. Explainability for every accepted or rejected query.
