# PolicySQL Cloudflare deployment

This package is the versioned Cloudflare deployment adapter for the Rust policy compiler.
It must never pass caller SQL directly to Turso.

The engine exposes operations, not HTTP (`src/engine.ts`,
[ADR 0023](../../docs/adr/0023-operations-api-and-http-adapter.md)): `execute`, `explain`,
`begin`, `statement`, `commit`, `rollback`, `catalog`, `capabilities`, `callbackQuery`, and
`health`, each returning a value or `{ code, message, path }`. `src/http/` is the HTTP inbound
adapter (Hono): routes, headers, body framing, the only code-to-status table
(`src/http/status.ts`, specified in `website/api/errors.md`), fixed headers, and ETag / 304;
`src/http/conformance.ts` is the conformance suite a custom HTTP mapping must pass.
`src/app.ts` composes the engine and the adapter. A structural test keeps HTTP statuses,
`Request` / `Response`, header names, and routes out of engine modules. The engine reaches transaction owners only through the `TransactionOwner`
port (`src/transaction-owner-port.ts`, [ADR 0022](../../docs/adr/0022-transaction-owner-port.md));
`src/adapters/durable-objects.ts` is its Durable Objects adapter and the only module that
names Durable Objects, their storage and alarm, or `waitUntil`. Interactive operations obtain the
runtime snapshot in the outer Worker before delegating to the owner; callback queries forward
the opaque capability to its owner.

Applications must inject a `database` provider and the explicit `PolicySqlConfig`
([engine configuration](../../docs/configuration.md), [ADR 0021](../../docs/adr/0021-explicit-engine-config.md))
into `createApp` or `createPolicySqlWorker` and pass an already-selected binding and the authenticated trusted session to each
request: `createPolicySqlWorker().app.fetch(request, env, executionContext, { database, session })`
on Workers (env goes only to `deployment(env)`), or `createApp().fetch(request, { database, session }, background?)`,
which takes no env or `ExecutionContext` ([ADR 0022](../../docs/adr/0022-transaction-owner-port.md)). The library verifies no credential
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
policy defines one development-only check, `smoke_check` (see "Release smoke" below), so the
development deployment reports `commitChecksConfigured: true` and requires its validator settings.

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
private JWK and the dev validator's HMAC key (`dev-validator-hmac.key`) remain mode `0600` under
ignored `.deployment/`; the sanitized acceptance report is `.deployment/release.json`.

### Release smoke

