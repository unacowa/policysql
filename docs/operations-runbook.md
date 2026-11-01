# Cloudflare/Turso operations runbook

## Supported deployment

- Worker: `policysql-sqlite-turso-dev`
- URL: `https://gateway.example.com`
- Backend profile: `sqlite-turso-v1`
- Required Cloudflare tier: Workers Paid. The measured Execute CPU path exceeds the Free tier's
  10 ms request CPU allowance; the configured per-invocation cap (`limits.cpu_ms` in
  `deploy/cloudflare/wrangler.jsonc`) is 500 ms, derived from the configured limits by the
  formula of [ADR 0027](adr/0027-byte-and-cpu-budgets.md) (see "CPU budget" below).
- Interactive transactions expire after four seconds and are owned by one Durable Object.
- Idempotency cleanup ([ADR 0028](adr/0028-idempotency-cleanup-without-an-advertised-window.md)):
  a Cron Trigger (`"17 * * * *"`, UTC) runs the Worker's `scheduled` handler, which deletes
  `policysql_idempotency` rows older than 30 days in batches of 500, using the deployment's own
  `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`, outside the public endpoint. A table that is missing,
  or predates the `created_at` column, is skipped. The window is not advertised to clients.
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

Lowering `maxRequestBytes` or `maxJsonValues`, or deploying an ABI that tightens the JSON depth
limit (65 to 64 in ABI 16), can make a keyed retry whose body was accepted before its commit hit
the new limit. The Worker answers 500 `POLICYSQL_INTERNAL` and logs `keyed_body_limit_unknown`
with the rejected code; that is an unknown outcome, not a failed write. Do not treat it as a
rollback and do not delete the idempotency row: nothing ran, the key is not consumed, and a later
deployment that restores the limit replays the stored response (ADR 0007, #100). The client must
retry the same key and body. If those retries must replay during the rollout rather than stay
unknown, do not lower a limit below a body accepted in the idempotency retention window W
(ADR 0026, PR #79); the depth tightening has no such window. A depth-65 body is refused before
the idempotency lookup under every current build, so a depth-65 commit from before ABI 16 stays
unknown even after its row expires: expiry removes only the possibility of a replay, not the
unknown, and the same key and body cannot resolve it. The operator must reconcile that write
explicitly.

## Monitoring and alerts

Cloudflare invocation logs are enabled at full sampling for this development deployment. Structured
events contain request/transaction correlation IDs, safe error codes, operation names, result
shapes without column names, transaction lifecycle, exact Turso duration and rows read/written.
They never contain SQL, parameters, JWTs, credentials, policy predicates, raw database errors, or
hidden column names.

Configure alerts in the production account for:

- any sustained 5xx rate above 1% for five minutes;
- authentication or policy-deny rate above three times the seven-day baseline;
- p95 CPU above 50% of `cpu_ms` (250 ms at 500) or any CPU limit termination (outcome
  `exceededCpu`, error 1102), and p95 CPU above 1.5 times its own seven-day baseline, which a
  regression shows long before the absolute threshold (the real p95 is far below this threshold);
- actual rows read above the admission upper bound, or daily Turso usage above 80% of budget;
- any `transaction_owner_unavailable` owner-loss event, or active/terminal count mismatch;
- any `database_stream_recovery` event with `outcome` `refused` or `failed`: a transaction, with
  any write lock, is waiting for Turso to expire a stream that PolicySQL could not roll back; see
  ADR 0027, "Baton recovery" (the lock can outlast the client by more than 25 minutes, and no
  client-side recovery can shorten it). A BEGIN reply whose headers never arrived has no baton,
  so that residual produces no event; a write lock that appears without one may come from it;
- JWKS, cost-admission, or Turso availability errors for three consecutive minutes;
- any wrapper `rate_limiter_missing` or `rate_limiter_failed` event, and a sustained 429
  `POLICYSQL_RATE_LIMITED` rate above the seven-day baseline (separately for the client
  and callback routes; callback 429s also surface as commit-check failures);
- an `idempotency_cleanup` event with `outcome` `failed` (ADR 0028): the Cron Trigger could not
  delete expired keyed replies, so `policysql_idempotency` is growing. `reason` classifies it
  (`database_error`, `unreadable_columns`) and never carries the database's text. `skipped` with
  `no_created_at` on a table that should be cleaned means the table predates the `created_at`
  column and needs the rebuild described in ADR 0028; `skipped` with `no_table` is normal for a
  deployment that never uses idempotency keys. `deleted` with `batch_budget_exhausted` means a
  backlog larger than one run's cap is draining over several runs, not a failure.

## CPU budget

The CPU of one Worker or Durable Object invocation is bounded by `limits.cpu_ms`. The platform
ends an invocation that exceeds it (outcome `exceededCpu`, HTTP error 1102), and the client sees
an outcome-unknown 5xx, so the limit must exceed what a valid request can cost. ADR 0027 gives
`cpu_ms >= 1.25 x F x (5 ms + 40 ms/MiB x (R + B) + 0.8 us x (V_req + V_res) + 275 ms/MiB x E)`
for the request bytes `R`, result bytes `B` and JSON values `V` the configured limits allow and
`E` = the per-statement SQL capacity above 65,536 bytes, and
`deploy/cloudflare/test/cpu-budget.test.mjs` fails when `wrangler.jsonc` and `wrapper/limits.ts`
violate it. `F` (Workers CPU over reference-machine CPU) is 2.0, the maintainers' value (the release smoke records the
observed one, which has been higher); the value in force and every coefficient are in `deploy/cloudflare/scripts/lib/cpu-model.mjs`, and
[configuration.md](configuration.md#cpu-model) explains them.

Raising a limit (`maxResultBytes`, `maxResponseBytes`, `maxStatements`, `maxJsonValues`,
`maxRequestBytes`, or `maxSqlBytes`) raises the formula's result: raise `cpu_ms` with it, or lower
the limit when the plan cannot (Workers Free allows 10 ms). `maxSqlBytes` above 65,536 adds
`275 ms/MiB x E`; a wrapper cannot enlarge per-statement SQL capacity without paying for it in
the formula.

Before changing a coefficient, `F` or `cpu_ms`, measure from `deploy/cloudflare`:

1. `npm run build:wasm && npm run measure:cpu` runs about 35 scenarios in Node and prints each
   one's measured time next to the formula's prediction; `EXCEEDS 1.25x` marks a shape the
   model under-predicts, and the last lines say whether SQL-dense requests need a term of their
   own. The report is `.deployment/cpu-measurement.json` (`--json` prints it).
2. `npm run provision:dev` also records, under `acceptance.cpu` in `.deployment/release.json`, the
   real CPU of a small request and three about-1 MB requests on the deployed Worker, read from
   Workers observability, and `observedF` (`max`, `median`). If `observability.status` is
   `unavailable`, ingestion was late or the token cannot read observability; rerun. The release
   fails if any probe ended `exceededCpu` or used more than `cpu_ms / 1.25` (400 ms at 500) in
   one invocation.
3. Compare `observedF.max` with `HARDWARE_FACTOR`. `F` is cold to cold for the first request of a
   shape after a deploy (Workers' cold isolate against Node's first request in a fresh process)
   and warm to warm for later requests (`observedFByOrder.first` / `.later`); comparing a cold
   Workers request with a warm Node time overstates it. Shapes whose warm reference is under 50 ms
   (the long string) are not in `observedF`; they are under `belowFloor` and mostly show per-request
   platform overhead. `nodeReference` records the CPU model and Node version of the reference. A
   higher `max` than `HARDWARE_FACTOR` means `cpu_ms` may be too low for the limits and a
   maintainer decision (ADR 0027) is needed; a single run is noisy (shared hardware), so look at
   several. CPU figures are whole milliseconds per invocation, so the 1 MB shapes count, not the
   small one.

For a live deployment, read `cpuTimeMs`, `wallTimeMs` and `outcome` per invocation in Workers
Logs (one `cf-worker-event` per invocation of the Worker and of its Durable Object) and alert as
above.

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
  database access). The wrapper authenticates every interactive command and commit. A commit
  denied after its response was lost is the ADR 0007 #104 exception: the transaction stops,
  but the 401 does not prove that an earlier COMMIT did not apply. Verify application data;
  after refreshing the credential with the same principal, subject, role, and session values,
  a raw retry of the identical commit replays the owner's recorded outcome without a second
  COMMIT.
- Session gate denies a commit (403 `POLICYSQL_FORBIDDEN_ACCESS`, for example after a deploy
  removed the role or `execute` access): the same #104 exception. The denial is not a
  rollback; restore access with the same principal, subject, role, and session values and
  retry the identical commit, or verify application data. A retry whose session value changed
  is 409 `POLICYSQL_TRANSACTION_UNAVAILABLE`, not the recorded outcome.
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
