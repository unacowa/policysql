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
  not request-rate limits, and are unchanged. (Since ADR 0024 pull request 9,
  `POLICYSQL_USAGE_BUDGET_EXCEEDED` is a log-only code of the cost observation; it is in no
  reply.)
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

`deploy/cloudflare/wrapper/` and `examples/database-routing/` limit every request with two
Cloudflare Rate Limiting bindings: `RATE_LIMITER` for client API requests and
`CALLBACK_RATE_LIMITER` for commit-check callbacks. The names have no `POLICYSQL_` prefix
because the library does not read them.

- The client limiter runs before `app.fetch` and before the database binding is computed.
  Computing the binding reads the runtime snapshot, which initializes WASM, so a limited
  request never verifies a JWT, compiles WASM, compiles SQL, or reaches a database provider.
- The callback limiter runs before `app.fetchCallback`. Authorization alone does not bound
  callback cost: the callback capability is verified only inside the transaction owner, after
  the library has read and scanned the body (up to 1 MiB), looked up a Durable Object for an
  attacker-chosen ID, and read its storage. Without a limit, anyone could repeat that work
  without bound by sending fresh `cval_<32 hex>` IDs. A limited callback does none of it.
- Callbacks use a separate binding, namespace, and key space (`callback:<ip>`, by default
  1000 per 60 s against 100 for clients). Client traffic therefore cannot starve the
  validator into commit failures, and callback spam cannot spend the client budget. A
  deployment with fixed validator addresses can additionally allowlist them in the wrapper.
- The wrapper classifies on the raw `URL.pathname`: a path that starts with
  `/v1/commit-checks/` goes to the callback bucket and `app.fetchCallback`, and every other
  path goes to the client bucket and `app.fetch`. The library makes this classification
  safe without the wrapper decoding anything. `app.fetchCallback` matches the exact raw path
  `POST /v1/commit-checks/cval_<32 hex>/query` before reading the body. `app.fetch` never
  serves the commit-check route (breaking change in this ADR): a percent-encoded path such
  as `/v1/commit%2Dchecks/...` or `/v%31/...`, which the router would decode to that route,
  returns 404 `POLICYSQL_NOT_FOUND` before any body read or Durable Object lookup. Such a
  request is therefore an ordinary client request, counted in the client bucket, and never
  enters the callback key space or the callback handler. The library also bounds the body
  size. The wrapper does not repeat these checks.
- The reference wrapper uses one counter per `cf-connecting-ip`. The example uses the
  database ID that the wrapper selected plus the client IP. Neither keys on an unverified
  token, claim, or path segment that a caller could rotate.
- When a limit is exceeded, the wrapper returns 429 `POLICYSQL_RATE_LIMITED` with
  `Retry-After: 60`. The value is that binding's `simple.period` in seconds and an upper
  bound on the wait. The binding does not report its exact reset time. A test parses both
  `wrangler.jsonc` files and requires each binding's name and period to match the code
  constants (`CLIENT_RATE_LIMIT` and `CALLBACK_RATE_LIMIT`).
- Fail closed: a missing binding, a binding that throws, or any result other than
  `success: true` never reaches the library, on either route. A missing or throwing
  binding returns 500
  `POLICYSQL_INTERNAL` and logs `rate_limiter_missing` or `rate_limiter_failed`. This is
  a deployment fault, not a client condition. A malformed result is treated as limited.
  A deployment that limits elsewhere removes this wrapper step. Leaving the binding out
  is not a way to turn the limiter off.
  A missing callback binding fails only callbacks, so commits whose policy defines a
  commit check fail closed.

## Consequences

- Breaking change. Embedders that relied on the built-in limiter must add their own
  before `app.fetch`. There is no compatibility layer or migration guide (beta).
- Rate limiting no longer covers only authenticated requests. The reference wrappers
  count every request, including `/healthz`, unknown paths, and commit-check callbacks,
  which the library never limited.
- Tests in `deploy/cloudflare/test/rate-limit.test.mjs` cover these cases: the library runs
  without a binding and ignores one; the library source has no limiter, tenant-claim, or
  client-IP reference; the helper's shape and validation; the reference wrapper and
  example return 429 with no runtime initialization, provider check/connect, or database
  event; requests under the limit pass through; the fail-closed cases on both routes;
  callback spam gets 429 with no Durable Object, WASM, or database work; a real commit
  check succeeds through the wrapper while the client bucket is exhausted; the two buckets
  are independent; percent-encoded and mixed-case callback paths return 404 from the
  library with no Durable Object lookup, and the test checks which bucket counted each one;
  `app.fetch` does not serve the callback route; and the `wrangler.jsonc` bindings match
  the code.
- Breaking change: `app.fetch` no longer serves `/v1/commit-checks/...`. The route was
  always meant for `fetchCallback`, and no supported wrapper sent callbacks through `fetch`.
