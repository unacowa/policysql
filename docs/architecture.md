# Architecture

## Components

### Gateway

- authenticates the caller;
- constructs a trusted session;
- parses request envelopes and parameters;
- applies request limits;
- calls the compiler;
- executes protected SQL through an adapter;
- normalizes results and errors;
- emits audit events.

### Parser

- accepts exactly one statement per SQL-bearing request item;
- parses SQLite-compatible SQL;
- preserves parameter references and source locations;
- rejects malformed or unsupported syntax.

### Binder and catalog resolver

- resolves table, alias, CTE, and column references;
- detects ambiguous columns;
- assigns stable identities to base resources;
- tracks expression and output provenance;
- resolves logical types independently from SQLite storage classes;
- infers result types from catalog columns, operators, and registered function signatures.

### Policy Kernel

- selects policies by operation, resource, and role;
- validates referenced columns and operations;
- compiles row filters into relational predicates;
- applies policy limits;
- inserts server-owned presets;
- coordinates operation checks and transaction commit checks;
- emits an authorization/explain trace.

### SQLite emitter

- converts the protected bound representation into a `turso_parser` SQLite AST and serializes it with `ToTokens`;
- allocates collision-free server parameter names;
- never assembles SQL clauses by string concatenation and emits deterministic SQL.

### Invariant verifier

- re-parses emitted SQL and compares the resulting statement AST structurally;
- confirms all base-table accesses are protected;
- confirms no forbidden operation or column was introduced;
- confirms client values cannot bind server-only parameters;
- fails closed.

### Turso adapter

- sends protected SQL and parameters through a supported Turso Database transport;
- maintains transaction/pipeline state where required;
- enforces time, row, byte, and statement limits;
- validates returned storage classes and encoded values against compiled result descriptors;
- returns normalized execution metadata.

### Transaction owner

- owns one open Turso MVCC transaction;
- serializes client operations, commit-check queries, and final decisions;
- issues and revokes opaque callback capabilities;
- routes callback SELECT statements to the original transaction;
- is reached only through the `TransactionOwner` port
  (`deploy/cloudflare/src/transaction-owner-port.ts`,
  [ADR 0022](adr/0022-transaction-owner-port.md)). Routing: `route(name)` returns a typed
  handle (`begin`, `atomic`, `command`, `callbackQuery`) to the single owner of a transaction
  or validation id. Owner side: `TransactionOwnerCore(facilities, dependencies)` receives a
  durable `store`, one `timer`, `BackgroundTasks`, and optionally its `name` from the
  adapter. Routes and the core name no platform type;
- makes no transaction decision of its own: since [ADR 0024](adr/0024-transaction-step-machine.md)
  pull request 7 it executes the effects of core's step machine (`step_json`) for interactive
  transactions, and since pull request 8 for atomic executions too, keeping the durable and
  volatile state as the JSON texts the machine returns. The engine runs `execute` as the
  machine's `request` kind (`src/request-step.ts`): the direct placement in the engine, or a
  `forward` to the owner of an envelope that could trigger a commit check;
- the port's contract is at most one live owner per name, every call for the name delivered
  to it, and owner loss visible as a successor with the same store but no memory, which the
  core fails closed (ADR 0007). One conformance suite checks it for every adapter;
- on Cloudflare Workers the wrapper supplies the Durable Objects adapter
  (`src/adapters/durable-objects.ts`: namespace routing, object storage, alarm, `waitUntil`),
  the only library module that names Durable Objects. Tests also run on an in-memory adapter
  that is a test helper, not a shipped part.

## Compile flow

```text
Atomic request envelope
  -> authenticate
  -> trusted session
  -> pin one policy/Catalog/registry snapshot
  -> for each statements[] item:
       parse exactly one SQL statement
       validate SQL subset and parameters
       bind against catalog
       discover accessed resources/columns
       load and compile applicable policies and presets
       plan operation checks
       emit protected SQL
       re-parse and verify invariants
  -> infer read or write transaction mode
  -> validate idempotency and cumulative limits
  -> execute protected statements in array order
  -> run mutation operation checks
  -> optionally enter commit-check validation
  -> commit or roll back
  -> return ordered results[]
  -> audit
```

## Internal representation

PolicySQL avoids defining a new public query IR. Internally it still needs a bound representation because a parser syntax tree does not answer questions such as:

- Which base table does `x.id` reference?
- Does a projected expression reveal a forbidden column?
- Does an unqualified column resolve ambiguously?
- Which policy applies to a CTE or nested subquery access?
- Did an outer join preserve its semantics after row-filter injection?

The internal representation is an implementation detail and can evolve without changing the public SQL interface.
