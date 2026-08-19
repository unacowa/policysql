# ADR 0006: Closed policy predicate language

- Status: accepted

## Context

A generic YAML object for policy predicates permits unknown operators and ambiguous combinations to pass structural validation. That conflicts with default deny and leaves different implementations free to assign different semantics.

## Decision

Policy predicates form a closed recursive language. A predicate node contains exactly one column comparison or exactly one of `and`, `or`, and `not`. A comparison contains exactly one registered operator. The portable operators are `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`, `not_in`, `is_null`, and `like`.

Scalar literals, trusted-session references, and same-row column references are accepted where their logical descriptors are compatible. `in` and `not_in` accept non-empty literal arrays. SQL NULL is expressed only with `is_null`; null comparison operands are invalid. Relationship predicates, SQL fragments, functions, and subqueries are not embedded in policy YAML.

Policy activation performs JSON Schema validation followed by Catalog-aware semantic validation. Unknown fields, operators, resources, columns, session keys, incompatible operands, overlapping permission classes, and unsupported capabilities reject the whole immutable bundle.

Aggregation, window, and relational SQL-surface authorization is not expressed as arbitrary policy predicates. Deployment capability remains a runtime upper bound; resource/column permissions and the default-false aggregate/window gates remain the accepted user policy contract. ADR 0012's finer-grained proposal was rejected.

## Consequences

- Policy files have one portable interpretation.
- Complex cross-resource rules use commit checks instead of an unbounded YAML query language.
- New operators require a policy-format version or an explicitly backward-compatible schema extension plus compiler and bypass tests.
