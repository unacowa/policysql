# Policy semantics

PolicySQL borrows concepts from Hasura v2 but is not metadata-format compatible by default.

The security properties these semantics must satisfy (P1–P5) and the risks they leave open are defined in [security-model.md](security-model.md#security-properties).

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
- the effective result limit is the stricter of caller limit and policy limit (a negative caller `LIMIT` parameter currently defeats this; see [Verification status](security-model.md#verification-status));
- deployment capabilities describe the maximum SQL surface the runtime can safely execute, but they do not grant access by themselves;
- every JOIN resource must have its own select policy for the caller role, and every JOIN expression column must be present in the corresponding policy's regular `columns` list;
- `allow_aggregations` is a default-false gate for aggregate functions, `GROUP BY`, and `HAVING`; every referenced column still requires regular column permission;
- `allow_windows` is a default-false gate for window functions; every partition/order column still requires regular column permission;
- both gates apply wherever the construct appears (an aggregate inside `CASE`, `HAVING`, or an `ORDER BY` projection alias counts as one) and to every resource the statement reads: the root, every joined resource, and every nested `EXISTS` resource each need the gate. A semi-join on a unique key counts the `EXISTS` resource's visible rows exactly as a JOIN would. `COUNT(*)` is accepted only in the SELECT list, `HAVING`, and `ORDER BY` (through a projection alias), and `ROW_NUMBER` only as a whole projection or an `ORDER BY` projection alias; elsewhere, and in any mutation, they are rejected (issue #115);
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
    created_at:
      now: {}
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
- a preset value is `session: <key>`, `literal: <value>`, or `now: {}`;
- `now: {}` is the time of the compile: the `Date.now()` of the engine or the owner that compiles ([ADR 0031](adr/0031-server-time-presets.md)). The column's Catalog type fixes the spelling: `instant` (format `rfc3339`) gets `2026-10-30T13:14:56.789Z` (UTC, milliseconds), `datetime` (format `sqlite-datetime`) gets `2026-10-30 13:14:56` (UTC, milliseconds truncated, the form of SQLite's `CURRENT_TIMESTAMP`), and `int64` or `integer` gets epoch milliseconds. Any other type or format, and any column with `constraints`, is rejected at activation, because whether a constraint accepts a time depends on the time;
- one compile has one time: every statement and every row of an atomic envelope get the same value (an interactive transaction compiles each statement in its own request, so each statement has its own time);
- `now` is a preset value only. In `filter`, `check`, `visible_if` and `exists.where` it is rejected at activation;
- the time is not a trusted-session value and cannot be written as `session:`: the idempotency identity and the interactive replay identity include the session, so a value that changes with every request would turn a retry into another request;
- `check` describes required post-insert state;
- every changed row must evaluate the check to TRUE; FALSE and UNKNOWN fail, while zero changed rows pass vacuously;
- unsupported atomic check behavior means reject, not best-effort execution.

A caller may write SQL NULL to a listed `nullable: true` column by passing JSON
`null` for a named parameter used only as direct assignment values to such columns
(see [ADR 0017](adr/0017-nullable-assignments.md)). Nullability never widens
`columns`: preset, server-owned and unlisted columns stay forbidden. The check is
evaluated on the row as written, so a NULL that makes a comparison UNKNOWN (for
example `neq`, `not_in` or `not: { eq: ... }` on that column) fails the check; use
`is_null` when NULL must be allowed or required.

For a bytes column, INSERT and UPDATE presets may use a fixed canonical base64
literal, for example `seed: { literal: "AAEC/w==" }`. Policy activation validates
the encoding and decoded size; the emitter binds the value as a server-owned BLOB
parameter. This does not add bytes session coercion or bytes literal comparisons
to the policy predicate language. See [ADR 0016](adr/0016-bytes-wire-contract.md).

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
    updated_at:
      now: {}
  check:
    tenant_id:
      eq:
        session: tenant_id
  returning:
    columns: [id, name, status]
```

Semantics:

- `filter` constrains rows eligible before the update;
- `filter` is not composed with the select `filter` (issue #118). If it admits rows the select `filter` hides, the regular select columns of those rows can be inferred through the caller `WHERE`, so P3 in [security-model.md](security-model.md#security-properties) holds only when every row the update `filter` admits is also admitted by the select `filter`;
- a caller `WHERE` may reference only the role's regular select columns for the resource (issue #116). `returning.columns` do not count: `RETURNING` shows post-update values (a preset or an assignment overwrites the pre-state one) and never a row that fails `check`. Columns that are only writable, used only by policy filters, or conditional (`visible_if`) are rejected, and a role without a select policy may not reference any column;
- `columns` constrains assignments;
- `presets` add or replace server-owned assignments according to configured conflict behavior; `now: {}` follows the rules under Insert policy;
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
- as for update, the select `filter` is not composed into the delete predicate (issue #118);
- a caller `WHERE` may reference only the role's regular select columns for the resource (issue #116), as for update; `returning.columns` do not count, since a probe with `expect.affectedRows: 0` rolls back without showing the value it filtered on;
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
      timeout_ms: 1500
```

Semantics:

- the policy names no validator endpoint or secret: the wrapper supplies the URL and HMAC
  secret per check id in `PolicySqlConfig.commitChecks`
  ([ADR 0021](adr/0021-explicit-engine-config.md)); a triggered check without an entry
  rejects the commit;
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
- `exists` (select `filter` only, one hop to a different resource)

Each predicate object contains exactly one column comparison or one logical operator. `in` and `not_in` accept non-empty literal lists. SQL NULL is tested only with `is_null`; comparison to a null operand is invalid.

A select `filter` (and only a select `filter`) may also contain one-hop parent predicates ([ADR 0029](adr/0029-select-filter-parent-exists.md)):

```yaml
filter:
  exists:
    resource: posts
    on: { id: post_id }   # parent column: child column
    where: { tenant_id: { eq: { session: tenant_id } } }
```

It compiles to a correlated `EXISTS (SELECT 1 FROM parent WHERE parent.col = child.col AND <where>)`. The parent's own select policy is not applied, the `where` columns are policy-internal, a NULL or dangling child column never matches the `exists` (so it does match under `not`), nesting and same-resource parents are rejected, and `exists` is a reserved word in every predicate.

Database-specific JSON, regexp, full-text, and custom-function operators should be capability-gated.

## Result column identity

Output names after aliasing must be non-empty and unique under SQLite ASCII case-insensitive comparison. Duplicate result names are rejected before execution so JSON row keys and redaction metadata remain unambiguous.
