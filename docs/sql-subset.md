# Supported SQL subset

PolicySQL accepts a strict, capability-gated SQLite subset. A deployment advertises only features that its parser, binder, policy compiler, verifier, and engine conformance suite support. Missing or unknown syntax, missing capability, or missing resource/column policy permission is denied.

## SELECT

- exactly one statement in each SQL item, with explicit result expressions; no `*` or `table.*`;
- base resources and aliases that resolve unambiguously;
- `INNER JOIN` and `LEFT JOIN` only when every base resource has its own select policy and every referenced column is allowed;
- boolean predicates using registered operators and named parameters;
- provenance-preserving qualified correlated `EXISTS` whose inner projection is one permitted direct column or the exact constant `1`, transparent single-resource derived tables, and one transparent/filtered non-recursive CTE that may feed an outer JOIN;
- `ORDER BY` over permitted direct columns or resolved projection aliases, plus non-negative integer literal/named-parameter `LIMIT` and `OFFSET`;
- `COUNT(*)` with direct `GROUP BY`/closed `HAVING` only when deployment capability and `allow_aggregations` permit it and every referenced column is allowed;
- inline `ROW_NUMBER` only when deployment capability and `allow_windows` permit it and every referenced column is allowed;
- registered side-effect-free scalar functions `LOWER(string)`, `UPPER(string)`, and `JSON_EXTRACT(json, string)`, with exact arity/type checking and ordinary column permission on every argument;
- explicitly aliased typed projections using searched `CASE`, string concatenation `||`, and `CAST(... AS TEXT)`; every branch/input is provenance checked and other arithmetic, bitwise, simple-CASE, and CAST shapes remain denied;
- `LIKE` and `GLOB` string predicates; `ESCAPE` remains outside the registered surface;
- unique, non-empty output names under SQLite ASCII case-insensitive comparison;
- conditional output columns only as direct base-column projections with optional aliases.

CTE names may not shadow protected resource names. Nested aliases may not shadow an outer alias used for correlation. Ambiguous references and correlations whose base-column provenance is not statically provable are rejected.

## Capability and policy gates

Capabilities describe what the deployed runtime can execute safely for any caller. Policies describe what a specific role may execute for a specific resource. Both must allow a SQL feature before it can reach the database.

Examples:

- if `joins` capability is disabled, every client-authored JOIN is rejected before execution, regardless of policy;
- if `joins` capability is enabled but any referenced resource lacks a select policy or a JOIN column is not in regular `columns`, the JOIN is rejected before execution;
- if aggregate capability is enabled but `allow_aggregations` is false, aggregate, `GROUP BY`, and `HAVING` are rejected before execution;
- if window capability is enabled but `allow_windows` is false, window expressions are rejected before execution.

## Mutations

### INSERT

- explicit target columns and `VALUES` rows;
- registered literals and named parameters;
- server-owned presets disjoint from client columns;
- post-state checks over every inserted row;
- optional independently authorized `RETURNING`.

### UPDATE

- one base resource;
- explicit assignments using literals or named parameters only;
- pre-state policy filter and client predicate;
- server-owned presets disjoint from client assignments;
- post-state checks over every changed row;
- optional independently authorized `RETURNING`.

### DELETE

- one base resource;
- policy and client predicates over the pre-delete row;
- optional independently authorized `RETURNING`.

Operation checks evaluate to success only on SQL TRUE. FALSE and UNKNOWN fail. A zero-row mutation passes the row check vacuously; callers use transaction `expect.affectedRows` when cardinality is part of the invariant.

## Always rejected from public SQL

- multiple statements inside one `sql` field and SQL transaction control;
- DDL, `PRAGMA`, `ATTACH`, `DETACH`, `VACUUM`, temp objects, triggers, view or virtual-table creation, and extension loading;
- direct `sqlite_schema` access;
- recursive CTEs and `INSERT ... SELECT`;
- user-defined or non-allowlisted functions;
- positional parameters and client use of the server parameter namespace;
- trigger-dependent or otherwise hidden mutation side effects;
- any statement whose complete resource, column, type, or result provenance cannot be established.

## Compatibility

The accepted surface is the intersection proven equivalent by conformance tests for reference SQLite and each advertised Turso engine adapter. Capabilities may narrow this document for a deployment but may not silently broaden it with unverified syntax.