`provision:dev` is the real-environment gate of every pull request (#42). It deploys two Workers:
`policysql-dev-validator` (`dev-validator/`, a development-only commit-check validator) and then
this Worker, with `POLICYSQL_PUBLIC_BASE_URL` and `SMOKE_VALIDATOR_URL` set to their
`workers.dev` URLs (read from the account's workers.dev subdomain) and the shared HMAC key uploaded
as `SMOKE_VALIDATOR_HMAC_SECRET` / `HOOK_SECRET`. Neither key is printed.

**Waiting for the new version.** Right after `wrangler deploy`, some requests are still answered by
the previous Worker version or a Durable Object running the previous code. The wrapper (not the
library) reads Cloudflare's version metadata binding (`CF_VERSION_METADATA`) and
- sets `policysql-deployment-version: <version id>` on every response (`wrapper/deployment-version.ts`);
- answers `GET /healthz/owner` with `{ worker, owner }`, where `owner` is the version a fresh
  Durable Object of `TRANSACTION_OWNER` reports (a wrapper-owned probe message that never
  reaches the transaction owner core). The route requires an authenticated session with
  `execute` access, the access that may start a transaction and so create an owner anyway;
  any other session gets 403 `POLICYSQL_FORBIDDEN_ACCESS` before an object is created. Wrapper
  routes (`createWrapperFetch`'s `routes`) receive the verified session for this check. When the
  probe fails, `owner` is `"unknown"` and `ownerError` says why (`owner_status_<n>`,
  `owner_reply_without_version`, `owner_unreachable_<error>`, `no_owner_namespace`).

`scripts/release-readiness.mjs` starts the smoke only after five consecutive rounds (one second
apart) in which the Worker, a fresh owner and the validator all report the version ids
`wrangler deploy` printed, followed by a Capabilities read of the release's snapshot, ABI
version, limits and `commitChecksConfigured`. During the smoke every response's version header is
checked; a response from another version, or a 429 of the client rate limit, makes the failure
retryable (a new token, the wait and the smoke rerun, at most three attempts). A response
without the header never reached the wrapper (a Cloudflare error page such as 1101 or 52x); it
is reported under `unversioned` with its status and path and is a final failure, not skew. Any
other failure is final too.

**What it covers**, beyond the SQL surface, mutations, idempotency, interactive transactions,
security denials and string literals:

| Area | Requests |
| --- | --- |
| Commit checks (`smoke_check`) | Atomic Execute allow and deny, interactive commit allow, and an interactive commit whose validator answers after the hook deadline (409 `POLICYSQL_COMMIT_CHECK_REJECTED`); every allow needs the validator's callback query to see the uncommitted probe row; a final read proves the denied and timed-out probes left no row |
| Bytes (ADR 0016) | Padded 4-byte, empty and 3,001-byte BLOB round trips through `RETURNING` and `SELECT`; a read value resubmitted unchanged; `maxBytesPerValue + 1` bytes is 413 `POLICYSQL_LIMIT_EXCEEDED` and writes nothing; unpadded input is 400. The report records whether Turso's Hrana response pads BLOB base64 (`hranaBlobs`) |
| NULL assignment (ADR 0017) | JSON `null` into nullable `note` (text) and `payload` (bytes) stores SQL NULL; `null` for non-nullable `label` and in a comparison is 400 `POLICYSQL_INVALID_PARAMETER`; Explain reports `nullable` per parameter |
| CPU (ADR 0027, #56) | A small request and three Atomic Execute INSERTs of up to 1 MB and `maxJsonValues` values into `smoke_values.doc` (nested arrays, short decimals, one long string) with their real CPU time read from Workers observability; see "Measuring CPU" below |

The development-only resources are `smoke_checks` (`id`, `verdict` of `allow`/`deny`/`timeout`) and
`smoke_values` (`id`, `label`, nullable `note`, nullable bytes `payload`, nullable JSON `doc`
written only by the CPU probes and never selected), with tenant-filtered
member policies in `config/resources/`. Provisioning empties both tables before each release.
The validator answers from the newest `smoke_checks` row its callback query returns (probe ids
grow with time). It verifies the hook version, timestamp and signature, sends the capability only
to the configured PolicySQL origin's callback path, and uses `fetchNoFollow`.

The validator (not the PolicySQL Worker) sets the `global_fetch_strictly_public` compatibility
flag. What was observed without it: the hook request from the PolicySQL Durable Object reached
the validator, but the validator's callback to `https://policysql-sqlite-turso-dev.<subdomain>.workers.dev`
returned a non-JSON body and never appeared in the PolicySQL Worker's `wrangler tail`, so every
check failed with `CALLBACK_FAILED`. With the flag the callback arrives like any external
request. This matches Cloudflare's documented restriction on a Worker fetching another Worker of
the same zone (error 1042) without the flag, but the response body was not captured, so the exact
code is unconfirmed; why the opposite direction (Durable Object to validator) works without the
flag is likewise only observed, not explained. The PolicySQL Worker's flags and outbound calls
(Turso, the hook) are unchanged, so the reference deployment does not depend on this flag.

**Timing margin of the allow path.** The hook deadline is the policy's `timeout_ms`, at most
1,500 ms (`maxHookDurationMs`), and on Atomic Execute also the remaining statement deadline
(`limits.timeoutMs`, 1,000 ms here, which starts before the INSERT). Inside it the Worker calls
the validator, the validator calls back through the public front door, and the owner runs the
callback SELECT on Turso. In the two release runs of #42 the client-measured Atomic allow took
1,154 and 1,177 ms end to end (INSERT, hook and COMMIT, from the operator's network). Watch
`acceptance.commitChecks.atomicAllow.elapsedMs` against `acceptance.commitChecks.budgets` in
`release.json`, and the validator's `smoke_validator` log lines (`elapsedMs` from hook receipt to
decision, `callbackMs` for the callback). The validator's callback timeout (1,000 ms) is below the
hook cap, so a slow callback appears as `callback_failed` with `TimeoutError` in its log rather
than as an expired hook; an allow that fails with neither line logged ran out of the hook
deadline.

Durable Object owner loss is not exercised in the real environment: the platform gives no
supported way to evict one object on demand, and a redeploy restarts objects only after the
four-second transaction deadline has already ended the transaction, so the observed failure
would be the expiry, not the loss. Owner loss stays covered by the local owner tests
(`test/transaction-owner-port.test.mjs`, `test/interactive-switch.test.mjs`,
`test/atomic-switch.test.mjs`) and the step machine's tests
(`crates/policysql-transaction/tests/machine.rs`, `commit_checks.rs`).

### Measuring CPU

[ADR 0027](../../docs/adr/0027-byte-and-cpu-budgets.md) relates the byte and value limits to the
CPU limit with one formula, in `scripts/lib/cpu-model.mjs`:

```
cpu_ms >= S x F x (C0 + a_b x (R + B) + a_v x (V_req + V_res))
```

(`C0` 5 ms, `a_b` 80 ms per MiB, `a_v` 1.3 microseconds per value, `S` 1.25, `F` 2.0, the
maintainers' value, while this smoke records the observed one; `R`, `B` in MiB, `V` in JSON values; see `docs/configuration.md`, "CPU model".) The
reference wrapper's `limits.cpu_ms` in `wrangler.jsonc` is 1,000, and `test/cpu-budget.test.mjs`
fails when it falls below the formula's result at `wrapper/limits.ts`. Two tools keep the
numbers honest.

**Node measurement (`npm run measure:cpu`).** Runs the request path (engine, HTTP adapter,
Durable Objects adapter over the simulated platform, Turso HTTP transport) with the real WASM
build in `pkg/` (`npm run build:wasm` first) and prints, per scenario, the measured time, the
formula's prediction for that scenario's own `R`, `B` and `V`, their ratio, and whether the
measurement is above 1.25 times the prediction (`EXCEEDS 1.25x`: the model under-predicts that
shape). Each figure is the best of five runs after a warm-up, in ms of wall time; the simulated
Turso server and the harness client's response parsing are excluded. Each scenario runs in its
own process, so the WASM linear memory printed with it is that scenario's high-water mark.

| Group | Scenarios |
| --- | --- |
| `request` | Request bodies of up to about 1 MB and at most `maxJsonValues` JSON values (dense shapes stop at the value limit, so nested arrays are about 130 KB) carrying a JSON `metadata` value: nested arrays (depth 56), one object with unique keys, short strings, short decimals, small integers, 17-digit decimals, one long ASCII string, one long CJK string; each as a keyed Atomic Execute and as a request rejected at compile (no database) |
| `result-json` | The same rows read back with `SELECT` (about 1 MB responses; the shapes whose raw result is over 1 MiB are 413 and listed under "Skipped") |
| `result-cells` | Cell-heavy results of one-digit integers: 100 x 64, 1,000 x 10, 2,000 x 4 and 1,000 x 25 with every column `visible_if`; 100 x 64 plain; and `UPDATE ... RETURNING` with the check column and one-character aliases |
| `sql-dense` | Statements through `:explain` (no database): expression depth 31, a 32-term `OR` chain, 128 projections, 128 projections of nested `lower()` 30 deep, 8 joins with a row filter per table, one statement at `maxSqlBytes`, 8 statements at `maxSqlBytes`, 8 statements of 8 joins |

```sh
npm run build:wasm
npm run measure:cpu                          # table on stdout, report in .deployment/cpu-measurement.json
npm run measure:cpu -- --only "request:"     # scenarios whose id contains the text
npm run measure:cpu -- --runs 7 --out report.json
npm run measure:cpu -- --scale 0.8           # multiply measured times (to normalize a machine
                                             # that is 1.25x as fast as the i7-7700K reference)
npm run measure:cpu -- --cold                # time only the first request of each fresh process
npm run measure:cpu -- --json                # the report on stdout, nothing else
```

The report (`kind: policysql-cpu-measurement`) holds the machine, method, the model and its
coefficients, the fit per scenario (`fit.predictedMs`, `fit.measuredOverPredicted`,
`fit.exceedsModel`), a `summary` (which scenarios exceed the model, the worst ratio), and
`sqlTerm`: whether the densest SQL request is covered by the formula at the wrapper's limits or a
separate term for SQL bytes is needed. The script exits 0 either way: the report is evidence for
a maintainer decision (a coefficient, `F`, or `cpu_ms`), not a gate. Scenarios and generators are in
`scripts/lib/cpu-bench.mjs` and `scripts/lib/cpu-shapes.mjs`; a wrapper with its own shapes adds
scenarios there.

**Workers CPU in the release smoke.** After the other sections, `provision:dev` runs
`scripts/smoke-cpu.mjs` against the deployed Worker: a small request and the ADR's three
worst request shapes of about 1 MB (`nested arrays (depth 56)`, `short decimals 37.4`, `one long
ASCII string`), each an Atomic Execute INSERT into `smoke_values.doc` sent three times (the CPU
time of the same request varies between runs and within one, so a single sample is not an `F`),
then deletes the rows.
It then reads each request's CPU time from Workers observability
(`POST /accounts/{id}/workers/observability/telemetry/query`, which the deploy token can read),
matching the Worker invocation by the response's `cf-ray` and the Durable Object invocation by
the PolicySQL request id (the `x-policysql-request-id` the Worker forwards). Workers Logs arrive
late, so it polls every five seconds for at most 120 seconds. `cpuTimeMs` is a whole number of
milliseconds per invocation; a request's CPU is the Worker's plus the Durable Object's when it
used one (an Atomic Execute that triggers no commit check, as these probes, runs in the Worker
invocation alone; the smoke reads from the deployed policy's `commit_checks` whether the probe
table triggers one), and the Node reference is the same shape through the harness in a fresh
process. The first request of a shape after a deploy runs on a cold isolate (JIT and WASM tier-up
not warm), so it is compared with Node's own first request in a fresh process (`coldMs`, no
warm-up); later requests are compared with Node's warmed time (`warmMs`, best of five after a
warm-up): `F` = Workers CPU / Node time, cold to cold and warm to warm. A shape whose warm
reference is under 50 ms (the long string) is left out of `observedF` and listed under
`belowFloor`: the Workers figure also carries per-request platform work the harness does not run
(JWT verification, routing), which dominates a short request. The report records the Node
reference's CPU model, Node version and method (`nodeReference`).

- Fatal: any probe answered with anything but 200 (a platform CPU or memory termination answers
  1102 without the version header), an invocation with outcome `exceededCpu`, or an invocation
  above `limits.cpu_ms` divided by the safety margin S = 1.25 (800 ms at 1,000: the formula's
  margin; the platform itself ends the invocation at `cpu_ms`).
- Not fatal: observability that is not ingested before the deadline, or not readable (missing
  permission, API error). The report then says `unavailable` with the reason (a status, never a
  secret) and `observedF` is `null`; rerun `provision:dev` for a reading.
- Recorded in `release.json` under `acceptance.cpu`: `cpuLimitMs`, the formula's reference time
  and required `cpu_ms` at the deployed limits, `observability` (`read`, `partial` or
  `unavailable`, polls, elapsed), `requests[]` (one entry per sample: HTTP status, body bytes, JSON values, `workerCpuMs`,
  `ownerCpuMs`, `cpuMs`, `wallMs`, outcomes, `nodeReferenceMs`, `referenceKind`, `factor`), `nodeReference`, `belowFloor`, and `observedF`
  (`max`, `median`, `min`, `samples`, over the counted samples; `observedFByOrder` splits the first sample of each
  shape, cold to cold, from the later ones, warm to warm). The maximum is what the formula must cover; changing the
  `HARDWARE_FACTOR` constant (and so `cpu_ms`) from it is a maintainer decision (ADR 0027).

### Calling the deployed Worker

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
