# ADR 0002: Use SQLite SQL as the public query language

- Status: accepted

## Context

Defining a new query IR would add another language, generator, documentation surface, and compatibility layer. The target storage is Turso/libSQL, both centered on SQLite-compatible SQL.

## Decision

Accept a strict, parameterized SQLite SQL subset as the public query language.

## Consequences

- Existing SQL knowledge and tooling remain useful.
- The compiler must parse, bind, validate, rewrite, emit, and re-verify SQL safely.
- The accepted subset must be explicit and default-deny.
- Internal bound representations remain necessary but are not public contracts.
- Multi-database portability is secondary to security and Turso/SQLite correctness.
