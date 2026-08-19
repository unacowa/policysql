# PolicySQL Cloudflare deployment

This package is the versioned Cloudflare deployment adapter for the Rust policy compiler.
It must never pass caller SQL directly to Turso.

The public HTTP adapter is implemented in TypeScript with Hono. `src/app.ts` composes the app,
`src/routes/` owns endpoint handlers, and `src/middleware/` owns request context and endpoint access
checks. Transport, authentication, idempotency, and Durable Object state-machine modules remain
framework-independent. Routes that only forward an interactive transaction or commit-check request
do not initialize the Rust/Wasm compiler in the outer Worker isolate.

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
`POLICYSQL_PUBLIC_BASE_URL` to the HTTPS public Worker origin, and upload every `url_env` and
`hmac_secret_env` named by the policy as Worker secrets. Hook URLs must be HTTPS and secrets must be
at least 16 characters. Missing or invalid bindings fail closed and roll back the transaction.

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

Writes require an `Idempotency-Key`. Interactive transactions use `POST /v1/transactions`, then
monotonic `statements`, `commit`, or `rollback` commands within the advertised four-second window.
The production-shaped deployment requires Cloudflare Workers Paid: measured Execute CPU exceeded
the Free plan's 10 ms request CPU limit. The upload size remains within Worker limits.

Rollback is version-pinned and non-interactive:

```sh
npm run rollback -- <worker-version-uuid>
```

Exact Turso `rows_read`, `rows_written`, and query duration values are returned under response
metadata and recorded in the release report. See `docs/operations-runbook.md`.
