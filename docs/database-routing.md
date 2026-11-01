# Explicit database injection

The application wrapper must supply the database. PolicySQL cannot choose one from
JWT claims, request headers/bodies, or fixed Turso environment variables. There is no
library fallback database.

The initial contract supports multiple SQLite/Turso databases compatible with the same
immutable runtime snapshot. Per-database policy/schema/backend loading is not provided.

## Required inputs and failure behavior

Two inputs are mandatory:

1. Configure a `DatabaseProvider` when constructing `createApp` or `createPolicySqlWorker`
   (inside its `deployment(env)` function, next to the `PolicySqlConfig`;
   see [engine configuration](configuration.md)).
2. Pass the selected `DatabaseBinding` as `database` in the request context of `app.fetch`
   on each request (the fourth argument of `createPolicySqlWorker().app.fetch`, the second
   of `createApp().fetch`), next to the trusted session the wrapper authenticated
   (`{ database, session, requestId? }`,
   [ADR 0020](adr/0020-trusted-session-input-and-jwt-identity-adapter.md)).

```ts
const worker = createPolicySqlWorker({
  ...runtimeConfiguration,
  // Wrapper-owned; called with the Worker's and each Durable Object's env (ADR 0021).
  // Transaction owners are this deployment's Durable Objects (ADR 0022).
  deployment: (env) => ({
    database: registry.provider(env),
    config: configFromEnv(env),
    transactionOwners: durableObjectTransactionOwners(env.TRANSACTION_OWNER),
  }),
});
export const TransactionOwner = durableObjectTransactionOwnerClass(worker.ownerDependencies);
const verify = createJwtSessionVerifier({ jwks: JWKS, issuer: ISSUER, audience: AUDIENCE });

export default {
  async fetch(request, env, context) {
    // Application-owned authentication; PolicySQL never sees the credential.
    let session;
    try {
      session = await verify(request);
    } catch (error) {
      if (error instanceof JwtAuthenticationError) {
        return createErrorResponse(401, error.code, error.message);
      }
      throw error;
    }
    // Application-owned selection; this can be a fixed registered database.
    const database = registry.binding(env.APPLICATION_DATABASE_ID, env);
    return worker.app.fetch(request, env, context, { database, session });
  },
};
```

