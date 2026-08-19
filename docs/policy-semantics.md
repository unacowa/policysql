# Policy semantics

PolicySQL borrows concepts from Hasura v2 but is not metadata-format compatible by default.

## Policy selection

A policy is selected by:

- resource/table;
- role;
- operation: `select`, `insert`, `update`, or `delete`.

Missing policy means deny.

## Select policy

```yaml
select:
  columns:
    - id
    - name
    - status
    - name: private_note
      visible_if:
        owner_id:
          eq:
            session: subject_id
      on_deny: null
  filter:
    tenant_id:
      eq:
        session: tenant_id
  limit: 100
  allow_aggregations: false
  allow_windows: false
```

Semantics:

- a string `columns` item may be referenced in every supported expression context;
- an object item with `name`, `visible_if`, and `on_deny` may be used only as a direct output projection with an optional alias;
- the same column name cannot appear more than once in the list;
- a conditional value is visible only when `visible_if` is SQL TRUE; FALSE and UNKNOWN return JSON `null` with a redaction entry;
- the row filter is combined with the caller predicate;
- the effective result limit is the stricter of caller limit and policy limit;
- deployment capabilities describe the maximum SQL surface the runtime can safely execute, but they do not grant access by themselves;
- every JOIN resource must have its own select policy for the caller role, and every JOIN expression column must be present in the corresponding policy's regular `columns` list;
- `allow_aggregations` is a default-false gate for aggregate functions, `GROUP BY`, and `HAVING`; every referenced column still requires regular column permission;
- `allow_windows` is a default-false gate for window functions; every partition/order column still requires regular column permission;
- deployment capabilities describe the maximum SQL surface the runtime can safely execute, but they do not grant resource access by themselves.

## Insert policy

```yaml
insert:
  columns: [name, customer_id, status]
  presets:
    tenant_id:
      session: tenant_id
    created_by:
      session: user_id
  check:
    tenant_id:
      eq:
        session: tenant_id
  returning:
    columns: [id, name, status]
```

Semantics:

- caller may provide only listed columns;
- preset columns are server-owned, disjoint from caller columns, and rejected if supplied by the caller;
- `check` describes required post-insert state;
- every changed row must evaluate the check to TRUE; FALSE and UNKNOWN fail, while zero changed rows pass vacuously;
- unsupported atomic check behavior means reject, not best-effort execution.

## Update policy

```yaml
update:
  columns: [name, status]
  filter:
    tenant_id:
      eq:
        session: tenant_id
  presets:
    updated_by:
      session: user_id
  check:
    tenant_id:
      eq:
        session: tenant_id
  returning:
    columns: [id, name, status]
```

Semantics:

- `filter` constrains rows eligible before the update;
- `columns` constrains assignments;
- `presets` add or replace server-owned assignments according to configured conflict behavior;
- `check` constrains resulting rows.
- every changed row must evaluate the check to TRUE; use an affected-row expectation when zero rows must fail.

## Delete policy

```yaml
delete:
  filter:
    and:
      - tenant_id:
          eq:
            session: tenant_id
      - status:
          neq: locked
```

Semantics:

- the policy filter is compiled into the delete predicate;
- `RETURNING` requires separately allowed return columns;
- cascades and trigger-dependent side effects are outside the public mutation model.

## Commit checks

Cross-resource and application-defined validation is configured at the policy-bundle root:

```yaml
commit_checks:
  post_consistency:
    triggered_by: [posts, comments]
    role: admin
    hook:
      url_env: POST_VALIDATOR_URL
      timeout_ms: 1500
      hmac_secret_env: POST_VALIDATOR_SECRET
```

Semantics:

- matching checks run after every operation and operation check, immediately before commit;
- omitted `role` inherits the initiating role;
- an explicit role is policy-owned system privilege and need not appear in the caller JWT;
- the validator can issue SELECT statements through PolicySQL against the same transaction;
- callback SELECT statements use the chosen role and the initiating trusted session;
- any reject, timeout, query error, protocol error, or owner loss rolls back the transaction.

## Boolean expression vocabulary

The portable policy operators are:

- `eq`, `neq`
- `lt`, `lte`, `gt`, `gte`
- `in`, `not_in`
- `is_null`
- `and`, `or`, `not`
- session value, literal value, and same-row column value where proven safe

Each predicate object contains exactly one column comparison or one logical operator. `in` and `not_in` accept non-empty literal lists. SQL NULL is tested only with `is_null`; comparison to a null operand is invalid. Relationship predicates are not part of this policy format.

Database-specific JSON, regexp, full-text, and custom-function operators should be capability-gated.

## Result column identity

Output names after aliasing must be non-empty and unique under SQLite ASCII case-insensitive comparison. Duplicate result names are rejected before execution so JSON row keys and redaction metadata remain unambiguous.
