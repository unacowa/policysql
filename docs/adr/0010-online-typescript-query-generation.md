# ADR 0010: Online TypeScript query generation through Explain

- Status: superseded in part by ADR 0013

## Decision

The first official TypeScript query generator compiles static SQL online through `POST /v1/transactions:explain`. It does not connect directly to Turso or execute SQL. Explain returns client parameter descriptors and final result-column descriptors for every statement.

The generator authenticates with a dedicated JWT containing the target roles and only `catalog` and `explain` access. It must not receive `execute` access or database credentials. Generated artifacts are keyed by endpoint identity, role, schema version, policy version, compiler and registry versions, and canonical SQL hash.

`policysql generate` is an explicit build step. Generated TypeScript may be committed or retained as a CI artifact. `tsc`, application builds that consume current artifacts, and application runtime do not contact PolicySQL for type generation.

Explain retains the Atomic Execute envelope. Each item includes `sql` and `params`; code generation sends an empty object when no runtime values exist. Explain infers named-parameter descriptors from bound usage and fails when the type cannot be proven. Runtime values never determine a static descriptor.

## Rationale

TypeScript cannot soundly infer arbitrary SQL semantics from a runtime string. Catalog introspection alone also cannot determine aliases, literals, functions, joins, aggregation, expression nullability, or role-specific output behavior. Using the authoritative PolicySQL compiler prevents a second client-side SQL type system from drifting from gateway enforcement.

## Consequences

- Explain's `parameters` and `result.columns` are stable client-generation contracts and cannot be redacted from an authorized response.
- One failed query fails the generation run; output files are replaced only after every query succeeds.
- Generated operations pin runtime execution to the schema and policy versions used during generation.
- Network or authentication failure blocks regeneration but does not affect `tsc` when current generated artifacts are available.
- Offline compiler bundles may be added later, but are not part of the first official workflow.
- Unaliased expressions remain representable using quoted property names, but generators recommend explicit aliases.
