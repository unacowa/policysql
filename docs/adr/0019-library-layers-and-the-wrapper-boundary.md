# ADR 0019: Library layers and the wrapper boundary

- Status: proposed
- Related: [ADR 0011](0011-use-versioned-backend-profiles-for-multi-database-support.md),
  [ADR 0014](0014-wrapper-provided-database-bindings.md),
  [ADR 0015](0015-client-library-boundaries.md),
  [ADR 0018](0018-wrapper-owned-rate-limiting.md)

## Context

PolicySQL is a library. It is not written for one application, and it is not meant to lock
a deployment into one hosting platform. Two boundaries are already decided:

- ADR 0011 fixes the Rust/TypeScript boundary. Policy selection, binding, SQL rewriting,
  invariant verification, and result validation are authoritative Rust code. TypeScript
  performs transport and platform lifecycle work only.
- ADR 0014, ADR 0015, and ADR 0018 each move one responsibility out of the library: database
  selection, client transport, and request-rate limiting.

What is not decided is the boundary between the HTTP service code the library ships and the
code a deployment writes. The published `@unacowa/policysql/cloudflare` entry point contains
HTTP routes, JWT verification, idempotency, cost admission, transaction ownership, commit-check
coordination, safe errors, and execution traces. ADR 0014 and ADR 0018 each argued their case
from scratch because no document says which of these belong to the library and why.

The documentation also describes a structure that does not exist:

- `README.md` and `docs/system-architecture.html` call the `policysql-gateway` crate the
  "HTTP service composition root" with authentication, session, and audit. The crate does
  request orchestration and compilation only. It has no HTTP code. Its `JwtVerifier` trait
  is unused; JWT verification lives in `deploy/cloudflare/src/auth.ts`.
- `docs/architecture.md` describes one "Gateway" component that authenticates, limits,
  compiles, executes, normalizes, and audits. Rate limiting left the library in ADR 0018,
  and the rest is split between Rust and TypeScript.
- `docs/architecture.md` says the transaction owner "exposes a platform-neutral core
  interface". `TransactionOwnerCore` uses Durable Object storage and alarms directly, and the
  routes call `TRANSACTION_OWNER.idFromName` directly. No neutral interface exists.

Without a stated rule, each new feature decides its own home, deployment assumptions leak
into the library (ADR 0018 removed one), and the published package cannot say what it
promises to every deployment and what it leaves to each.

## Decision

PolicySQL consists of three layers. Code is placed by the rules below, and the placement is
part of each feature's review.

### Layer 1: the compiler library

The Rust workspace: `policysql-core`, `-ir`, `-catalog`, `-parser`, `-policy`, `-sqlite`,
`-execution`, `-turso`, `-gateway`, and the WASM ABI crate that exposes them to a JavaScript
host (currently `policysql-cloudflare`).

- Owns every authorization decision and every security invariant in `docs/security-model.md`.
- Has no HTTP, no platform API, and no deployment configuration. It receives a trusted
  session, a request envelope, a Catalog/policy snapshot, and raw database results, and
  returns verified plans, validated results, and safe error categories.
- The WASM ABI crate is a host-neutral packaging of the compiler, not a Cloudflare component.
  Its only host coupling is `wasm-bindgen`.

### Layer 2: the HTTP service library

The TypeScript package published as `@unacowa/policysql/cloudflare` (`deploy/cloudflare/src`).
It implements the public PolicySQL HTTP protocol in `spec/openapi.yaml` and `docs/http-api.md`
on top of layer 1.

A responsibility belongs to layer 2 when at least one of these holds:

1. **The public protocol defines its observable behavior.** Routes, request and response
   shapes, status codes, `POLICYSQL_*` error codes, headers such as `Idempotency-Key` and
   `PolicySQL-Role`, Capabilities, Catalog, Explain, and the interactive-transaction and
   commit-check protocols. A client written against the spec must behave the same against
   every deployment.
2. **It is a security invariant that must hold in every deployment and that the wrapper
   cannot verify from outside.** Building the trusted session from a verified JWT (ADR 0005),
   re-authenticating every interactive command against the transaction fingerprint, binding
   idempotency identity to issuer, subject, role, session, and database (ADR 0014),
   validating commit-check callback capabilities, routing raw database results through the
   Rust result validator before encoding a response, and redacting execution traces.
3. **It needs the compiled plan or the trusted session.** Cost admission reads the plan's
   resources and limits; commit-check triggering reads the plan's mutation set.

Layer 2 therefore keeps: route registration, JWT verification and trusted-session
construction, request envelope parsing and size limits, idempotency, cost admission,
transaction ownership and owner delegation, the commit-check protocol, result validation
egress, safe error normalization, the execution trace, and `/healthz`.

Layer 2 does not decide deployment policy. It does not choose a database, limit request
rate, pick a tenant, read platform-specific client metadata such as `cf-connecting-ip`, or
write to a log or audit sink of its own choosing beyond structured `console.log` events.

### Layer 3: the wrapper

Deployment-owned code that is never published: `deploy/cloudflare/wrapper/` is the
reference, `examples/database-routing/` is a second one. A wrapper owns the platform entry
point and everything that runs before `app.fetch` or `app.fetchCallback`.

