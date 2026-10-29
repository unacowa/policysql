# Explicit database injection

The application wrapper must supply the database. PolicySQL cannot choose one from
JWT claims, request headers/bodies, or fixed Turso environment variables. There is no
library fallback database.

The initial contract supports multiple SQLite/Turso databases compatible with the same
immutable runtime snapshot. Per-database policy/schema/backend loading is not provided.

## Required inputs and failure behavior

Two inputs are mandatory:

1. Configure a `DatabaseProvider` when constructing `createApp` or `createPolicySqlWorker`.
2. Pass the selected `DatabaseBinding` as the fourth argument of `app.fetch` on each request.

```ts
const worker = createPolicySqlWorker({ ...runtimeConfiguration, database: provider });
export const TransactionOwner = worker.TransactionOwner;

export default {
  fetch(request, env, context) {
    // Application-owned selection; this can be a fixed registered database.
    const database = registry.binding(env.APPLICATION_DATABASE_ID, env);
    return worker.app.fetch(request, env, context, database);
  },
};
```

A missing or malformed provider throws `TypeError` at construction, before any request.
A missing/null per-request binding returns HTTP 500 with `POLICYSQL_DATABASE_REQUIRED`,
even if `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` exist in env. Both inputs are required
by the TypeScript API as well. A malformed/disallowed binding returns 403
`POLICYSQL_DATABASE_BINDING_REJECTED`; a snapshot mismatch returns 409
`POLICYSQL_STALE_OPERATION`. No database connection is opened on these failures.

`createApp` returns a `PolicySqlApp` with explicit `fetch` and `fetchCallback` methods;
it uses Hono internally but does not expose Hono's generic fetch/request bypasses.
Compiler-only `createRuntimeFactory` does not need a DB because it performs no execution.

## Provider API

Types and the optional Turso HTTP adapter are exported from `@unacowa/policysql/cloudflare`.

```ts
interface DatabaseProvider {
  check(binding: DatabaseBinding, env: WorkerBindings): boolean | Promise<boolean>;
  connect(binding: DatabaseBinding, env: WorkerBindings, requestId: string):
    DatabaseTransport | Promise<DatabaseTransport>;
}
```

The provider has no `select` method and receives no JWT or authentication context.
`check` must return exactly `true` for an enabled, compatible registered binding.
It validates that exact binding; it does not choose a replacement. `connect` constructs
its transport without starting a transaction or executing SQL. PolicySQL owns BEGIN,
verified statement execution, result validation, commit, and rollback.

The wrapper owns environment/subject/tenant/DB authorization, registration, URL and
credential management, schema compatibility, and request-rate limiting
([ADR 0018](adr/0018-wrapper-owned-rate-limiting.md)). It may use its own authorization
service, trusted routing configuration, or verified token claims to select a DB. That
choice is outside the injection API. Never accept an arbitrary client-supplied DB ID,
URL, or credential reference as authorization.

The gateway's existing JWT verification still authenticates SQL policy sessions and
endpoint access. Supplying a DB does not bypass that authentication. Conversely, a JWT
cannot supply or override a missing database argument. Database injection and policy
session authentication are separate contracts.

Each provider call is bounded by the shorter of 1,000 ms and the remaining transaction
time. Provider exceptions or exhaustion of the provider-only budget produce a generic
`POLICYSQL_DATABASE_UNAVAILABLE` without exposing provider error text; exhaustion of the
shared transaction budget produces HTTP 504 `POLICYSQL_DATABASE_TIMEOUT`. The absolute
deadline is established before connection preparation and is not restarted at BEGIN.
Preparation, SQL execution, and commit authorization all consume that same budget.
A timeout cannot cancel arbitrary
wrapper code: providers must bound their own network work and perform no database
operations before PolicySQL starts a transaction. An in-memory registration map needs
no per-request registry SQL.

`TursoHttpTransport` requires explicit connection options:

```ts
new TursoHttpTransport({ url: registeredUrl, authToken: serverOwnedToken }, requestId)
```

It does not read env or select a URL. It rejects unsafe URL forms and HTTP redirects.
Every custom transport must preserve exclusive transaction ownership and the advertised
SQLite/Turso semantics. The library cannot prove the physical identity behind an
arbitrary trusted transport; registration and conformance tests must establish it.

The transport's `begin(mode, timeoutMs, deadlineMs?, options?)` receives a per-operation
timeout and an absolute deadline in Unix milliseconds. Bound BEGIN, statement execution,
and COMMIT by the remaining time as well as the operation limit. The Turso HTTP adapter
passes that remaining budget to each HTTP call. ROLLBACK retains its bounded cleanup
budget after expiry so an expired transaction can still be released. Cost observation
has its own budget; it does not reuse an expired execution deadline.

