# ADR 0019: Library layers and the wrapper boundary

- Status: proposed
- Issues: #30, #31, #32
- Related: [ADR 0005](0005-jwt-and-trusted-session-contract.md),
  [ADR 0011](0011-use-versioned-backend-profiles-for-multi-database-support.md),
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
host.

- Owns every authorization decision and every security invariant in `docs/security-model.md`.
- Has no HTTP, no platform API, and no deployment configuration. It receives a trusted
  session, a request envelope, a Catalog/policy snapshot, and raw database results, and
  returns verified plans, validated results, and safe error categories.
- The WASM ABI crate is a host-neutral packaging of the compiler, not a Cloudflare component.
  Its only host coupling is `wasm-bindgen`. It is currently named `policysql-cloudflare`;
  #30 renames it so that the name states its layer.
- Credential verification does not belong here. The unused `JwtVerifier` trait in
  `policysql-gateway` is removed (#30).

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
   cannot verify from outside.** Validating and canonicalizing the trusted session the
   wrapper supplies (ADR 0005 identifier and value rules, reserved keys, the `access` set),
   selecting the role through `PolicySQL-Role`, re-checking every interactive command against
   the transaction fingerprint, binding idempotency identity to principal, role, session, and
   database (ADR 0014), validating commit-check callback capabilities, routing raw database
   results through the Rust result validator before encoding a response, and redacting
   execution traces.
3. **It needs the compiled plan or the trusted session.** Cost admission reads the plan's
   resources and limits; commit-check triggering reads the plan's mutation set.

Layer 2 therefore keeps: route registration, trusted-session validation and role selection,
request envelope parsing and size limits, idempotency, cost admission, transaction
ownership, the commit-check protocol, result validation egress, safe error normalization,
the execution trace, and `/healthz`.

Layer 2 does not decide deployment policy. It does not verify credentials, choose a
database, limit request rate, pick a tenant, read platform-specific client metadata such as
`cf-connecting-ip`, or write to a log or audit sink of its own choosing beyond structured
`console.log` events.

### Trusted session as data

The wrapper authenticates the caller and passes the result to layer 2 as data: a principal
identifier, the roles the caller may select, the default role, the `access` set, and the
session key-value map. How the wrapper obtains them (a JWT, a platform identity service, a
mutual-TLS certificate, a signed internal header) is the wrapper's business. Layer 2 never
sees a credential, never reads a JWKS, and never returns 401 `POLICYSQL_AUTHENTICATION_FAILED`;
that code stays in the public contract as the code a wrapper uses, the same way
`POLICYSQL_RATE_LIMITED` does after ADR 0018.

Layer 2 still validates the supplied session against the ADR 0005 contract and fails closed
on any violation: identifier syntax, string-only values, reserved keys, `default_role` in
`roles`, a non-empty `access` subset of the known scopes, and `PolicySQL-Role` selecting a
member of `roles`. The session is passed per request, like the database binding in ADR 0014;
a missing session is a wrapper fault and is rejected before any compilation. The reference
wrapper ships a tested JWT verifier that produces this object, so a deployment that uses JWTs
as today changes only its entry point.

The consequences of this placement are listed under "Open questions" until confirmed.

### Layer 3: the wrapper

Deployment-owned code that is never published: `deploy/cloudflare/wrapper/` is the
reference, `examples/database-routing/` is a second one. A wrapper owns the platform entry
point and everything that runs before `app.fetch` or `app.fetchCallback`.

A responsibility belongs to layer 3 when it answers a question only the deployment can
answer: which requests to serve, from whom, how many, against which database, with which
credentials, on which platform, with logs and metrics sent where. That is the Worker
`fetch` export, loading Catalog/policy/schema artifacts, credential verification and
trusted-session construction, database registration and selection (ADR 0014), database
credentials, request-rate limiting (ADR 0018), the Durable Object class export, platform
bindings and secrets, and any allowlisting, tracing sink, or metrics export.

A wrapper may wrap layer 2, but it may not reach into it: no raw SQL path, no alternate
route into the Hono app, no construction of verified plans, and no substitution of a
different database binding after one is pinned (ADR 0014). Layer 2 exposes exactly
`createApp`, `createPolicySqlWorker`, `createRuntimeFactory`, `TransactionOwnerCore`,
`TursoHttpTransport`, `createErrorResponse`, and the types a wrapper needs to implement
`DatabaseProvider`, `DatabaseTransport`, the trusted session, and error responses in the
public format.

### Configuration contract

Layer 2 currently reads deployment configuration from the `env` object the wrapper passes
to `app.fetch`, under a fixed set of `POLICYSQL_*` names, plus the names a policy's
commit-check definition points at for validator URLs and HMAC secrets, plus the
`TRANSACTION_OWNER` Durable Object binding. These names are the configuration contract of
the current Cloudflare adapter and are documented with the adapter. The library reads
nothing else from `env`, and a wrapper must not depend on the library reading any other
name. The JWT names leave this contract together with credential verification.

#32 replaces `env` reads with an explicit configuration object passed to
`createPolicySqlWorker`, so that layer 2 never touches the platform binding object. Until
then, the `env` names above are the contract.

### Platform coupling

Layer 2 is currently the Cloudflare Workers adapter. It requires a Durable Object namespace
for transaction ownership, a Workers `ExecutionContext`, and a Wrangler-bundled WASM import.
These are platform lifecycle concerns and are allowed in layer 2 by ADR 0011. They are not
part of the library's protocol or security promises, and `docs/architecture.md` must not
describe a platform-neutral transaction core until one exists.

Transaction ownership becomes a modular boundary inside layer 2 (#31): layer 2 defines the
owner interfaces (routing a transaction or validation identifier to one serialized owner,
and the owner's storage, alarm, and background-continuation needs), the routes and
`TransactionOwnerCore` use only those interfaces, and the Durable Object implementation
becomes a separately assembled module that the wrapper supplies. The interface design is
recorded in its own ADR under #31, because it must preserve the ADR 0007 and ADR 0014
guarantees, in particular that one identifier never has two live owners.

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
- Scheduled work: #30 (crate rename, `JwtVerifier` removal), #31 (transaction-owner
  interfaces and Durable Object module), #32 (explicit configuration object). Moving
  credential verification to the wrapper gets its own issue once confirmed.
- ADR 0005 needs to be split: the trusted-session contract (layer 2 validates it) stays an
  ADR; the JWT profile (claims object location, `policysql` claim, algorithm allowlist,
  issuer and audience checks) becomes the reference wrapper's documented behavior.
- `spec/openapi.yaml` changes its security scheme from a fixed bearer JWT to
  deployment-defined authentication, and `POLICYSQL_AUTHENTICATION_FAILED` is documented as a
  wrapper-returned code.
- Documentation corrections required by this ADR:
  - `README.md` repository map: describe `policysql-gateway` as request orchestration over
    one backend profile with no HTTP; add the three layers; point to this ADR.
  - `docs/architecture.md`: replace the single "Gateway" component with the three layers,
    drop rate limiting and authentication, and remove the "platform-neutral core interface"
    claim from the transaction owner until #31 makes it true.
  - `docs/system-architecture.html`: same crate description fix.
  - `docs/database-routing.md` and the adapter README: document the configuration contract
    in one place until #32 replaces it.
- No code behavior changes with this ADR.

## Open questions

1. **Trusted session as data (wrapper-verified authentication).** This is the direction
   chosen during review. The following consequences were identified and need acceptance
   before the ADR moves to accepted:
   - Layer 2 trusts the wrapper for every authorization input. A wrapper bug is an
     authorization bypass that the library's own tests cannot catch. The shape validation
     above and a tested reference JWT verifier are the mitigations.
   - Interactive transactions re-check each command against a fingerprint of issuer,
     subject, role, session, and database. The issuer comes from `POLICYSQL_JWT_ISSUER`,
     which leaves. The session object needs a stable principal field that the wrapper
     namespaces itself (for example `issuer:subject`), and the wrapper must authenticate
     every request, including every interactive command and commit, before `app.fetch`.
   - Token expiry and revocation currently stop further commands and commit. The library
     cannot observe them once credentials leave it; only the wrapper can refuse the
     request. ADR 0005's "expiry prevents commit" guarantee becomes a wrapper obligation.
   - Idempotency identity also includes the issuer; same replacement as above.
   - `/healthz` readiness currently reports whether JWT configuration is present. That
     check moves to the wrapper or is removed.
   - Commit-check callbacks are unaffected: they use a capability token, and the callback
     session is derived from the stored session.
   - Many `deploy/cloudflare` tests mint JWTs; they move to supplying session objects
     directly, with the JWT path tested in the wrapper tests. `jose` leaves the library's
     dependencies.
