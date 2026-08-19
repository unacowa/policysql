# ADR 0004: Conditional output columns and result column identity

- Status: accepted

## Context

Some applications need to return a row while hiding one projected value according to the current row and trusted session. Returning JSON `null` is sufficient for ordinary application code, but clients may also need to distinguish a policy denial from a visible database `NULL`.

A regularly allowed column may be referenced in predicates, joins, ordering, grouping, windows, functions, and subqueries. A conditionally hidden value must not influence those contexts because its value could be inferred without projecting it. JSON object rows and cell-level redaction metadata also require every output column to have an unambiguous identity.

## Decision

### Unified output column list

Select and mutation-returning policies use one ordered `columns` list. A regular column uses a string shorthand. A conditional output column uses an object with an explicit `name`:

```yaml
columns:
  - id
  - title
  - name: private_note
    visible_if:
      author_id:
        eq:
          session: subject_id
    on_deny: null
```

Both forms normalize to one internal column-permission model. The same column name cannot appear more than once, including once as a string and once as an object. Missing from the list means deny.

`visible_if` uses the trusted policy predicate vocabulary and cannot be supplied or modified by client SQL. `on_deny` currently accepts only YAML `null`; unknown actions are rejected when loading the policy bundle.

INSERT and UPDATE input `columns` remain string lists. Conditional objects are accepted only in SELECT and `RETURNING`, where they describe output visibility rather than writable input.

### Three-valued logic

The source value is visible only when `visible_if` evaluates to SQL TRUE. FALSE and UNKNOWN both deny visibility. A denied cell is JSON `null` with one `POLICY_REDACTED` entry, even when the source was already SQL NULL. A visible database NULL has no redaction entry.

### Accepted SQL contexts

A conditional output column may appear only as a direct base-column projection with an optional alias. It is rejected in predicates, joins, ordering, grouping, aggregate/window/function expressions, subquery conditions, and derived projections whose direct base-column identity cannot be proven. Regular string items retain all supported expression contexts.

### Mutation RETURNING

`returning.columns` uses the same unified list. If `returning` is absent, client SQL cannot use `RETURNING`.

### Catalog contract

The role-visible Catalog publishes each column with explicit usage contexts. A regular column has supported contexts for the operation. A conditional output column has only `projection` and sets `nullableOnDenied: true`. The gateway still revalidates every statement.

### Result column identity

After applying implicit names and aliases, output names must be non-empty and unique under SQLite ASCII case-insensitive comparison. Duplicate names are rejected before execution. `redactions[].column` contains the unique aliased output name and `redactions[].row` is the zero-based row index.

## Consequences

- Policy authors see one `columns` list instead of separate regular and conditional-output sections.
- Policy-nullable values cannot be used as an inference channel through non-projection contexts.
- Schema validation accepts a string-or-object union; semantic validation normalizes names and rejects cross-form duplicates.
- Clients can distinguish policy denial from visible database NULL while ordinary row values remain `T | null`.
- Kysely needs a dedicated selection helper for projection-only conditional columns.