A responsibility belongs to layer 3 when it answers a question only the deployment can
answer: which requests to serve, from whom, how many, against which database, with which
credentials, on which platform, with logs and metrics sent where. Today that is the Worker
`fetch` export, loading Catalog/policy/schema artifacts, database registration and
selection (ADR 0014), credentials, request-rate limiting (ADR 0018), the Durable Object
class export, platform bindings and secrets, and any allowlisting, tracing sink, or metrics
export.

A wrapper may wrap layer 2, but it may not reach into it: no raw SQL path, no alternate
route into the Hono app, no construction of verified plans, and no substitution of a
different database binding after one is pinned (ADR 0014). Layer 2 exposes exactly
`createApp`, `createPolicySqlWorker`, `createRuntimeFactory`, `TransactionOwnerCore`,
`TursoHttpTransport`, `createErrorResponse`, and the types a wrapper needs to implement
`DatabaseProvider`, `DatabaseTransport`, and error responses in the public format.

### Configuration contract

Layer 2 reads deployment configuration from the `env` object the wrapper passes to
`app.fetch`, under a fixed set of `POLICYSQL_*` names, plus the names a policy's commit-check
definition points at for validator URLs and HMAC secrets, plus the `TRANSACTION_OWNER`
Durable Object binding. These names are the configuration contract of the current Cloudflare
adapter and are documented with the adapter. The library reads nothing else from `env`, and a
wrapper must not depend on the library reading any other name.

The direction for the next breaking change is an explicit configuration object passed to
`createPolicySqlWorker`, so that layer 2 never touches `env` and the platform binding object
stays in layer 3. That change is not made by this ADR.

### Platform coupling

Layer 2 is currently the Cloudflare Workers adapter. It requires a Durable Object namespace
for transaction ownership, a Workers `ExecutionContext`, and a Wrangler-bundled WASM import.
These are platform lifecycle concerns and are allowed in layer 2 by ADR 0011. They are not
part of the library's protocol or security promises, and `docs/architecture.md` must not
describe a platform-neutral transaction core until one exists. Splitting layer 2 into a
platform-neutral HTTP core and a Cloudflare adapter requires its own ADR, which would have
to define the transaction-ownership, WASM-loading, and request-metadata interfaces.

### Placement review

Every pull request that adds or moves a server-side responsibility states which layer it
lands in and which rule above places it there. A responsibility that fits no layer-2 rule
goes to the wrapper, with a reference implementation in `deploy/cloudflare/wrapper/`, as
ADR 0018 did. Moving a responsibility from layer 2 to layer 3 is a breaking change and
needs an ADR; while PolicySQL is in beta, no compatibility layer or migration guide is
required.

## Consequences

- The published package's promise is stated: it implements the public protocol and the
  cross-deployment security invariants, and nothing deployment-specific.
- ADR 0014 and ADR 0018 are instances of the layer-3 rule. Future requests to add tenant
  logic, client-IP handling, logging sinks, or per-deployment allowlists to the library are
  answered by this ADR rather than case by case.
- Documentation corrections required by this ADR:
  - `README.md` repository map: describe `policysql-gateway` as request orchestration over
    one backend profile with no HTTP; add the three layers; point to this ADR.
  - `docs/architecture.md`: replace the single "Gateway" component with the three layers,
    drop rate limiting, and remove the "platform-neutral core interface" claim from the
    transaction owner until it is true.
  - `docs/system-architecture.html`: same crate description fix.
  - `docs/database-routing.md` and the adapter README: document the `POLICYSQL_*`
    configuration contract in one place.
- The unused `JwtVerifier` trait in `policysql-gateway` is either removed or kept as the
  intended Rust-side verification hook; see open question 3.
- The WASM ABI crate name `policysql-cloudflare` misstates its layer; see open question 2.
- No code behavior changes with this ADR.

## Open questions

These need a decision before this ADR moves to accepted.

1. **JWT verification placement.** This ADR keeps JWT verification and trusted-session
   construction in layer 2 under rule 2, because the trusted session feeds policy
   selection, idempotency identity, and the interactive-transaction fingerprint, and a
   wrapper-supplied session could not be verified by the library. The alternative is a
   wrapper-verified session passed in as data, which would make the library trust the
   wrapper for every authorization input. Confirm layer 2.
2. **Rename the WASM ABI crate.** `policysql-cloudflare` contains no Cloudflare code.
   Renaming it (for example `policysql-wasm`) also renames the committed package under
   `deploy/cloudflare/pkg/`. Confirm whether to do this now or leave it until the
   platform-neutral split.
3. **`JwtVerifier` in `policysql-gateway`.** Delete the unused trait, or keep it as the
   target for moving verification into Rust later. Deleting is the smaller change; keeping
   it needs a note saying it is unused.
4. **Explicit configuration object.** The ADR records this as the direction for the next
   breaking change but does not schedule it. Confirm whether to open an issue now.
5. **Durable Object dependency.** The ADR explicitly defers the platform-neutral split to a
   separate ADR. Confirm that this stays out of scope, given the earlier decision to defer
   the lock-in work.
