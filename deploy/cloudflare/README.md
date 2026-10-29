# PolicySQL Cloudflare deployment

This package is the versioned Cloudflare deployment adapter for the Rust policy compiler.
It must never pass caller SQL directly to Turso.

The public HTTP adapter is implemented in TypeScript with Hono. `src/app.ts` composes the app,
`src/routes/` owns endpoint handlers, and `src/middleware/` owns request context and endpoint access
checks. Transport, idempotency, and the transaction owner state machine remain
framework-independent. Routes reach transaction owners only through the `TransactionOwner`
port (`src/transaction-owner-port.ts`, [ADR 0022](../../docs/adr/0022-transaction-owner-port.md));
`src/adapters/durable-objects.ts` is its Durable Objects adapter and the only module that
names Durable Objects, their storage and alarm, or `waitUntil`. Interactive routes obtain the
runtime snapshot in the outer Worker before delegating to the owner; callback routes forward
the opaque capability to its owner.

Applications must inject a `database` provider and the explicit `PolicySqlConfig`
([engine configuration](../../docs/configuration.md), [ADR 0021](../../docs/adr/0021-explicit-engine-config.md))
into `createApp` or `createPolicySqlWorker` and pass an already-selected binding and the authenticated trusted session to each
`app.fetch(request, env, context, { database, session })`. The library verifies no credential
([ADR 0020](../../docs/adr/0020-trusted-session-input-and-jwt-identity-adapter.md)); core
validates the session before any body read, owner lookup, or DB work.
Database injection has no JWT dependency. The wrapper authorizes and chooses its DB;
PolicySQL pins the binding across execution, DOs, callbacks, retries, and cost observations.
The wrapper assembles the owner adapter: `deployment(env)` returns
`transactionOwners: durableObjectTransactionOwners(env.TRANSACTION_OWNER)`, and
`wrapper/index.ts` exports `durableObjectTransactionOwnerClass(worker.ownerDependencies)` as the
`TransactionOwner` Durable Object class. See the
[API contract](../../docs/database-routing.md) and [complete example](../../examples/database-routing/README.md).
Omitting the provider fails at construction; omitting the request binding returns
`POLICYSQL_DATABASE_REQUIRED`. The library has no fixed-env fallback.
`wrapper/index.ts`, `wrapper/database.ts`, and `wrapper/config.ts` explicitly construct the
bundled deployment connections and configuration from env and pass them into the library
through `createPolicySqlWorker({ deployment: (env) => ({ database, config, transactionOwners }) })`.
The env names (`POLICYSQL_ENVIRONMENT`, `POLICYSQL_PUBLIC_BASE_URL`, `POLICYSQL_COST_CATALOG_JSON`,
the database settings, and the `TRANSACTION_OWNER` binding) are this wrapper's convention; the
library reads no env property. Callback requests use `fetchCallback`
and their existing owner binding. These wrapper files are not the public library API.
Request-rate limiting is also wrapper-owned ([ADR 0018](../../docs/adr/0018-wrapper-owned-rate-limiting.md)):
`wrapper/fetch.ts` runs `wrapper/rate-limit.ts` with the `RATE_LIMITER` binding before `app.fetch`
and with the separate `CALLBACK_RATE_LIMITER` binding before `app.fetchCallback`. It returns 429
`POLICYSQL_RATE_LIMITED` with `Retry-After: 60` via the exported `createErrorResponse`, and fails
closed with 500 `POLICYSQL_INTERNAL` when a binding is missing. The library reads no limiter binding.
After rate limiting, `wrapper/auth.ts` verifies the development JWT with the library's identity
adapter (`createJwtSessionVerifier`), reading `POLICYSQL_JWKS_JSON` or `POLICYSQL_JWKS_URL`,
`POLICYSQL_JWT_ISSUER`, and `POLICYSQL_JWT_AUDIENCE`. It authenticates every client request
except `/healthz`, including every interactive command and commit, and returns 401
`POLICYSQL_UNAUTHENTICATED` itself; missing configuration is 500. `principal` is `JSON.stringify([issuer, sub])`.

Build and validate without deployment:

```sh
npm --prefix deploy/cloudflare run build:wasm
npm --prefix deploy/cloudflare run check
npm --prefix deploy/cloudflare run deploy:dry
```

The persistent development deployment is:

```text
https://gateway.example.com
```

It advertises authenticated `SELECT` with INNER/LEFT JOIN, filtered provenance-preserving
non-recursive CTE/derived sources, correlated EXISTS, policy-gated COUNT/GROUP/HAVING and
ROW_NUMBER, LIKE/GLOB, registered LOWER/UPPER/JSON_EXTRACT, projection-alias ordering, and
LIMIT/OFFSET, plus bounded mutations and short-lived interactive transactions owned by a Durable
Object. The adapter supports policy-triggered external commit checks for Atomic Execute and
interactive commit through the same Durable Object-owned Turso transaction. The bundled development
policy defines no hook, so Capabilities reports support separately from `commitChecksConfigured`.

The development Catalog includes `projects` for compatibility plus the documented
`authors`/`posts`/`comments`/`archived_posts` model. The member policy enables every advertised SQL
family above, finite-schema JSON extraction and collection traversal, typed CASE/CAST/concatenation,
conditional output, and INSERT/UPDATE/DELETE with presets, checks, RETURNING, expectations, and
atomic rollback. Provisioning executes the advertised read matrix and a mutation batch that is
forced to roll back, then proves that its probe row is absent.

To enable a check, define it under `commit_checks` in the policy, set
`POLICYSQL_PUBLIC_BASE_URL` to the HTTPS public Worker origin, add the check id to
`COMMIT_CHECK_ENV` in `wrapper/config.ts` with the env names of its validator URL and HMAC secret,
and upload those as Worker secrets. The policy names no endpoint or secret; the wrapper passes
them per check id as `config.commitChecks`. Hook URLs must be HTTPS and secrets must be at least
16 characters; an invalid value fails every request with 500 before any I/O, and a triggered check
without an entry fails closed and rolls back the transaction.

Provision or rotate the development database credential, JWT issuer key, Worker secrets, and
deployment in one run:

```sh
set -a; . ../../.env; set +a
npm run provision:dev
```

The temporary bulk secret file is deleted after Wrangler uploads it. The development issuer's
private JWK remains mode `0600` under ignored `.deployment/`; the sanitized acceptance report is
`.deployment/release.json`.

To call the deployed Worker:

```sh
TOKEN="$(npm run --silent token:dev)"
curl -sS -H "Authorization: Bearer $TOKEN" \
  https://gateway.example.com/v1/capabilities

curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"statements":[{"sql":"SELECT id, name, status FROM projects WHERE status = :status ORDER BY id","params":{"status":"active"}}]}' \
  https://gateway.example.com/v1/transactions:execute
```

`Idempotency-Key` is optional for writes and interactive transaction start. Keyed atomic
writes require `policysql_idempotency` in the selected DB; the development provisioning
script creates it for those examples. Without a key, direct and commit-check DO paths
never access the table and repeated requests can execute again. Empty or malformed keys
are rejected. Interactive transactions use `POST /v1/transactions`, then
monotonic `statements`, `commit`, or `rollback` commands within the advertised four-second window.
The production-shaped deployment requires Cloudflare Workers Paid: measured Execute CPU exceeded
the Free plan's 10 ms request CPU limit. The upload size remains within Worker limits.

Rollback is version-pinned and non-interactive:

```sh
npm run rollback -- <worker-version-uuid>
```

Exact Turso `rows_read`, `rows_written`, and query duration values are returned under response
metadata and recorded in the release report. See `docs/operations-runbook.md`.
