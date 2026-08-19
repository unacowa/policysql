# Basic example

This example documents the first intended vertical slice.

- `schema.sql` defines a physical SQLite schema.
- `input.sql` is caller-provided SQL.
- `protected.sql` illustrates the expected protected shape.
- `params.json` separates client and server-owned parameters conceptually.

Formatting and parameter names are illustrative. Tests should compare bound semantics rather than fragile whitespace.
