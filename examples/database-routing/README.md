# Explicitly passing a database from the wrapper

The wrapper must supply a DB and the authenticated trusted session on every ordinary
request. The library neither reads fixed Turso env variables nor selects a DB from a JWT,
and it verifies no credential. Its API requires:

```ts
const worker = createPolicySqlWorker({
  ...configuration,
  // Called with the Worker's and each Durable Object's env; the library reads no env name.
  deployment: (env) => ({ database: registry.provider(env), config: configFromEnv(env) }),
});
const session = await authenticate(request, env); // auth.ts: the JWT identity adapter
const database = registry.binding(authorizedDatabaseId, env);
const response = await worker.app.fetch(request, env, context, { database, session });
```

`config.ts` maps this wrapper's env names to the library's `PolicySqlConfig`
([engine configuration](../../docs/configuration.md)). `provider.ts` is an application-owned
registry with no request, JWT, or authentication dependency; `registry.provider(env)` binds it
to the env it was built from, because the library hands the provider no env. Its provider checks registered bindings and constructs transports from
local credentials. `worker.ts` demonstrates fixed selection from the wrapper setting
`APPLICATION_DATABASE_ID`. Choosing `db_a` or `db_b` is explicit application configuration,
not a library default. Omission is an error, even when old Turso env credentials exist.

For request-scoped selection, replace the wrapper's configuration lookup with an
already-authorized DB ID from your application routing/authorization service. Then pass
its binding as `database` in the fourth argument. The wrapper must authorize access to that DB before
injecting it; a client-provided ID or hostname alone does not grant access. The library
cannot infer the application's tenant-to-DB authorization rules.

This wrapper verifies the SQL session JWT in `auth.ts` with the library's optional
`createJwtSessionVerifier` and passes the resulting trusted session; PolicySQL then checks
policies and endpoint access against it. The JWT needs no database claim, and adding a
database claim does not select or override the injected DB. The wrapper authenticates every
request, including every interactive command and commit, so an expired or revoked token stops
a transaction ([ADR 0020](../../docs/adr/0020-trusted-session-input-and-jwt-identity-adapter.md)).

## Setup

1. Create two development Turso databases. Apply `schema.sql` administratively to each
   and validate their actual schema against `physical-schema.json`. Only when using keyed
   atomic mutations, also apply `idempotency.sql` to provision `policysql_idempotency`.
   Unkeyed mutations and interactive transactions do not require it. DDL is not a public API operation.
2. Replace the two `.invalid` URLs in `worker.ts` with registered HTTPS origins and
   configure separate `TENANT_A_TOKEN` / `TENANT_B_TOKEN` secrets.
3. Configure this wrapper's SQL session verifier (`auth.ts`) using `POLICYSQL_JWKS_JSON`,
   `POLICYSQL_JWT_ISSUER`, and `POLICYSQL_JWT_AUDIENCE`; the library reads none of them. The JWT contains the normal `policysql` roles/access/session
   object; the policy uses `session.tenant_id`. It has no DB routing claim requirement.
4. Choose `APPLICATION_DATABASE_ID` in this wrapper's `wrangler.jsonc` and review the
   environment, enabled flags, DO migration, rate limit, and shared conservative cost bounds.
   Rate limiting is this wrapper's job, not the library's ([ADR 0018](../../docs/adr/0018-wrapper-owned-rate-limiting.md)).
   `worker.ts` uses `createRateLimitedFetch` from `rate-limit.ts`, which limits every request
   before the library. Client requests use the `RATE_LIMITER` binding, keyed on the selected DB
   ID and `cf-connecting-ip`, before `app.fetch`. Commit-check callbacks use the separate
   `CALLBACK_RATE_LIMITER` binding (`callback:<ip>`) before `app.fetchCallback`, because their
   capability is only checked inside the Durable Object. Over a limit it returns 429
   `POLICYSQL_RATE_LIMITED` with `Retry-After: 60` built by `createErrorResponse`, without
   touching WASM, a Durable Object, or a DB. A missing or failing binding returns 500
   `POLICYSQL_INTERNAL` (fail closed). Keep each `period` in `wrangler.jsonc` equal to
   `periodSeconds` in `rate-limit.ts`. Replace the keys or the limiter as your deployment requires.
5. This policy enables the `consistency` commit check. Configure `VALIDATOR_URL`,
   `VALIDATOR_SECRET`, and the deployed Worker origin in `POLICYSQL_PUBLIC_BASE_URL`;
   `config.ts` passes them as `commitChecks.consistency` (the policy names no env variable).
   Missing values fail every request with 500 `POLICYSQL_INTERNAL` before any I/O.
   Implement the [commit-check contract](../../docs/commit-checks.md) in the validator.
   To disable checks, remove `commit_checks` from the policy, change `policyVersion`, and
   also remove the `commitChecks.consistency` entry from `configFromEnv` in `config.ts`;
   otherwise, without `VALIDATOR_URL` and `VALIDATOR_SECRET`, every request is 500.

Build-check from the repository root:

```sh
npm --prefix deploy/cloudflare run verify
wrangler deploy --config examples/database-routing/wrangler.jsonc --dry-run --outdir /tmp/policysql-routing-build
```

