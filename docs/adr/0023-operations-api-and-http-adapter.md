# ADR 0023: The operations API and the HTTP inbound adapter

- Status: accepted
- Issue: #34 (stage 3 of [ADR 0019](0019-library-layers-and-the-wrapper-boundary.md))
- Related: [ADR 0015](0015-client-library-boundaries.md),
  [ADR 0020](0020-trusted-session-input-and-jwt-identity-adapter.md),
  [ADR 0021](0021-explicit-engine-config.md),
  [ADR 0022](0022-transaction-owner-port.md)

## Context

ADR 0019 decided that the engine exposes operations, not HTTP, and that HTTP is an inbound
adapter holding the only status table. Before this change, Hono routes were the engine: every
module threw `HttpError(status, code, message)`, the owner replied `{ status, body }`, the
status of a core code was looked up in `errors.ts`, and the library read `cf-ray`. This ADR
records the decisions ADR 0019 left open.

## Decision

### Operations (`src/engine.ts`)

`createEngine(dependencies)` returns `execute`, `explain`, `begin`, `statement`, `commit`,
`rollback`, `catalog`, `capabilities` (the client `PolicySqlTransport` kinds), `callbackQuery`,
and `health`. Client operations take `(input, { database, session, requestId? })`;
`execute` also takes `BackgroundTasks`; `callbackQuery` and `health` take only `{ requestId? }`.
Inputs are the body and the operation's fields: `idempotencyKey`, `role`, `transactionId`,
`ifNoneMatch` (the snapshot the caller holds), and `validationId` / `capability` (the opaque
token itself, not an `Authorization` value).

Every result is data and names the request id the engine used:
`{ ok: true, value, requestId }` or `{ ok: false, error: { code, message, path }, requestId }`.
Catalog and Capabilities also return `snapshot` and `notModified`. No result has a status, and
"created" is not a result property: that `begin` is answered with 201 is an HTTP rule.
Thrown errors are `EngineError(code, message, path)`; an operation never rejects.

`createApp` is the engine plus the HTTP adapter and also returns `engine`;
`createPolicySqlWorker(...).engine(env)` gives a service binding the same engine the Worker
serves. One engine serves both, so the routes, the Durable Object owner, and a non-HTTP caller
run the same code.

### The body is text; the engine checks it

The engine takes the body as text (`bodyText`), either the string or a reader
`() => Promise<string>` that the engine calls when the operation reaches its body. The reader
keeps the existing order (session and database before the body, as ADR 0019 requires) without
the transport buffering a body it may never need. The engine applies the
transport-independent checks to the text, once, for every transport: well-formed Unicode (a
lone surrogate has no UTF-8 form), the 1 MiB limit counted in UTF-8 bytes, duplicate keys
including escaped equivalents, then strict JSON (`src/request-body.ts`).

Decoding bytes is the transport's. The HTTP adapter decodes the stream with a fatal UTF-8
decoder, so malformed bytes are rejected rather than replaced, and bounds the stream with the
same limit before buffering (`src/http/body.ts`). Strict decoding therefore exists twice in
form but once in effect: a transport hands the engine either well-formed text or nothing.

### The HTTP adapter (`src/http/`)

`createHttpAdapter(engine)` maps routes and methods to operations, `PolicySQL-Role` (one value;
a comma is 400), `Idempotency-Key`, `If-None-Match` (one strong entity tag), and the callback's
`Authorization: Bearer` to fields; frames bodies; sets the fixed headers (`no-store`, JSON,
`nosniff`) on every JSON response; renders ETag and 304; and maps codes to statuses with
`src/http/status.ts`. The wrapper's request context is checked before routing, as before, so a
wrapper fault is reported on every route. The library reads no platform header: without
`context.requestId` the adapter generates one. The reference wrappers pass `cf-ray`.

### One status table, specified publicly

`website/api/errors.md` is the source of truth: one table of library codes with their status,
and one of wrapper-returned codes (`UNAUTHENTICATED`, `AUTHENTICATION_FAILED`, `RATE_LIMITED`).
`src/http/status.ts` holds exactly the library table, and a test checks that, and that every
`POLICYSQL_*` code in the TypeScript library source and the Rust crates is in one of the two
tables. `createErrorResponse` refuses a library code with a different status. The client's
definite-rejection pairs are checked against the same tables.

