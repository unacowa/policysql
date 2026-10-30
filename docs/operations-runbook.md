# Cloudflare/Turso operations runbook

## Supported deployment

- Worker: `policysql-sqlite-turso-dev`
- URL: `https://gateway.example.com`
- Backend profile: `sqlite-turso-v1`
- Required Cloudflare tier: Workers Paid. The measured Execute CPU path exceeds the Free tier's
  10 ms request CPU allowance; the configured per-request cap is 50 ms.
- Interactive transactions expire after four seconds and are owned by one Durable Object.
- Commit checks are supported by the adapter. The development policy defines one
  development-only check, `smoke_check`, answered by the `policysql-dev-validator` Worker
  (`deploy/cloudflare/dev-validator/`), so the development deployment reports
  `commitChecksConfigured: true` and requires `SMOKE_VALIDATOR_URL` and the
  `SMOKE_VALIDATOR_HMAC_SECRET` secret; without them every request fails closed with 500.

`deploy/cloudflare/.deployment/release.json` is the sanitized release artifact. It contains the
Worker version, compressed upload size, startup time, exact Turso usage sample, and curl gates.

## Release and credential rotation

From `deploy/cloudflare`, load the operator environment and run `npm run provision:dev`. The command
creates or reuses the database, rotates the Turso token, deploys the dev validator Worker, uploads
Worker secrets atomically, waits until five consecutive rounds of answers (Worker, a fresh Durable
Object, and the validator) report the version ids `wrangler deploy` printed, then runs all
acceptance requests and checks that every response carries the new version in
`policysql-deployment-version` (see `deploy/cloudflare/README.md`, "Release smoke"). A failed gate does not write a successful
release artifact. The temporary secret file is deleted; the ignored development issuer key remains
mode 0600.

Database migrations are a separate pre-deploy step. Never rely on Worker rollback to reverse a
schema migration. Keep the preceding Worker version compatible until the health and security gates
pass.

## Monitoring and alerts

Cloudflare invocation logs are enabled at full sampling for this development deployment. Structured
events contain request/transaction correlation IDs, safe error codes, operation names, result
shapes without column names, transaction lifecycle, exact Turso duration and rows read/written.
They never contain SQL, parameters, JWTs, credentials, policy predicates, raw database errors, or
hidden column names.

Configure alerts in the production account for:

- any sustained 5xx rate above 1% for five minutes;
- authentication or policy-deny rate above three times the seven-day baseline;
- p95 CPU above 40 ms or any CPU limit termination;
- actual rows read above the admission upper bound, or daily Turso usage above 80% of budget;
- any `transaction_owner_unavailable` owner-loss event, or active/terminal count mismatch;
- JWKS, cost-admission, or Turso availability errors for three consecutive minutes;
- any wrapper `rate_limiter_missing` or `rate_limiter_failed` event, and a sustained 429
  `POLICYSQL_RATE_LIMITED` rate above the seven-day baseline (separately for the client
  and callback routes; callback 429s also surface as commit-check failures).

## Rate limiting

Rate limiting is owned by the wrapper (`deploy/cloudflare/wrapper/rate-limit.ts`), not the
PolicySQL library ([ADR 0018](adr/0018-wrapper-owned-rate-limiting.md)). Every request is limited
before it reaches the library, by one of two Cloudflare Rate Limiting bindings declared in
`wrangler.jsonc`:

| Binding | Requests | Key | Default |
| --- | --- | --- | --- |
| `RATE_LIMITER` | client API, `/healthz`, unknown paths | `ip:<cf-connecting-ip>` | 100 per 60 s |
| `CALLBACK_RATE_LIMITER` | `/v1/commit-checks/...` validator callbacks | `callback:<cf-connecting-ip>` | 1000 per 60 s |

A limited client request does no JWT, WASM, SQL, or database work. A limited callback does no
body parse and no Durable Object lookup or storage read. The callback capability is checked only
inside the owner, so this limit, not the capability, bounds what unauthenticated callback spam
can cost. The separate bucket keeps client traffic from starving the validator. Size the callback
limit for peak commit-check traffic from the validator's addresses.

Both return 429 `POLICYSQL_RATE_LIMITED` with `Retry-After: 60`, which equals each binding's
`period` (`CLIENT_RATE_LIMIT` / `CALLBACK_RATE_LIMIT` in code; `rate-limit.test.mjs` fails if
`wrangler.jsonc` and the code disagree). The library itself never sends `Retry-After`.

The wrapper fails closed: if a binding is missing or throws, the requests it covers return 500
`POLICYSQL_INTERNAL` and log `rate_limiter_missing` / `rate_limiter_failed` with the binding
name. A missing callback binding makes commits with commit checks fail closed. Restore the
binding (or roll back) rather than deleting it; a deployment that limits at a WAF instead must
remove the wrapper step in code. To change limits, edit `simple.limit`/`period` in
`wrangler.jsonc` and the matching constant together, then redeploy.

## Incident drills

- Expired/revoked JWT: expect 401 from the wrapper before the library runs (no compilation or
  database access). The wrapper authenticates every interactive command and commit.
- `trusted_session_rejected` log with 500 `POLICYSQL_INTERNAL`: the wrapper passed a malformed
  session (often identity-provider claims that break the session rules). Fix the wrapper or IdP.
- Rate limit exhausted: expect 429 `POLICYSQL_RATE_LIMITED` with `Retry-After` from the wrapper,
  with no JWT verification, compilation, or database call.
- Turso outage/token revocation: expect normalized 503/504 and rollback, with no raw error exposed.
- Durable Object replacement: stored `active` state without its in-memory baton becomes `failed`;
  Turso expires and rolls back the orphaned transaction. It is never reconstructed as active.
- Deployment during an interactive transaction: the request may terminate as failed; clients must
  start a new transaction. Four-second maximum duration bounds the drain window.
- Cost catalog/planner mismatch: expect default-deny 403 or admission-unavailable 503, never direct
  execution.

## Rollback

List immutable versions with `npx wrangler versions list --name policysql-sqlite-turso-dev`, then run
`npm run rollback -- <version-uuid>`. Verify `/healthz`, authenticated Capabilities, and one protected
SELECT. Restore the intended version using the same command and repeat the gates. Open interactive
transactions are not migrated across versions and must fail closed as described above.
