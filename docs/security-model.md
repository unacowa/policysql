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
5. **Column non-interference** — forbidden columns cannot influence projection, filtering, joins, grouping, ordering, aggregates, windows, subqueries, or `RETURNING`.
6. **Row-policy composition** — client predicates cannot replace, weaken, negate, or shadow policy predicates.
7. **Server namespace integrity** — clients cannot define, override, or bind server-owned parameters.
8. **Preset integrity** — clients cannot override policy-owned mutation columns.
9. **Atomic mutation checks** — when post-state checks are required, the write and check must be one atomic unit or the operation is unsupported.
10. **Fail closed on ambiguity** — ambiguous identifier, type, provenance, transaction, or engine semantics cause rejection.
11. **Emission verification** — protected SQL is re-parsed and independently checked before execution.
12. **Resource bounds** — each statement and the enclosing transaction have bounded time, rows, result bytes, nesting depth, joins, parameters, expression complexity, and statement count.
13. **Conditional-output-column non-interference** — conditionally visible columns can affect only their direct output cells, never filtering, joins, ordering, grouping, windows, functions, or derived expressions.
14. **Result identity** — every output column has a unique, non-empty name before rows or redaction metadata are encoded.
15. **Authentication canonicalization** — duplicated or ambiguous authentication headers, role identifiers, claim mappings, or reserved session keys are rejected before SQL parsing.
16. **No session coercion** — trusted-session strings are never implicitly coerced through SQLite affinity; policy activation proves descriptor compatibility.
17. **Snapshot integrity** — one request or transaction uses one immutable policy, Catalog, type-registry, and function-registry snapshot; stale preconditions fail before execution.
18. **Retry integrity** — a write retry is bound to authenticated context, endpoint, idempotency key, and canonical payload and cannot execute a different request.
19. **Atomic envelope integrity** — all items are compiled and authorized before execution; mode is inferred from bound operations, results map by index, and no partial result is returned after rollback.
20. **Endpoint access separation** — JWT access to Catalog, Explain, execution, and developer debug output is explicit; a code-generation credential cannot execute SQL, open a transaction, or retrieve an execution trace.
21. **Generated-artifact integrity** — query types are bound to endpoint, role, schema/policy/compiler/registry versions, and SQL hash; partial or stale generation never silently replaces current artifacts.
22. **Execution-trace confidentiality** — exact protected SQL is captured only at the verified database-egress boundary, parameter values are redacted, and a response exposes it only when both deployment configuration and JWT `debug` access allow it.

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
