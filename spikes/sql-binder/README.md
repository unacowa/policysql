# SQL parser and binder spike

This spike pins `turso_parser` to the same `0.7.2` release used by the embedded Turso transaction spike. It demonstrates the required separation between syntax parsing and Catalog-aware binding.

The first binder intentionally accepts only a narrow SELECT subset. An advanced spike additionally covers representative non-recursive CTE and derived-table provenance, grouping, aggregates, windows, and INSERT/UPDATE/DELETE contexts. A typed bound query is emitted, parsed again, rebound, and checked by an independent AST invariant checker. Unknown AST shapes still fail closed.

The tests demonstrate implementation feasibility for the exact shapes in the fixtures. They are not a claim of complete SQLite grammar coverage.

Run:

```sh
cargo test --manifest-path spikes/sql-binder/Cargo.toml
```
