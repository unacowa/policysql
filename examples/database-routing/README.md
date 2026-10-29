# Explicitly passing a database from the wrapper

The wrapper must supply a DB on every ordinary request. The library neither reads
fixed Turso env variables nor selects a DB from a JWT. Its database API requires:

```ts
const worker = createPolicySqlWorker({ ...configuration, database: registry.provider });
const database = registry.binding(authorizedDatabaseId, env);
const response = await worker.app.fetch(request, env, context, database);
```

`provider.ts` is an application-owned registry with no request, JWT, or authentication
dependency. Its provider checks registered bindings and constructs transports from
local credentials. `worker.ts` demonstrates fixed selection from the wrapper setting
`APPLICATION_DATABASE_ID`. Choosing `db_a` or `db_b` is explicit application configuration,
not a library default. Omission is an error, even when old Turso env credentials exist.

For request-scoped selection, replace the wrapper's configuration lookup with an
already-authorized DB ID from your application routing/authorization service. Then pass
its binding as the fourth argument. The wrapper must authorize access to that DB before
injecting it; a client-provided ID or hostname alone does not grant access. The library
cannot infer the application's tenant-to-DB authorization rules.

The gateway still verifies the SQL session JWT for policies and endpoint access. That
JWT needs no database claim, and adding a database claim does not select or override the
injected DB. The two-database tests inject different bindings independently of JWT routing
claims and still exercise real policy-session authentication.

## Setup

1. Create two development Turso databases. Apply `schema.sql` administratively to each
   and validate their actual schema against `physical-schema.json`. Only when using keyed
   atomic mutations, also apply `idempotency.sql` to provision `policysql_idempotency`.
   Unkeyed mutations and interactive transactions do not require it. DDL is not a public API operation.
2. Replace the two `.invalid` URLs in `worker.ts` with registered HTTPS origins and
   configure separate `TENANT_A_TOKEN` / `TENANT_B_TOKEN` secrets.
3. Configure the SQL session verifier using `POLICYSQL_JWKS_JSON`, `POLICYSQL_JWT_ISSUER`,
   and `POLICYSQL_JWT_AUDIENCE`. The JWT contains the normal `policysql` roles/access/session
   object; the policy uses `session.tenant_id`. It has no DB routing claim requirement.
4. Choose `APPLICATION_DATABASE_ID` in this wrapper's `wrangler.jsonc` and review the
   environment, enabled flags, DO migration, rate limit, and shared conservative cost bounds.
   Rate limiting is this wrapper's job, not the library's ([ADR 0018](../../docs/adr/0018-wrapper-owned-rate-limiting.md)).
   `worker.ts` calls `withRateLimit` from `rate-limit.ts` before `app.fetch`, keyed on the
   selected DB ID and `cf-connecting-ip`, using the `RATE_LIMITER` binding. Over the limit it
   returns 429 `POLICYSQL_RATE_LIMITED` with `Retry-After: 60` built by `createErrorResponse`,
   without touching WASM or a DB. A missing or failing binding returns 500 `POLICYSQL_INTERNAL`
   (fail closed). Commit-check callbacks are not limited. Replace the key or the limiter as
   your deployment requires.
5. This policy enables commit checks. Configure `VALIDATOR_URL`, `VALIDATOR_SECRET`,
   and the deployed Worker origin in `POLICYSQL_PUBLIC_BASE_URL`. Implement the
   [commit-check contract](../../docs/commit-checks.md) in the validator. To disable checks,
   remove `commit_checks` and change `policyVersion`.

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

Ordinary requests keep their existing SQL envelopes and JWT policy authentication:

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
Explicit keys take precedence in either mode. `role` is optional (the verified JWT default
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

They use this registry, real JWT verification for SQL sessions, Rust/Wasm, HTTP transport,
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