Duplicate and stale codes are resolved as ADR 0020 resolved `UNAUTHENTICATED` and
`AUTHENTICATION_FAILED`: `FORBIDDEN_ACCESS` is the access and role denial; `ACCESS_DENIED`,
`STATEMENT_REJECTED`, and `SNAPSHOT_MISMATCH` (412) were in the TypeScript status map and the
client but no code returned them, so they are removed. The specification listed codes nothing
returned (`FORBIDDEN_ROLE`, `CHECK_FAILED`, `COMMIT_CHECK_UNAVAILABLE`, `COMMIT_CHECK_QUERY`,
`COMMIT_CONFLICT`, `TRANSACTION_NOT_FOUND`, `TRANSACTION_EXPIRED`, `TRANSACTION_SEQUENCE`,
`TRANSACTION_FAILED`, `REQUEST_IN_PROGRESS`) and omitted ones the library does return
(`TRANSACTION_CONFLICT`, `TRANSACTION_UNAVAILABLE`, `TRANSACTION_MODE_VIOLATION`, `NOT_FOUND`,
`UNSUPPORTED_MEDIA_TYPE`, `COST_UNKNOWN`, `COST_ADMISSION_UNAVAILABLE`,
`DATABASE_BINDING_REJECTED`); the table now lists exactly what is returned. The client listed
`PRESET_COLUMN` under 400 while the server has always sent 403; the client now agrees.

### Guards and conformance

`test/engine-boundary.test.mjs` scans every library module that is not on an explicit list of
adapters and assembly modules (`src/http/*`, `src/adapters/*`, `turso-http.ts`, `redirects.ts`,
`worker.ts`, `package.ts`); a new module is an engine module by default. An engine module may
not contain `Request`, `Response`, `Headers`, `Hono`, or an import of `hono`; an HTTP header
name of the protocol, the owner wire, or the hook; a literal containing `/v1/` or equal to
`/healthz`; or a number from 100 to 599 used as a status (a `status` property value, compared
with or assigned to `.status`, or an argument of a call or `new` whose callee name contains
response, error, or status). The test also proves the scan finds each form in the adapter.

To satisfy it, the commit-check validator call (HMAC signing, hook headers, the callback URL)
moved from `commit-checks.ts` into the outbound adapter `src/adapters/commit-check-hook.ts`;
the engine still chooses the endpoint, issues the capability, and judges the decision.

`src/http/conformance.ts` (exported as `@unacowa/policysql/cloudflare/http-conformance`) is the
HTTP mapping conformance suite. It drives a mapping over a recording engine and checks routes,
fields, framing, every code's status, fixed headers, ETag / 304, request ids, and context
faults, with no database or test framework. A wrapper that serves HTTP uses the shipped adapter
or passes it; `test/http-conformance.test.mjs` runs it against the shipped adapter.

### The owner reply carries no status

`OwnerReply` is `{ ok: true, value } | { ok: false, error: { code, message, path } }`, checked
by the engine like any data crossing an adapter. The Durable Objects adapter keeps its paths
and headers; its reply is a 2xx response whose body is the value or a non-2xx response whose
body is `{ error }` (the object sends 200 and 500). That status is the wire's marker, not the
public status. A Worker of this version reads an older object's replies unchanged. An older
Worker forwards a newer object's errors as 500 and its `begin` as 200, which the client treats
as an unknown outcome rather than a success, so a mixed-version rollout fails safe. The
callback capability crosses the wire as `authorization: Bearer <capability>`, as before.

## Consequences

- Public HTTP protocol: unchanged except (1) every JSON response, including owner-routed and
  wrapper-context errors, has the three fixed headers (owner-routed responses lacked
  `x-content-type-options`, context errors used `application/json` without a charset);
  (2) a `fetchCallback` 404 has the full error shape (`path`, `requestId`); (3) a transaction
  route with a malformed id or unknown command is 404 before the session is checked;
  (4) the request id is the wrapper's or a fresh UUID, never read from `cf-ray` by the library
  (the reference wrappers pass `cf-ray`, so their responses are unchanged).
- Breaking (beta, no compatibility layer): `HttpError` is replaced by `EngineError` without a
  status; `createErrorResponse` moved to `src/http/responses.ts` (same export); `OwnerReply` and
  `OwnerCallbackInput` (`capability` instead of `authorization`) changed; `requestIdempotency`
  takes the key value; `createHandlerCore`, `AppEnv`, and `AppVariables` are removed;
  `cost_observation_failed` logs no `status`.
- Every new SQL or transaction rule lands in the engine or core and is reachable without HTTP;
  every new HTTP rule lands in `src/http/` and in the conformance suite.
