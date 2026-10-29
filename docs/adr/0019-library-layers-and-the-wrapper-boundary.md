# ADR 0019: Library layers, adapters, and the wrapper boundary

- Status: accepted
- Issues: #30, #31, #32, #33, #34, #35
- Related: [ADR 0005](0005-jwt-and-trusted-session-contract.md),
  [ADR 0007](0007-transaction-retry-and-commit-check-protocol.md),
  [ADR 0011](0011-use-versioned-backend-profiles-for-multi-database-support.md),
  [ADR 0014](0014-wrapper-provided-database-bindings.md),
  [ADR 0015](0015-client-library-boundaries.md),
  [ADR 0018](0018-wrapper-owned-rate-limiting.md)

## Context

PolicySQL is a library. It is not written for one application, and it must not lock a
deployment into one hosting platform. ADR 0011 fixed the Rust/TypeScript boundary, and
ADR 0014, ADR 0015 and ADR 0018 each moved one responsibility out of the library. No
document says where the published server code ends and deployment code begins, or how
to decide.

The current code shows the cost of that gap:

- The published `@unacowa/policysql/cloudflare` package mixes the public HTTP protocol,
  JWT verification, transaction coordination, and direct use of Cloudflare APIs
  (`env` bindings, `DurableObjectNamespace`, `ExecutionContext`, `cf-ray`).
- About 1,900 lines of TypeScript decide transaction, idempotency, commit-check, and
  cost-admission outcomes. ADR 0011 says the transaction safety state machine is
  authoritative Rust code. A synchronous Rust version (`execute_checked_transaction`)
  exists but no production path uses it.
- Session shape is validated twice (TypeScript `auth.ts` and Rust `activate_auth`), and
  the error-code-to-status table lives in TypeScript while the codes are defined in Rust.
- `README.md`, `docs/architecture.md`, and `docs/system-architecture.html` describe a
  `policysql-gateway` HTTP composition root and a platform-neutral transaction core that
  do not exist.

The design is judged against four properties: few concepts, rules without exceptions,
no dependency on a specific platform, and changes that land in one place.

## Decision

### Three layers

PolicySQL has exactly three layers. Each boundary has a one-question rule.

| Layer | Role | Owner |
| --- | --- | --- |
| Wrapper | Per-deployment decisions: who the caller is, which database, whether to admit the request. Assembles adapters. | Deployment, never published |
| Engine | Executes operations: waits on I/O, persists cross-request state, keeps timers. Makes no decision whose outcome the PolicySQL specification determines. | Library (TypeScript) |
| Core | Every decision and computation: authorization, SQL protection, result validation, session validation, transaction state transitions. Pure functions. | Library (Rust, WASM ABI crate) |

- **Engine or wrapper:** does it need knowledge only the deployment has (identity
  provider, tenancy, database registry, credentials, platform, log destinations)? Then
  it belongs to the wrapper.
- **Core or engine:** does it wait, persist across requests, or read time? Then it belongs
  to the engine. Everything else is a decision and belongs to core.

### Adapters are not layers

An adapter is glue with no decisions of its own. It translates between an engine contract
and something outside: a transport protocol, a platform API, a database wire format, or
an identity provider. Adapters are replaceable, some request paths bypass them, and the
library ships them as optional parts. The wrapper chooses and configures them.

- **Inbound adapter:** the HTTP mapping. It is the canonical implementation of the public
  HTTP protocol (`spec/openapi.yaml`, `docs/http-api.md`): routes and methods to operations,
  headers to operation fields, `Content-Type`, `Content-Length`, streamed size limits,
  `POLICYSQL_*` codes to HTTP status (the only status table), fixed headers, ETag and 304.
  A request arriving through a service binding or an in-process call invokes engine
  operations directly.
- **Outbound adapters:** implementations of engine ports. For Cloudflare: Turso HTTP and the
  serverless driver (`DatabaseProvider`), Durable Objects (`TransactionOwner`),
  `ExecutionContext.waitUntil` (`BackgroundTasks`), the Wrangler WASM import
  (`WasmModule`), and `console.log` (`Logger`).
- **Identity adapter:** JWT verification that produces a trusted session. The wrapper calls
  it; the engine never sees a credential.

An adapter carries mechanism guarantees, not decisions: the owner adapter guarantees one
live owner per identifier; the database adapters bound response size and decode BLOBs
correctly. Each port states its guarantees, and the library ships a conformance suite that
a custom adapter must pass. Counting adapters as layers would make HTTP, Turso, and Durable
Objects each a layer, so they are not.

### Engine contract

The engine exposes operations, not HTTP. They match the client `PolicySqlTransport` kinds
(ADR 0015):

```ts
engine.execute({ bodyText, idempotencyKey?, role? }, { session, database, requestId? })
// also: explain, begin, statement, commit, rollback, catalog, capabilities
engine.callbackQuery({ validationId, capability, bodyText })
// result: a success value, or { code: "POLICYSQL_*", message, path }
```