A missing or malformed provider throws `TypeError` at construction, before any request.
A missing/null per-request `database` returns HTTP 500 with `POLICYSQL_DATABASE_REQUIRED`,
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
  /** Whether the transports it builds enforce the read cap while the reply arrives. Required. */
  readonly streamedReadCap: boolean;
  check(binding: DatabaseBinding): boolean | Promise<boolean>;
  connect(binding: DatabaseBinding, requestId: string):
    DatabaseTransport | Promise<DatabaseTransport>;
}
```

The provider has no `select` method and receives no credential or authentication context.
It also receives no platform `env` ([ADR 0021](adr/0021-explicit-engine-config.md)): the
wrapper builds it with its own credentials and registry.
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

The wrapper authenticates the caller and passes the trusted session next to the database;
PolicySQL validates the session and checks endpoint access in core. Supplying a DB does not
bypass that check. Conversely, a session or token claim cannot supply or override a missing
database argument. Database injection and the trusted-session contract are separate.

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
(`limits_json` `maxBytesPerValue`, the same value Capabilities advertises). A transport
may use it to reject an oversized BLOB before decoding it, as the Turso HTTP adapter
does; it must not hard-code its own copy. PolicySQL re-checks every driver BLOB
against the same runtime value before WASM result validation.

`DatabaseTransaction.execute(statements, options)` receives `options.maxResponseBytes`, the read cap
of the database's reply to those statements, computed by core: the raw result bound of the
compiled statements (`2 x maxResultBytes` and more, see
[configuration.md](configuration.md#bounds-the-library-computes)), the idempotency lookup bound, or
a fixed bound for a statement with no result data. A transport that reads the reply as a byte
stream must cancel it at the first byte over the cap and fail with `POLICYSQL_LIMIT_EXCEEDED`; the
Turso HTTP adapter does, and fails closed before any request when the cap is missing or not a
positive safe integer. A transport or driver that buffers the whole reply internally cannot, and
declares it with `streamedReadCap: false` on its provider (the field is required and has no
default). Core then checks the same bound on what the driver returned, after it returned, and the
engine logs `database_read_cap_unenforced` once per provider when `maxResultBytes` exceeds 64,000,
so the operator knows memory is not bounded while the reply is read.

A transport that reads the reply as a stream must also keep the reply's leading bytes: a Hrana
reply starts with the stream's next baton. When a statement reply is refused or cannot be
finished, the caller continues the stream's transaction with that baton and rolls it back; a
transport that discards it leaves the server transaction, and its write lock, open until the
server expires the stream. The Turso HTTP adapter does this. A BEGIN reply carries the same next
baton even when its result is unusable, and a refused or unreadable reply may carry it in its
leading bytes; when a baton is readable, `begin` makes one bounded best-effort ROLLBACK+close
through it before rethrowing. When no baton is readable at all (the
request failed before its headers), a statement's `finish("ROLLBACK")` makes one bounded
best-effort ROLLBACK with the last known baton and logs `database_stream_recovery` with `outcome`
`rolled_back` or `refused` (never the baton). A `refused` outcome means the transaction, and any
write lock, remains until the server expires the stream — observed more than 25 minutes on real
Turso — with no client-side recovery: the operator waits for the expiry, and nothing PolicySQL
sends can shorten it. A cleanup rollback on a known baton whose own request fails logs `outcome`
`failed` and has the same consequence; the stale-baton `recover()` path logs `refused` when its
own request fails before a reply. A BEGIN whose headers never arrive has no baton at all:
no event is logged, and if the server runs BEGIN IMMEDIATE later, its transaction and write lock
remain until the stream expires. See ADR 0027, "Baton recovery".

`TursoHttpTransport.begin` requires `options`. When called directly, an omitted or
malformed `maxBytesPerValue` (missing, non-integer, zero, negative or `Infinity`) is a
`TypeError` raised before any HTTP request; the transport never runs without a
per-value BLOB bound. Pass `{ maxBytesPerValue }` from the runtime's `limits_json`.

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

Export `durableObjectTransactionOwnerClass(worker.ownerDependencies)` as the Durable Object
class so the Worker and every object build the same provider from their own env. The
transaction owner is a port ([ADR 0022](adr/0022-transaction-owner-port.md)): for another
platform, implement `TransactionOwnerPort` and construct
`TransactionOwnerCore(facilities, { getRuntime, database, config, fetchImpl? })` per live
owner, with the same `config` the app receives and the adapter's `store`, `timer`, and
`background`. The adapter must keep one live owner per name and make owner loss a successor
with the same store and no memory; `test/transaction-owner-port.test.mjs` is the conformance
suite. The core rejects an omitted provider. Internal begin/atomic commands require a
binding and snapshot; the owner rechecks these before constructing a connection with local
credentials. The Durable Object namespace is private trusted infrastructure, not a public
forwarding endpoint.

| Path | Database source |
| --- | --- |
| Execute / interactive / Catalog / Capabilities / Explain | Required `database` in the request context of `app.fetch` |
| Health / unknown paths through `fetch` | `database` still required; no session needed; no DB connection |
| Commit-check callback | Binding and open connection already stored by its transaction owner |
| Cost observation | Same binding as execution, on a separate connection |

For callback requests, the wrapper uses the separate `app.fetchCallback` method
(`(request, env, context)` on `createPolicySqlWorker().app`, `(request)` on `createApp`). It accepts only POST `/v1/commit-checks/cval_<id>/query`; other routes
return 404. Conversely, `app.fetch` never serves the callback route, including
percent-encoded paths that decode to it; they return 404 before the body is read
([ADR 0018](adr/0018-wrapper-owned-rate-limiting.md)). The owner checks the opaque capability and its saved binding. No new DB is
chosen or connected, and this entrypoint cannot execute ordinary requests without a DB.
Changing to a validator role never reselects the database.

Interactive commands must supply the same binding and trusted session (same `principal`,
subject, role, and session values) as start. The wrapper authenticates every command and
commit; stopping a transaction after token expiry or revocation is its obligation. A commit
denied there (401 from the wrapper, or 403 `POLICYSQL_FORBIDDEN_ACCESS` from the engine's
session gate) is the intended exception to ADR 0007's commit-retry rule: the gate runs before
the owner, so the denial stops the transaction but does not confirm whether an earlier COMMIT
applied, and the client keeps treating it as a definite rejection (see [ADR
0007](adr/0007-transaction-retry-and-commit-check-protocol.md), amendment #104).
Owner loss, connection loss, or a changed runtime snapshot cannot resume a transaction
on a new connection. Credentials and original JWTs are not stored in owner state or
sent in callback payloads. Remote timeout remains necessary after owner eviction.

## Retry, registration, and migration

Idempotency identity includes `scope` and `databaseId`; the payload fingerprint includes
every binding field except `snapshot` (#80). A generation change conflicts on an existing key
instead of silently creating another operation; a snapshot change (a deployment of another
ABI, policy, or schema) does not, so a committed keyed write retried after the deployment
replays its stored response. Rows written before ABI 9 carry a fingerprint with the snapshot
and conflict on such a retry (the one-time transition of ADR 0014's #80 amendment). Credentials are not included in these identities.
For keyed atomic mutations, retry records are stored in `policysql_idempotency` in the
selected database within the mutation transaction. `Idempotency-Key` is optional: without
it, both direct and commit-check DO execution skip every access to this table, so it need
not exist. Unkeyed requests are independent executions without request-level deduplication.
Interactive starts also accept an optional key; their state and sequenced retries use DO
storage and never require this DB table.

A deployment that lowers an input limit (`maxRequestBytes`, the body-side `maxJsonValues`, or
the depth limit tightened in ABI 16) can refuse the body of a keyed retry that committed under
the earlier limits. A keyed atomic execute answers that as 500 `POLICYSQL_INTERNAL` (the unknown
outcome), never a definite 413/400; it does not look up, replay, execute, or consume the key, and
a later deployment that restores the limit replays the stored response (ADR 0007, #100). If such
retries must replay rather than stay unknown, do not lower the limit below a body accepted in the
idempotency retention window W (ADR 0026, PR #79); the depth tightening cannot preserve that window.

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

See [the complete example](../examples/database-routing/README.md). Local tests pass
trusted sessions directly or through the example's JWT verification, Rust/Wasm, HTTP transport, and two independent SQLite
files. They also prove that injection itself does not need JWT routing claims. Cloudflare
storage/eviction and Turso networking are simulated; real deployment acceptance remains
required before claiming operational verification.
