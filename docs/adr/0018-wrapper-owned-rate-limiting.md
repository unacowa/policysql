# ADR 0018: Wrapper-owned request-rate limiting

- Status: accepted
- Issues: #26
- Related: [ADR 0014](0014-wrapper-provided-database-bindings.md)

## Context

The Cloudflare adapter limited requests itself, after JWT verification and before SQL
compilation. The key hashed issuer, the `cf-connecting-ip` header, subject, role, the
`tenant_id` session claim (or `no_tenant`), and an endpoint bucket. The counter required
a Cloudflare Rate Limiting binding named `POLICYSQL_RATE_LIMITER`; without it, every
authenticated endpoint failed with 503 `POLICYSQL_RATE_LIMIT_UNAVAILABLE`.

This embedded deployment assumptions in the library:

- `tenant_id` is only one session variable a policy may define. Hard-coding it is the same
  kind of leak ADR 0014 removed from database selection.
- A specific Cloudflare binding and client-IP header were mandatory, even for deployments
  that limit at a WAF or API gateway.
- The library could only limit after authentication. The phase-6 review recommends limiting
  before expensive JWT, SQL, or YAML work, which only code ahead of `app.fetch` can do.
- The wrapper already receives every request first, including interactive commands and
  commit-check callbacks, and can key on IP, path, token, or its own tenant decision.

## Decision

Request-rate limiting is a wrapper responsibility, like database selection in ADR 0014.

- The library contains no limiter, reads no limiter binding, and does not reference
  `tenant_id` or `cf-connecting-ip`. `WorkerBindings` no longer declares
  `POLICYSQL_RATE_LIMITER`. Every library endpoint works without any limiter binding, and
  a binding left in `env` is ignored.
- `POLICYSQL_RATE_LIMIT_UNAVAILABLE` is removed, and the library never returns
  `POLICYSQL_RATE_LIMITED`. Its remaining 429 codes, `POLICYSQL_USAGE_BUDGET_EXCEEDED`
  and `POLICYSQL_TRANSACTION_LIMIT_EXCEEDED`, are per-query and per-transaction limits,
  not request-rate limits, and are unchanged.
- `POLICYSQL_RATE_LIMITED` (HTTP 429) stays in the public contract as the code a wrapper
  uses when it rejects a request for rate.
- `@unacowa/policysql/cloudflare` exports
  `createErrorResponse(status, code, message, { path?, requestId?, headers? })`, which
  builds the public error body `{ error: { code, message, path, requestId } }` with the
  library's fixed `no-store`, JSON, and `nosniff` headers. It validates the status
  (400-599), the `POLICYSQL_*` code pattern, and the message. Extra headers such as
  `Retry-After` are allowed, but cannot replace the fixed headers.
- The library sends no `Retry-After` header on any response, including its own 429 and
  503 responses.

### Reference implementation

`deploy/cloudflare/wrapper/` and `examples/database-routing/worker.ts` limit with a
Cloudflare Rate Limiting binding named `RATE_LIMITER`. The name has no `POLICYSQL_` prefix
because the library does not read it.

- The limiter runs before `app.fetch` and before the database binding is computed. Computing
  the binding reads the runtime snapshot, which initializes WASM, so a limited request never
  verifies a JWT, compiles WASM, compiles SQL, or reaches a database provider.
- The reference wrapper uses one counter per `cf-connecting-ip`. The example uses the
  database ID that the wrapper selected plus the client IP. Neither keys on an unverified
  token, claim, or path segment that a caller could rotate.
- When the limit is exceeded, the wrapper returns 429 `POLICYSQL_RATE_LIMITED` with
  `Retry-After: 60`. The value is the binding's `simple.period` in seconds and an upper
  bound on the wait. The binding does not report its exact reset time.
- Fail closed: a missing binding, a binding that throws, or any result other than
  `success: true` never reaches `app.fetch`. A missing or throwing binding returns 500
  `POLICYSQL_INTERNAL` and logs `rate_limiter_missing` or `rate_limiter_failed`. This is
  a deployment fault, not a client condition. A malformed result is treated as limited.
  A deployment that limits elsewhere removes this wrapper step. Leaving the binding out
  is not a way to turn the limiter off.
- Commit-check callbacks (`/v1/commit-checks/...`, sent to `app.fetchCallback`) are not
  limited, as before. They require an opaque per-transaction capability and use the
  owner's pinned database. Limiting them would turn validator load into commit failures.

## Consequences

- Breaking change. Embedders that relied on the built-in limiter must add their own
  before `app.fetch`. There is no compatibility layer or migration guide (beta).
- Rate limiting no longer covers only authenticated requests. The reference wrappers
  count every non-callback request, including `/healthz` and unknown paths.
- Tests in `deploy/cloudflare/test/rate-limit.test.mjs` cover these cases: the library runs
  without a binding and ignores one; the library source has no limiter, tenant-claim, or
  client-IP reference; the helper's shape and validation; the reference wrapper and
  example return 429 with no runtime initialization, provider check/connect, or database
  event; requests under the limit pass through; the fail-closed cases; and the callback
  bypass.