At construction the engine receives only ports: `DatabaseProvider`, `TransactionOwner`,
`BackgroundTasks`, `Logger` / `TraceSink`, `WasmModule`, and `Config`. It reads no `env`
object and no platform type. It still performs the transport-independent checks on the
body text: strict UTF-8, duplicate JSON keys, and the total body limit, so that parser
differentials are handled in one place for every transport.

### Trusted session as data

The wrapper authenticates the caller and passes the result as data:
`{ principal, roles, defaultRole, access, session }`. `principal` is a stable identifier
that the wrapper namespaces itself (for example `issuer:subject`). The engine never
verifies a credential and never returns 401; `POLICYSQL_AUTHENTICATION_FAILED` stays in
the public contract as a wrapper-returned code, like `POLICYSQL_RATE_LIMITED`.

Core validates the session once, authoritatively, before the engine reads the body,
looks up an owner, or connects to a database: identifier syntax, string values, reserved
keys, `defaultRole` in `roles`, `access` as a non-empty subset of the known scopes, and
role selection through `PolicySQL-Role`. A malformed session is a wrapper fault and fails
with 500 `POLICYSQL_INTERNAL`. A role or access the client asked for but may not use stays
403. Idempotency identity and the interactive-transaction fingerprint use `principal`
instead of the JWT issuer. Stopping commands after token expiry or revocation becomes a
wrapper obligation, because the library no longer sees the token.

### Core owns transaction decisions, without holding state

Core exposes transaction rules as a pure transition function:

```rust
fn step(state: TxState, event: TxEvent) -> (TxState, Vec<Effect>)
```

State is a value. The engine stores it through the `TransactionOwner` port, performs each
`Effect` (execute a plan, call a validator, commit, roll back, set a timer, respond), and
feeds each outcome back as an event. Time and randomness enter as event fields. Core
validates any state it receives back for shape and version and fails closed. The
execution-handle table that keeps verified plans inside WASM remains as a per-request
exception; no state crosses requests inside core. The detailed ABI is a separate ADR
under #35.

### Rejected alternatives

- **HTTP as a fourth layer.** It makes no decisions and some paths bypass it.
- **The whole engine in core.** Asynchronous I/O would cross the WASM boundary through host
  callbacks, the purity that core's verification argument relies on would be lost, and the
  location of cross-request state is decided by the platform anyway.
- **Transaction decisions as pure TypeScript.** Locality improves, but "every decision is in
  core" gains an exception and the specification is split across two languages.
- **HTTP as the engine input.** Tests and non-HTTP entry points stay heavy, and the status
  table stays split between Rust and TypeScript.

### Placement review

Every pull request that adds or moves a server-side responsibility names its place by
asking, in order: does it need deployment knowledge (wrapper); is it fixed translation
with no decision (adapter); does it wait, persist, or read time (engine); otherwise core.
Moving a responsibility across a boundary is a breaking change recorded in an ADR. While
PolicySQL is in beta, no compatibility layer or migration guide is required.

## Migration

Each stage is useful on its own and ships as its own pull requests.

1. **Input contract (#33).** Move credential verification to the wrapper, accept the
   session as data, validate it once in core, ship JWT as an identity adapter.
2. **Ports and outbound adapters (#30, #31, #32).** Rename the WASM ABI crate and remove the
   unused `JwtVerifier`; define `TransactionOwner` and move Durable Objects behind it;
   replace `env` reads with `Config`.
3. **Operations API and the HTTP adapter (#34).** Expose engine operations, move HTTP into
   the inbound adapter, make the status table single-sourced and exhaustively tested.
4. **Transaction decisions into core (#35).** Design the `step` ABI in its own ADR and
   replace the TypeScript decisions.

Every stage must keep the existing test suites green and pass the real-environment smoke
run (`deploy/cloudflare/scripts/provision-dev.mjs`) before merge.

## Consequences

- The published package promises the public protocol and the cross-deployment security
  invariants, and nothing deployment-specific.
- Each kind of change has one home: policy, SQL, and transaction rules in core; HTTP
  framing in the HTTP adapter; a new platform in new outbound adapters; a new deployment
  in the wrapper.
- ADR 0014 and ADR 0018 are instances of the wrapper rule. ADR 0005 splits into the
  trusted-session contract (core) and the JWT profile (identity adapter). ADR 0011's
  statement that transaction safety is authoritative Rust becomes true after stage 4.
- `spec/openapi.yaml` changes its security scheme from a fixed bearer JWT to
  deployment-defined authentication.
- Documentation that describes structure the code does not have is corrected as each stage
  lands: the `policysql-gateway` description in `README.md` and
  `docs/system-architecture.html`, and the Gateway and transaction-owner sections of
  `docs/architecture.md`.
- Costs: stage 4 rewrites roughly 1,900 lines of TypeScript decisions in Rust and adds
  state serialization to the ABI; the library has two public surfaces (operations and
  HTTP); the engine trusts the wrapper's session and database the same way ADR 0014
  already trusts the database binding.
