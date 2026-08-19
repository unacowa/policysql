# ADR 0012: Policy-gated relational SQL surface

## Status

Rejected.

The published user contract remains authoritative: JOIN authorization requires select policy and regular-column permission for every referenced resource, while aggregation and window use the default-false `allow_aggregations` and `allow_windows` gates. This ADR's finer-grained relationship and expression-context allowlists are not part of the accepted policy format.

## Context

PolicySQL already distinguishes compiler support from online deployment support. The compiler can prove and emit protected SQL for a broader SQLite subset than the Cloudflare Worker currently advertises. The online runtime may further narrow the accepted surface for operational risk, billing, and conformance reasons.

The previous policy model was too coarse for relational features:

- deployment capabilities such as `joins`, `aggregates`, `windows`, and `ctes` were broad booleans;
- select policy allowed ordinary columns and had boolean gates such as `allow_aggregations` and `allow_windows`;
- JOIN authorization was effectively derived from "every referenced resource has a select policy" plus column authorization;
- GROUP BY and HAVING authorization was derived from ordinary selectable columns plus aggregate/window booleans.

That is not precise enough for a default-deny public SQL endpoint. A role may be allowed to read resource `a` and resource `b` independently, but still must not be allowed to join them unless the policy explicitly permits that relationship. Similarly, a column that may be projected is not automatically safe to group by, use in HAVING, or use for window partitioning/order inference.

## Decision

Deployment capability is only an engine/runtime upper bound. It never grants role authorization by itself.

The effective rule is:

```text
accepted = deployment capability allows feature
        AND policy explicitly allows this role/resource usage
        AND binder/provenance/verifier can prove the usage exactly
```

Missing policy allowlist means deny.

### JOINs

Select policies must explicitly allow relationship edges. A JOIN is accepted only when:

- the deployment advertises the relevant JOIN capability;
- the root resource policy contains a matching `joins` entry;
- the joined resource also has a select policy for the caller role;
- the JOIN kind is listed;
- every ON equality resolves to an allowed `{ left, right }` column pair;
- no unallowed ON predicate is present;
- all identifiers and aliases resolve to stable resource/column identities.

Example policy:

```yaml
select:
  columns: [id, name]
  filter: { tenant_id: { eq: { session: tenant_id } } }
  joins:
    - to: tasks
      type: [inner, left]
      on:
        - left: id
          right: project_id
```

This can allow `projects.id = tasks.project_id` while denying `projects.id = comments.project_id`, even if `comments` has its own select policy.

LEFT JOIN remains security-sensitive. The nullable-side resource filter must be placed in the JOIN `ON` condition. Placing it in the root `WHERE` is a bug because it changes null-extension semantics and can turn an outer join into an inner join.

### Aggregations

Select policies must explicitly allow aggregate functions, grouping columns, and HAVING usage. Ordinary projection permission is not sufficient.

Example policy:

```yaml
select:
  columns: [id, name, status]
  filter: { tenant_id: { eq: { session: tenant_id } } }
  aggregations:
    functions: [count]
    group_by: [status]
    having:
      columns: [status]
      aggregates: [count]
```

This allows grouping by `status` and `COUNT(*)`, but denies grouping by `tenant_id` unless it is explicitly listed in `group_by`.

### Windows

Select policies must explicitly allow each window function and its partition/order columns.

Example policy:

```yaml
select:
  columns: [id, status]
  filter: { tenant_id: { eq: { session: tenant_id } } }
  windows:
    row_number:
      partition_by: [status]
      order_by: [id]
```

Using an unlisted column for `PARTITION BY` or window `ORDER BY` is denied, even if the column is otherwise selectable.

## Consequences

- Enabling a deployment capability does not expose data unless policy allowlists are present.
- Capabilities and policy must be tested together. A capability-only allow path is a security bug.
- Existing broad booleans such as `allow_aggregations` and `allow_windows` should be replaced or treated as compatibility shims for the more precise allowlists.
- Public Catalog and `/v1/capabilities` must not imply that a role can use a feature merely because the deployment supports it. Role-visible policy detail should be reported separately or as scoped access descriptors.
- Egress tests must cover both allow and deny:
  - allow: HTTP request reaches Turso egress with the expected protected SQL;
  - deny: rejected SQL performs zero Turso calls.
- Multi-database backends must implement equivalent allowlist semantics before advertising the same feature.

## Rejected alternatives

### Capability-only authorization

Rejected. It makes `joins: true` or `aggregates: true` too broad and allows a role to combine resources or group columns that were never explicitly approved.

### Resource-policy-only JOIN authorization

Rejected. Independent read permission on two resources does not imply permission to join them. JOINs can create inference channels and cost amplification.

### Projection-column reuse for GROUP/window authorization

Rejected. Projection, grouping, HAVING, partitioning, and ordering are different usage contexts with different inference properties.
