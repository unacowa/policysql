# Phase 1 concerns: policy-nullable columns

## Decisions

- Conditional visibility is an object item in the same `columns` list, identified by an explicit `name`.
- Conditional output columns are limited to direct base-column projection with an optional alias.
- A denied cell is JSON `null`; `meta.result.redactions` records the deny even when the source value was already SQL NULL.
- Query-local result metadata describes the compiled expression result. Role-specific base-column permissions remain in Catalog.
- Result names are non-empty and unique under SQLite ASCII case-insensitive identifier comparison.

## Residual risks

- Projection-only usage cannot be represented completely by ordinary Kysely table types. Gateway validation remains authoritative until a dedicated selection helper exists.
- Per-cell redaction metadata is proportional to denied cells. Implementations must count it against result-byte and row limits and must not allocate it without bounds.
- Redaction presence reveals that a visibility rule denied a cell. Policies that must hide that fact must remove the column or row instead of returning a conditionally redacted value.
- Derived-table, compound-query, and view support must remain denied for conditional output columns until the binder proves direct base-column identity through those nodes.

## Implementation checks

- Preserve the visibility bit independently from the source SQL value.
- Generate one redaction entry per denied output cell after alias resolution.
- Normalize string and object items and reject duplicate column names across both forms when loading a policy bundle.
- Test NULL, FALSE, and UNKNOWN visibility outcomes, duplicate aliases, case-colliding aliases, and `RETURNING` behavior.
