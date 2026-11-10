# ADR 0029: One-hop parent `exists` in a select filter

- Status: accepted
- Issues: #112
- Amends: [ADR 0006](0006-closed-policy-predicate-language.md) ("Relationship predicates … are
  not embedded in policy YAML")
- Related: [ADR 0004](0004-policy-nullable-and-result-column-identity.md),
  [ADR 0012](0012-policy-gated-relational-surface.md),
  [ADR 0027](0027-byte-and-cpu-budgets.md)

## Context

A select `filter` can reference only the row's own columns. A child resource that holds a
foreign key but not the tenant (for example `comments.post_id` without `comments.tenant_id`)
cannot be restricted by its parent's tenant. Hasura v2 expresses this with relationship
predicates in its permissions. ADR 0006 excluded them to keep the predicate language closed and
leave cross-resource rules to commit checks, but a commit check does not filter reads.

The compiler already accepts, emits, re-parses, and verifies a client's correlated
`EXISTS (SELECT 1 FROM … WHERE …)` (`BoundExpr::Exists`). A parent predicate is the same shape,
written by the policy author instead of the client.

## Decision

A select `filter` may contain

```yaml
exists:
  resource: <parent resource>
  on: { <parent column>: <child column> }
  where: <predicate over the parent>
```

anywhere a predicate is allowed in that filter, including inside `and`, `or`, and `not`. It
compiles to `EXISTS (SELECT 1 FROM parent WHERE parent.<col> = child.<col> AND <where>)`,
composed into the protected statement like any other row filter: the root `WHERE`, the root
`WHERE` for an INNER JOIN, the `ON` for a LEFT JOIN, and inside a client `EXISTS` over the
child.

Rules, all checked at activation:

- `resource`, `on`, and `where` are required and are the only keys; `on` has exactly one pair.
- Both `on` columns exist and have the same logical type; bytes and JSON are rejected.
- The parent is a different resource from the child. The emitter names each resource by one
  alias, so a same-resource parent would be shadowed by its own subquery.
- One hop: `exists` is rejected inside `where`.
- `exists` is rejected in insert and update checks, update and delete filters, and
  `visible_if`. It is a reserved key in every predicate, so a column named `exists` cannot be
  referenced by a predicate.

Semantics:

- The parent's own select policy is not applied, and none is required. The rule is the
  policy author's; it is evaluated with the author's authority, as in Hasura.
- The `where` columns are policy-internal. They do not extend the client's column permissions
  and do not appear in explain `resources` or `referenced_columns`. A client that references
  the parent directly still needs a parent select policy.
- A child row whose `on` column is NULL, or has no parent, does not match.

The emitter now also allocates aliases for subqueries in a JOIN's `ON`, where a LEFT JOIN's
row filter is placed. A JSON-collection select gets no such allocation, so an `exists` filter
on its resource is rejected by the emitter; that combination is unsupported for now.

## Consequences

- A child can be scoped by its parent without denormalizing the tenant onto it.
- Cost: each candidate child row looks up its parent. With an index on the parent's `on`
  column (normally the primary key) this is about one extra row read per child row; without
  one it is a scan of the parent per child row. Turso bills rows read, including rows read in
  subqueries and rows the filter discards. The Catalog has no index metadata, so activation
  cannot enforce an index; the documentation requires one and prefers a denormalized,
  indexed same-row filter where possible.
- Emitted height: the subquery's `WHERE` is a separate tree height, but parse recursion depth
  accumulates across `EXISTS` (ADR 0027). A policy `exists` inside a client `EXISTS` adds a
  few levels along its own branch only; the margin was not re-measured for this ADR.
- Multi-hop relationships, multi-column keys, same-resource relationships, parent predicates
  in checks, and index-aware validation are left to later decisions.

## Alternatives considered

- **Apply the parent's select policy inside the subquery.** Rejected for now. It would require
  a parent policy for every rule, couple a child's visibility to the parent's role surface,
  and invite cycles between resources.
- **Declare relationships separately from predicates (Hasura metadata style).** Rejected for
  the minimal version: the single `on` pair carries everything one hop needs. A relationship
  registry can be introduced when multi-hop or reuse needs it.
- **Keep using commit checks.** Rejected: they validate writes and do not filter reads.