PolicySQL always passes `options.maxBytesPerValue`, taken from the loaded runtime
(`runtime.max_bytes_per_value`, the same value Capabilities advertises). A transport
may use it to reject an oversized BLOB before decoding it, as the Turso HTTP adapter
does; it must not hard-code its own copy. PolicySQL re-checks every driver BLOB
against the same runtime value before WASM result validation.

`TursoHttpTransport.begin` requires `options`. When called directly, an omitted or
malformed `maxBytesPerValue` (missing, non-integer, zero, negative or `Infinity`) is a
`TypeError` raised before any HTTP request; the transport never runs without a
per-value BLOB bound. Pass `{ maxBytesPerValue: runtime.max_bytes_per_value }`.

## Immutable binding and DO integration

```ts
type DatabaseBinding = Readonly<{
  version: 1;
  scope: string;       // server-owned environment + tenant/security boundary
  databaseId: string;  // permanent physical database identity; never reuse
  generation: string; // routing/configuration generation
  snapshot: string;   // must equal getRuntime().snapshot
}>;
```

Each string is 1–256 characters from `[A-Za-z0-9_.:-]`. The library validates, copies,
and freezes the binding. Unknown fields and extra credential fields are rejected.
Binding fields must not contain secrets.

Use the factory's paired `TransactionOwner` export so both isolates have the same provider.
For lower-level embedding, the constructor is
`TransactionOwnerCore(state, env, getRuntime, databaseProvider, fetchImpl?)`.
It rejects an omitted provider. Internal begin/atomic messages require a binding and
snapshot; the DO rechecks these before constructing a connection with local credentials.
The DO namespace is private trusted infrastructure, not a public forwarding endpoint.

| Path | Database source |
| --- | --- |
| Execute / interactive / Catalog / Capabilities / Explain | Required fourth argument of `app.fetch` |
| Health / unknown paths through `fetch` | Binding argument still required; no DB connection |
| Commit-check callback | Binding and open connection already stored by its transaction owner |
| Cost observation | Same binding as execution, on a separate connection |

For callback requests, the wrapper uses the separate `app.fetchCallback(request, env,
context)` method. It accepts only POST `/v1/commit-checks/cval_<id>/query`; other routes
return 404. Conversely, `app.fetch` never serves the callback route, including
percent-encoded paths that decode to it; they return 404 before the body is read
([ADR 0018](adr/0018-wrapper-owned-rate-limiting.md)). The owner checks the opaque capability and its saved binding. No new DB is
chosen or connected, and this entrypoint cannot execute ordinary requests without a DB.
Changing to a validator role never reselects the database.

Interactive commands must supply the same binding and authenticated context as start.
Owner loss, connection loss, or a changed runtime snapshot cannot resume a transaction
on a new connection. Credentials and original JWTs are not stored in owner state or
sent in callback payloads. Remote timeout remains necessary after owner eviction.

## Retry, registration, and migration

Idempotency identity includes `scope` and `databaseId`; the payload fingerprint includes
all binding fields. Generation/snapshot changes conflict on an existing key instead of
silently creating another operation. Credentials are not included in these identities.
For keyed atomic mutations, retry records are stored in `policysql_idempotency` in the
selected database within the mutation transaction. `Idempotency-Key` is optional: without
it, both direct and commit-check DO execution skip every access to this table, so it need
not exist. Unkeyed requests are independent executions without request-level deduplication.
Interactive starts also accept an optional key; their state and sequenced retries use DO
storage and never require this DB table.

Never repoint an existing database identity at another physical database. Provision a
new identity, validate its actual schema (and `policysql_idempotency` if using keyed atomic mutations), retire the
old route, and reconcile ambiguous writes before submitting replacements to the new DB.
Cross-database exactly-once migration and automatic fallback are not provided.

Credential rotation alone keeps the same binding. New connections use the new credential;
an open transaction retains its original connection and fails if that credential stops
working. It never reconnects to continue. Route revocation is enforced by `check` at
connection creation, DO commands/callbacks, and commit. Its freshness depends on the
wrapper's configuration/cache contract; immediate global revocation is not implied.
A rejection in the Worker can leave an existing DO transaction until its alarm/remote timeout.

The wrapper must validate physical schema compatibility before activating a route.
A matching snapshot string alone is not proof. DDL remains outside the public endpoint.

## Breaking changes and evidence

Legacy implicit fixed-env connections and transportFactory/costTransportFactory overrides
have been removed. Fixed-env connection construction now lives explicitly in
`deploy/cloudflare/wrapper/`, outside the published library entrypoint. Existing wrappers
must provide a provider and a binding. This also changes legacy retry identities; drain
unresolved retries before migrating an endpoint. Old owner state without a binding fails closed.

See [the complete example](../examples/database-routing/README.md). Local tests use real
JWT verification for the SQL session, Rust/Wasm, HTTP transport, and two independent SQLite
files. They also prove that injection itself does not need JWT routing claims. Cloudflare
storage/eviction and Turso networking are simulated; real deployment acceptance remains
required before claiming operational verification.
