# Cloudflare/Turso operations runbook

## Supported deployment

- Worker: `policysql-sqlite-turso-dev`
- URL: `https://gateway.example.com`
- Backend profile: `sqlite-turso-v1`
- Required Cloudflare tier: Workers Paid. The measured Execute CPU path exceeds the Free tier's
  10 ms request CPU allowance; the configured per-request cap is 50 ms.
- Interactive transactions expire after four seconds and are owned by one Durable Object.
- Commit checks are supported by the adapter. `commitChecksConfigured` remains false until the
  active policy defines a check; each referenced hook URL and HMAC secret environment binding must
  be uploaded before activation traffic can commit successfully.

`deploy/cloudflare/.deployment/release.json` is the sanitized release artifact. It contains the
Worker version, compressed upload size, startup time, exact Turso usage sample, and curl gates.

## Release and credential rotation

From `deploy/cloudflare`, load the operator environment and run `npm run provision:dev`. The command
creates or reuses the database, rotates the Turso token, uploads Worker secrets atomically, waits
for the new route, then runs all acceptance requests. A failed gate does not write a successful
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
- JWKS, rate-limit, cost-admission, or Turso availability errors for three consecutive minutes.

## Incident drills

- Expired/revoked JWT: expect 401 before compilation or database access.
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