When configured, deploy into a dedicated development environment:

```sh
wrangler deploy --config examples/database-routing/wrangler.jsonc
```

## Callback and transaction ownership

Export `worker.TransactionOwner` as the DO class. Both isolates use the same explicit
provider; credentials are resolved locally and do not cross internal messages.

The wrapper dispatches validator callbacks to `worker.app.fetchCallback(request, env,
context)`. That method accepts only the callback route and uses the database already
pinned by its owner. It cannot execute normal API requests without a database argument.
The callback capability remains required. There is no fallback or new selection here.

Ordinary requests keep their existing SQL envelopes; the client sends the JWT that this
wrapper verifies:

```json
{"statements":[{"sql":"SELECT id, name FROM projects ORDER BY id","params":{}}]}
```

```json
{"statements":[{"sql":"INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name","params":{"id":"demo_1","name":"Example"}}]}
```

`Idempotency-Key` is optional. Without it, each write is a new execution and neither the
Worker nor the commit-check DO reads or writes `policysql_idempotency`. With a key, provision
the optional table first and reuse the same key and payload for retries. A missing table
on the keyed path remains an error; empty or malformed keys are also rejected.
The validator can read the uncommitted row on the same transaction and DB without receiving
a database credential. Interactive start also accepts an optional key; an unkeyed start
creates a new transaction, whose subsequent commands still enforce sequence-based retries.

## Kysely client

`client.mjs` contains a runnable factory and a helper that retains an operation's key and
payload. It creates a standard `Kysely` instance with `PolicySqlDialect`. Ordinary
`.execute()` methods return Kysely rows or mutation results; `policyOptions()` attaches
per-query keys, expectations, and metadata observers.

```js
import { createHttpTransport } from '@unacowa/policysql/client';
import { createExampleClient, prepareProjectRename } from './client.mjs'

const db = createExampleClient({
  transport: createHttpTransport({
    endpoint: 'https://gateway.example.com',
    fetchImpl: (url, init) => {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${runtimeJwt}`);
      return fetch(url, { ...init, headers });
    },
  }),
  autoIdempotencyKey: false, // default: omit keys unless explicitly supplied
})

// Requires only schema.sql; no idempotency table is accessed.
await db.updateTable('projects').set({ name: 'Changed' })
  .where('id', '=', 'demo_1').execute()

// Requires idempotency.sql. Prepare once, then keep this operation for retry.
const operation = prepareProjectRename(db, { id: 'demo_1', name: 'With replay' })
await operation.send()
// If a response is lost, call operation.send() again with this same operation.
```

Set `autoIdempotencyKey: true` to generate keys for mutation executions without an explicit
key. Each execution gets a new key, so this alone does not deduplicate application retries.
Explicit keys take precedence in either mode. `role` is optional (the trusted session's default
role applies); `schemaVersion` and `policyVersion` can optionally be specified together.
Neither setting selects the database. Persist the key and payload to retry after
an application reload, using the same authenticated context and DB binding while the
record remains available. Do not automatically resend an unkeyed write with an unknown outcome.

Standard interactive transactions need no idempotency table, including with
`autoIdempotencyKey: true`. Start requests carry no key, and statements use the owner ID
and sequence for retries. `renameExistingProject()` in `client.mjs` shows a callback
transaction whose update depends on a preceding SELECT. Controlled transactions use
`db.startTransaction().execute()` and explicit `trx.commit().execute()` or rollback.
Call `await db.destroy()` when the client is no longer needed. See the
[Kysely guide](../../website/clients/kysely.md) for explicit confirmation, limits, and metadata.

## Lifecycle and verification

- Disable an enabled flag to retire a route as seen by the current configuration.
  Propagation/caching latency determines revocation freshness.
- Credential rotation keeps the binding identity unchanged. Existing transactions keep
  their connection; credential failure never causes reconnection or DB substitution.
- Change generation for route configuration changes. Reusing an idempotency key with a
  different generation on the same DB conflicts. Never reuse a database identity for
  another physical DB or automatically resend ambiguous writes to a new DB.
- Validate schema compatibility before route activation. A snapshot string alone is
  not physical schema verification.

Local regression tests require Node 24+ and run with:

```sh
node --test deploy/cloudflare/test/database-routing.test.mjs deploy/cloudflare/test/kysely-client.test.mjs
```

They use this registry, trusted sessions passed directly or through this wrapper's JWT
verification, Rust/Wasm, HTTP transport,
and two independent SQLite files. They cover missing DBs, irrelevant JWT DB claims,
parallel reads/writes, rollback, retries, callbacks, cost observation, owner loss,
configuration mismatch, credential rotation/revocation, and snapshot changes.
Cloudflare storage and the remote HTTP server are simulated.

Real Cloudflare/Turso acceptance remains required: record the Worker version, runtime
snapshot, DB identities, and sanitized results for concurrent A/B reads/writes, atomic
and interactive commit checks, callback post-state visibility, rollback and retry,
cross-DB capability rejection, route revocation, credential rotation, connection loss,
DO eviction, and cost observation. This example has not itself been live-certified.

See [the API and migration contract](../../docs/database-routing.md).
