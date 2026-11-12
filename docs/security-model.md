# Security model

## Trust boundaries

Trusted only after validation:

- PolicySQL process and compiled code
- explicitly loaded policy metadata
- explicitly loaded logical catalog
- verified authentication/session claims

Untrusted:

- SQL text
- SQL parameters
- HTTP headers and bodies
- AI-generated code
- validation-hook responses
- database errors
- schema names received from remote systems
- cached artifacts whose version cannot be verified

## Mandatory invariants

1. **Default deny** — every unsupported statement, node, clause, function, or metadata condition is rejected.
2. **Single statement per SQL item** — every `statements[].sql`, interactive step, and callback query contains exactly one statement; atomic requests may contain multiple separately validated items.
3. **Bound authorization** — policies are applied to resolved resources and columns, never text patterns alone.
4. **Complete coverage** — every base-table access has an applicable operation policy.
5. **Column non-interference** — forbidden columns cannot influence projection, filtering, joins, grouping, ordering, aggregates, windows, subqueries, or `RETURNING`. P1 and P3 under [Security properties](#security-properties) define what "influence" means. For `RETURNING`, the permitted columns are the mutation policy's `returning.columns`, which may include columns that are forbidden for SELECT (P3 exposure 1); policy-owned `filter`, `check`, and `visible_if` may read forbidden columns (see Terms and P1; for mutations, P3 exposures 2-3).
6. **Row-policy composition** — client predicates cannot replace, weaken, negate, or shadow policy predicates. P1, P2, and P3 under [Security properties](#security-properties) state the consequence.
7. **Server namespace integrity** — clients cannot define, override, or bind server-owned parameters.
8. **Preset integrity** — clients cannot override policy-owned mutation columns.
9. **Atomic mutation checks** — when post-state checks are required, the write and check must be one atomic unit or the operation is unsupported.
10. **Fail closed on ambiguity** — ambiguous identifier, type, provenance, transaction, or engine semantics cause rejection.
11. **Emission verification** — protected SQL is re-parsed before execution and must be exactly one ordinary statement of the expected operation. The sealing verifier also checks that the supplied client parameter names are exactly those an analysis of the protected plan finds, that client string literals round-trip, and that server literal strings carry decoded values; `compile_verified_insert` and `compile_verified_update` refuse a plan without an operation check, and INSERT one without an affected-row expectation. The verifier's other comparisons (statement syntax tree, server parameter set, result descriptors, snapshot) take their expectations from the same emission they check, so they detect only a change between emission and sealing. The verifier knows neither the policy, the Catalog, nor the role: it does not check that every table access carries its row filter or that no forbidden column is used. A policy-aware verifier is planned (#127).
12. **Resource bounds** — each statement and the enclosing transaction have bounded time, rows, result bytes, nesting depth, joins, parameters, expression complexity, and statement count.
13. **Conditional-output-column non-interference** — conditionally visible columns can affect only their direct output cells, never filtering, joins, ordering, grouping, windows, functions, or derived expressions. This is a stricter syntactic rule than P1 requires (see [Security properties](#security-properties)).
14. **Result identity** — every output column has a unique, non-empty name before rows or redaction metadata are encoded.
15. **Authentication canonicalization** — duplicated or ambiguous authentication headers, role identifiers, claim mappings, or reserved session keys are rejected before SQL parsing.
16. **No session coercion** — trusted-session strings are never implicitly coerced through SQLite affinity; policy activation proves descriptor compatibility.
17. **Snapshot integrity** — one request or transaction uses one immutable policy, Catalog, type-registry, and function-registry snapshot; stale preconditions fail before execution.
18. **Retry integrity** — when an optional idempotency key is supplied, a write retry is bound to authenticated context, endpoint, DB binding, key, and canonical payload and cannot execute a different request. Without a key, independent requests may each execute; transaction checks and interactive command sequencing still apply. Malformed supplied keys are never treated as omission.
19. **Atomic envelope integrity** — all items are compiled and authorized before execution; mode is inferred from bound operations, results map by index, and no partial result is returned after rollback.
20. **Endpoint access separation** — trusted-session access to Catalog, Explain, execution, and developer debug output is explicit; a code-generation credential cannot execute SQL, open a transaction, or retrieve an execution trace.
21. **Generated-artifact integrity** — query types are bound to endpoint, role, schema/policy/compiler/registry versions, and SQL hash; partial or stale generation never silently replaces current artifacts. Client role and schema/policy versions are immutable and checked against generated operations before sending. Endpoint/DB selection and artifact placement belong to the application; Clients do not infer them from an injected Transport. Generation records the published Catalog and Capabilities metadata; it does not invent unpublished compiler/registry versions.
22. **Execution-trace confidentiality** — exact protected SQL is captured only at the verified database-egress boundary, parameter values are redacted, and a response exposes it only when both deployment configuration and trusted-session `debug` access allow it.
23. **Database binding integrity** — the wrapper must explicitly supply a DB independently of policy-session authentication; no implicit fixed-env or JWT-based DB selection exists; one transaction pins one authorized database identity and runtime snapshot. DO delegation, callbacks, cost observations, and retries cannot substitute a different binding. Credentials remain local to the wrapper/transport. See [the binding contract](database-routing.md).
24. **Trusted-session input** — the wrapper authenticates every request (including every interactive command and commit) and passes the session as data; the library never sees a credential. Core validates the session once, before any body read, owner lookup, or database work; a malformed session is a 500 wrapper fault, a disallowed role or access a 403. For a keyed atomic execute, the engine answers 500 `POLICYSQL_OUTCOME_UNKNOWN` (`detail.cause` is the 403 and its path) instead of the 403, the unknown outcome: the retry may be of a write committed before a deploy changed the session policy (ADR 0007 #85 path 1; unkeyed execute keeps 403). Every interactive command keeps the 403, including a commit whose earlier request may have committed; that is the intentional commit-retry exception of ADR 0007 #104, because the gate runs before the owner and a denied caller must not learn from the owner's record whether the transaction exists or whether COMMIT may have been sent. Idempotency and the transaction fingerprint bind the wrapper-namespaced `principal`. See [ADR 0020](adr/0020-trusted-session-input-and-jwt-identity-adapter.md).

## Security properties

The mandatory invariants above say what the compiler must do. This section states what a client can learn or change as a result, as properties P1–P5 that tests, fuzzing, and verifiers try to refute (tracking issue #120). This document does not prove them; [Verification status](#verification-status) records what checks each property today.

### Terms

- **Regular, conditional, and forbidden columns** (通常列 / 条件付き列 / 禁止列). For a role's select policy on a resource, a column written as a string in `columns` is *regular*, a column written as `{name, visible_if, on_deny}` is *conditional*, and every other column is *forbidden*. A column that only the policy's `filter` or `visible_if` reads (for example `tenant_id`) is forbidden unless `columns` also lists it.
- **Visible view `View(D, σ)`** (可視ビュー). For a database state `D` and a trusted session `σ`, which includes the role, the virtual database in which, for each resource:
  1. only the rows on which the select policy's `filter` is SQL TRUE remain; a parent `exists` inside the `filter` is evaluated against all of `D` ([ADR 0029](adr/0029-select-filter-parent-exists.md));
  2. regular columns keep their values;
  3. a conditional column keeps its value on rows where `visible_if` is SQL TRUE, and is NULL with a redaction mark on the other rows;
  4. forbidden columns do not exist.

  A resource for which the role has no select policy does not exist in the view.
- **Binding Catalog** (束縛用 Catalog). The client's SQL is bound against the resources on which the role has a policy of any operation. A resource outside it and a name that does not exist are the same input to every step before the policy, so their answers are equal; this is wider than the view, which keeps only resources with a select policy.
- **Observation `Obs`** (観測). What the client receives: result column names, row values, redaction marks, row order when the statement has `ORDER BY`, affected-row counts, `RETURNING` rows, whether operation checks and `expect.affectedRows` succeed, public error codes, for a keyed unknown outcome the `detail.cause` (the code and path a compile, the session gate, or a body limit gave; they do not depend on `D`, see below), for a statement the database refused for a constraint, the kind of the constraint (one fixed value per statement: `unique`, `not_null`, `foreign_key`, `check`, `other`; [ADR 0030](adr/0030-error-detail-and-database-constraint-violations.md)), for a commit-check rejection, `detail.reason` (one of five fixed values: `denied`, `unavailable`, `limit`, `unconfigured`, `callback`; it depends on the validator and on the rows the callback session reads), for a limit refusal (413), `detail.limit`, the Capabilities key of the limit (a function of the client's request, the deployment, and the protected result, which for a mutation is the rows it changed, as the affected-row count already shows; never the configured number), whether a failed statement was refused by the database (500 `POLICYSQL_DATABASE_ERROR`; a data-dependent error of a client predicate falls under residual risk 3) or got no answer (503), and the `detail` of a compile or validation refusal (`span`, `feature`, `reason`, `complexity`, `expectation`: a fixed enumeration value, or a byte position in the client's own SQL; a compile-time `complexity` is a function of the client's SQL, the policy, and the deployment; a database-time `complexity` (for example `like_pattern`) and `expectation` also depend on `D`, and the former falls under residual risk 3). Response time, response size, and resource consumption are not part of `Obs` (see [Residual risks](#residual-risks)).
- **Low-equivalent states** (低等価な DB 対). Two database states `D1` and `D2` with `View(D1, σ) = View(D2, σ)`; they differ only in what the role cannot see.

A statement is *accepted* when it compiles and the verifier seals its plan. Compilation and sealing do not read the database, so whether a statement is rejected before execution, with which error code, and with which `detail`, does not depend on `D`.

### P1: read view equivalence

For an accepted SELECT `q`, the `Obs` of running the protected SQL on `D` equals the `Obs` of running `q` on `View(D, σ)`, except for the row cap of the policy `limit` described below.

Corollary (non-interference): for low-equivalent `D1` and `D2`, an accepted SELECT has the same `Obs` on both.

Policy `limit`: let `L` be the smallest of the client `LIMIT` and the `limit` of every select policy the statement reads (the root, every joined resource, and every client `EXISTS` resource), ignoring absent values. The protected result has at most `L` rows. When `ORDER BY` totally orders the result, those rows are exactly the first rows of the result of `q` on the view. Otherwise they are a sub-multiset of the result, on the view, of `q` with its `LIMIT` and `OFFSET` removed. The `limit` caps result rows, not the rows an aggregate reads: `COUNT(*)` counts every visible row. A JSON collection SELECT always returns one row and does not apply `limit`.

Known gap: a negative value for a client `LIMIT` parameter is accepted today and emitted as `MIN(:param, limit)`, which SQLite treats as no upper bound, so the cap does not hold for it. The deployment's `max_rows` still applies (#136). See [Verification status](#verification-status).

### P2: write confinement

An accepted UPDATE or DELETE changes only rows on which, in the pre-state, both the policy `filter` and the client `WHERE` are SQL TRUE; an accepted INSERT changes only the rows it inserts. The statement assigns only columns in the policy's `columns` and the keys of its `presets`; columns it does not assign take database-computed values (residual risk 7). Every preset value is a session value, a policy literal, or the compile's time (`now`: the host fact `now_ms`, [ADR 0031](adr/0031-server-time-presets.md)). For INSERT and UPDATE, if any changed row does not make `check` SQL TRUE, the whole statement fails and nothing changes. A delete policy has no `check`.

### P3: mutation observation non-interference

For an accepted INSERT, UPDATE, or DELETE, `Obs` is a function of `View(D, σ)`, the session, the client's SQL and parameters, the compile's time when a `now` preset is returned, and only the following exposures, which the mutation policy chooses to make:

1. the values of `returning.columns` in the changed rows: as written for INSERT and UPDATE, as they were before deletion for DELETE. An UPDATE shows the pre-state value of a column it does not assign, even when that column is not a select column;
2. for UPDATE and DELETE, whether the policy `filter` is SQL TRUE on each pre-state row;
3. for INSERT and UPDATE, whether every changed row makes `check` SQL TRUE: one bit per statement, even when `check` reads forbidden columns;
4. whether the matching `commit_checks` accept the transaction.

Scope (#118): P3 is required only of policies in which every row that satisfies the update or delete `filter` also satisfies the same role's select `filter`, or in which the role has no select policy for the resource (the client `WHERE` can then reference no column). PolicySQL deliberately does not compose the select `filter` into UPDATE or DELETE, as in Hasura (#118). With a wider mutation `filter`, the regular select columns of the rows in the difference can be inferred through the client `WHERE`, from `RETURNING`, the affected-row count, and an `expect.affectedRows` rollback. This follows from the specification, not from an implementation bug; policy authors are told in [operationごとのfilterの広さ](../website/admin/policies.md#operationごとのfilterの広さ). A policy lint that reports such policies at activation is planned (#134).

### P4: aggregate and window gates

A SELECT that contains an aggregate (an aggregate function, `GROUP BY`, or `HAVING`) anywhere in the statement is accepted only when the select policy of every resource whose rows it reads (the root, every joined resource, and every client `EXISTS` resource) has `allow_aggregations: true`. A window function likewise needs `allow_windows: true` on all of them. The only aggregate function today is `COUNT(*)` and the only window function is `ROW_NUMBER()`. A JSON collection SELECT aggregates with `json_group_array` and needs `allow_aggregations: true` on its resource. INSERT, UPDATE, and DELETE reject every aggregate and window. A parent resource that a select `filter` reads through `exists` ([ADR 0029](adr/0029-select-filter-parent-exists.md)) is policy-internal and is not gated.

### P5: server ownership

The values of session-derived server parameters (`__policysql_session_*`) and of preset columns are determined by the policy, the trusted session, and the compile's time (a host fact the client cannot supply) alone, and the values of `now` presets are bound to `__policysql_now_*`; they do not depend on the client's SQL or parameter values. The client can neither define nor bind a parameter in the `__policysql_` namespace: client parameter names with that prefix are rejected. Result column names with that prefix are rejected for SELECT, constant SELECT, client `EXISTS` projections, and `RETURNING`. Known gap: the output alias of a JSON collection SELECT is not checked for the prefix (#137; see [Verification status](#verification-status)).

Server literal parameters (`__policysql_literal_*`) carry string, bytes, and JSON literals from two sources: the client's SQL and the policy (filters, checks, presets). The name does not tell them apart. A literal from the client's SQL is client-chosen by design and outside P5; a literal from the policy is covered by P5. Invariant 11 checks the round trip of client string literals only.

### Relation to the mandatory invariants

| Invariant | Properties | Note |
| --- | --- | --- |
| 3 Bound authorization | P1–P4 | The properties are stated over resolved resources and columns. |
| 4 Complete coverage | P1, P2, P4 | A resource without a select policy is absent from the view; a mutation needs its own policy; every resource read is gated; a resource without any policy for the role is absent from binding. |
| 5 Column non-interference | P1, P3 | Forbidden columns are absent from the view; a mutation `WHERE` may use only regular select columns. `RETURNING` is governed by `returning.columns`, not by the select columns (P3 exposure 1). |
| 6 Row-policy composition | P1, P2, P3 | |
| 7 Server namespace integrity | P5 | |
| 8 Preset integrity | P2, P5 | |
| 13 Conditional-output-column non-interference | P1 | Stricter than P1: a conditional column is rejected outside direct projection even where the view would give it a value. |

### Past holes

| Issue | Property | What went wrong | Resolution |
| --- | --- | --- | --- |
| #114 | P1 | A client `EXISTS` outside `WHERE` (a JOIN `ON`, `HAVING`, or the SELECT list) reached the database without that resource's row policy. | Fixed (#113) |
| #116 | P3 | An UPDATE or DELETE `WHERE` could reference columns the role cannot read, which `RETURNING` and the affected-row count then revealed. | Fixed (#117) |
| #115 | P4 | `allow_aggregations` applied only to a `COUNT(*)` directly in the SELECT list, so `CASE`, `HAVING`, and JOINs bypassed it. | Fixed (#119) |
| #118 | P3 (specification) | An update or delete `filter` wider than the select `filter` lets the client `WHERE` probe rows that SELECT cannot see. | Not composed by decision; documented (#135); P3 scoped above; lint planned (#134) |

### Verification status

Update this table whenever a child issue of #120 lands. Today every property is checked only by fixtures and unit tests. No property is checked by fuzzing, by mutant patches, by an independent oracle compared with database results, or by types, and the emission verifier of invariant 11 does not check policy at all.

| Property | Checked today | Planned |
| --- | --- | --- |
| P1 | Fixtures under `tests/fixtures/sqlite-turso-v1/select/` and `security/`; policy-crate unit tests. The testkit's `evaluate_select_filter` evaluates one select `filter` on one hand-written row and is used by two tests. | Non-interference fuzzing (#125), mutant patches (#126), policy-aware verifier (#127), oracle differential for view equivalence (#131), slot coverage (#128, #129), types (#132, #133) |
| P2 | Mutation fixtures (`tests/fixtures/sqlite-turso-v1/mutation/`, including `update-now-preset`), `deploy/cloudflare/test/now.test.mjs`, and unit tests | #127, #131 |
| P3 | Unit test `mutation_where_is_limited_to_observable_columns`; fixtures `security/mutation-forbidden-filter-column` and `security/mutation-delete-forbidden-filter-column` | #125, #126; lint for the #118 scope (#134) |
| P4 | Unit test `aggregate_and_window_gates_cover_every_position_and_joined_resource`; fixtures `security/aggregate-*` and `security/window-joined-resource` | #125, #126 |
| P5 | Core and parser unit tests for the reserved namespace; fixtures `security/server-parameter-collision` and `mutation/update-now-preset`; `deploy/cloudflare/test/now.test.mjs` | #127 |

Known gaps:

- P1, JSON collection: the policy layer does not check the columns in the JSON path argument (#123). Execution is blocked today only because the result descriptor cannot be computed for a path that is neither a string literal nor a client parameter.
- P1, policy `limit`: a negative client `LIMIT` parameter removes the cap (see P1; #136).
- P3: the #118 scope above is a property of the specification.
- P5, JSON collection: the output alias is not checked against the `__policysql_` prefix (#137). Whether a client can exploit this is unverified.
- Existence of a hidden column, and its logical type: the binder and the decoding of parameter values run before the policy against the Binding Catalog, so a column the role cannot read is told from one that does not exist by an `INVALID_PARAMETER` on a type mismatch (`WHERE tenant_id = 1`), by `UNSUPPORTED_SQL` where a column is used as an inserted or assigned value, and by a policy refusal of another reason (aggregation or windows off) that precedes the column check; a hidden column that only a derived table or a CTE carries compiles (#141). The `detail` (`reason: type`, `feature: cast`) makes a second type-dependent failure cheaper to read; it adds no fact the code does not already give (#154). The test `a_missing_name_and_a_hidden_one_are_answered_alike_where_the_code_is_the_same` lists each place.
- Existence of a resource the role has a policy on, for any operation: a client can tell it from a name that does not exist (for example `DELETE FROM tasks WHERE nope = :v` is `FORBIDDEN_COLUMN` when the role has only a select policy on `tasks`, and `MISSING_POLICY` for a name that does not exist). The role's Explain compiles that resource, so its existence is information the policy gives. A resource the role has no policy on is not told from a name that does not exist (#145 pull request D).

## Residual risks

P1–P5 do not cover the following, and later stages of #120 do not change this. A deployment that must resist them needs measures outside the compiler (see [Defense in depth](#defense-in-depth)). Phase-specific residual risks are also recorded under [review-concerns](review-concerns/).

1. Inference from response time, resource consumption, or response size.
2. Inference of an invisible row's existence, or of the value of a column the role cannot read, from a constraint violation (part of `Obs`, but outside P1–P5): UNIQUE or PRIMARY KEY, FOREIGN KEY (a child's INSERT, a parent's DELETE), CHECK, NOT NULL, or a trigger. Whether the statement failed was always visible from whether the write happened. A constraint violation is now 409 `POLICYSQL_CONSTRAINT_VIOLATION` with the kind of the constraint (`other` for a trigger), so one request tells it reliably, and apart from a failure (503). A database refusal that is not a constraint (500 `POLICYSQL_DATABASE_ERROR`) is told apart from an outage; whether the statement failed was already visible. An UPDATE can also test, through a UNIQUE column, whether the non-public values of two rows are equal; that was possible before and returning the kind does not widen it. The measures are in the schema and the policy: put the tenant column in every UNIQUE key, and fix the scoping column (the tenant) with `presets`. A `check` alone is not enough, because it is evaluated on the row after the write: with `columns: [id, tenant_id, code]`, `check: tenant_id = session`, and `UNIQUE (tenant_id, code)`, an INSERT that names another tenant's `tenant_id` is a 409 `unique` when that tenant has the `code` and a 403 `POLICYSQL_CHECK_FAILED` when it does not. See [ADR 0030](adr/0030-error-detail-and-database-constraint-violations.md).
3. Errors or timing differences caused by evaluating a client predicate on rows the policy hides: SQLite does not guarantee the evaluation order of `client predicate AND policy predicate`. Whether the current function set can raise a data-dependent error is unverified. Such an error is a 500 `POLICYSQL_DATABASE_ERROR`, which one request tells from an outage (503); before, it was indistinguishable from an outage. The error was already visible as a failed statement.
4. Inference from the results of permitted aggregates, such as `COUNT(*)`.
5. Mistakes in the policy itself. The policy is trusted input, and P1–P5 hold for the policy as written, including a mutation `filter` wider than the select `filter` (P3 scope) and the logic of commit-check validators. The commit-check `reason` makes a validator's failure modes observable (`limit` against `denied`); a validator should deny rather than fail on a data condition.
6. Differences between SQLite and Turso, and between how `turso_parser` and the executing engine interpret SQL.
7. Side effects outside the model: triggers, cascades, generated columns, and database-assigned values such as defaults and rowid or `AUTOINCREMENT` values, which can depend on invisible rows.
8. Mistakes in the checkers themselves (test generators, oracles, verifiers), and misunderstandings of this specification that the implementation and its checkers share.

## Threats to test explicitly

- semicolon/comment statement smuggling;
- empty or oversized atomic statement arrays;
- mixed read/write mode misclassification and cumulative-limit bypass;
- build-token use against execution endpoints;
- generated types reused across roles, snapshots, endpoints, or SQL changes;
- quoted identifier confusion;
- alias shadowing;
- CTE shadowing of protected tables;
- correlated subquery bypass;
- forbidden-column inference through predicates or sort order;
- aggregate inference;
- outer-join policy placement errors;
- `NULL` three-valued-logic differences;
- parameter name collision;
- preset-column duplication;
- `RETURNING` leakage;
- conditional-output-column inference outside direct projection;
- duplicate or case-colliding result aliases;
- validation-hook timeout or malformed response;
- check-then-act race;
- parser/emitter differential;
- excessive recursion, joins, expressions, or result size;
- error messages revealing hidden schema or policy details.

## Defense in depth

Where available, use database-side protections in addition to compiler checks:

- least-privilege database credentials;
- isolated database per tenant where appropriate;
- engine authorizer callbacks in embedded deployments;
- query timeouts and result limits;
- immutable audit logs;
- independent differential tests against reference SQLite.

No defense-in-depth mechanism replaces policy compilation.
