# ADR 0027: One model for byte and CPU budgets

- Status: proposed
- Issues: #56, #52, #63 (also #53, #42)
- Amends: [ADR 0016](0016-bytes-wire-contract.md) ("Bounds and failures": the per-value
  limit and the fixed internal result bounds),
  [ADR 0024](0024-transaction-step-machine.md) ("Bounds", "One place for limits": which
  limits are fixed protocol constants)
- Related: [ADR 0018](0018-wrapper-owned-rate-limiting.md),
  [ADR 0019](0019-library-layers-and-the-wrapper-boundary.md),
  [ADR 0021](0021-explicit-engine-config.md),
  [ADR 0025](0025-core-defined-canonical-json.md)

## Context

A request passes through about a dozen byte and work bounds. They were added one at a time,
by different ADRs, as constants in different layers (origin/main `f44fcdb`):

| Bound | Value | Where | Kind today |
| --- | --- | --- | --- |
| HTTP body, streamed | 1,048,576 | `MAX_BODY_BYTES`, `src/request-body.ts`, `src/http/body.ts` | TS constant |
| Engine body text (UTF-8) | 1,048,576 | `parseBodyText` | TS constant |
| Advertised `maxRequestBytes` | 1,048,576 | `MAX_REQUEST_BYTES`, `policysql-wasm` | Rust constant; must equal the TS one, nothing checks it |
| WASM session JSON; auth + request JSON; raw result JSON per statement | 1 MiB each | `MAX_REQUEST_BYTES` reused | Rust constant |
| SQL text per statement | 65,536 | `MAX_SQL_BYTES` | Rust constant (400 `POLICYSQL_INVALID_REQUEST`) |
| Decoded bytes per value | 262,144 | `policysql_core::bytes::MAX_BYTES_PER_VALUE` | Rust constant |
| Expression depth / parameters / projections / joins | 32 / 128 / 128 / 8 | `BindingLimits::default()`, `policysql-parser` | Rust constant |
| Expression height (upstream) | 100 | `turso_parser::parser::MAX_EXPR_DEPTH` (`=0.7.2`) | dependency constant |
| Rows, result bytes per statement | required | `RuntimeLimits` (`maxRows`, `maxResultBytes`, up to 2^53 - 1) | configured |
| Turso HTTP response | 2,097,152 | `MAX_RESPONSE_BYTES`, `src/turso-http.ts`; read whole before the check (#53) | TS constant |
| Step event; volatile state | `max_statements` × 1 MiB + 64 KiB; 256 KiB + 4 × event | `policysql-transaction` machine | Rust, derived from `max_statements` |
| `identity_json`, `cost_estimate_json` input | 4 MiB | `policysql-transaction` | Rust constant |
| Durable owner record; interactive result bytes | 96 KiB; ≤ 65,536 | ADR 0024 | fixed / configured within a fixed max |
| Final response | none | — | — |
| CPU per invocation | 50 ms | `deploy/cloudflare/wrangler.jsonc` `limits.cpu_ms` | reference wrapper |

Three issues report the consequences:

- **#56.** A valid body under the 1 MiB limit costs more CPU than the reference deployment's
  `cpu_ms: 50`, so an authenticated client can make its own requests fail with an
  outcome-unknown 5xx. Nothing relates the byte limits to the CPU limit.
- **#52.** A deployment cannot raise the BLOB, request, or result limits, and when one is
  raised conceptually, a smaller hidden bound bites first (base64 overhead against the body
  limit, the 1 MiB WASM result bound, the 2 MiB Turso bound). The final response has no
  bound at all. (The reporter has since withdrawn the 1 MiB BLOB requirement; the
  configurability, hidden-bound, and final-response points stand.)
- **#63.** The parser limits are far below SQLite's and reject legitimate statements
  (a 20 × 7 bulk INSERT needs 140 parameters); `maxSqlBytes` and `maxJoins` are reported
  from constants that are not the values `BindingLimits` enforces through the same path.

### Measurements

Reference machine: i7-7700K 4.2 GHz, Node 26.4, the committed release WASM (ABI 8) on
origin/main `f44fcdb` (after ADR 0024 pull request 9, so no dual hashing). Each figure is the
best of five runs after a warm-up, in ms of wall time on a single-threaded CPU-bound path,
through the routing test harness with the real engine, HTTP adapter, Durable Objects
adapter (simulated platform), and Turso HTTP transport. Time spent inside the simulated Turso
server (request parse, SQLite, response build) and the harness client's `response.json()` is
measured separately and subtracted. Bodies are about 1,000,000 bytes (0.954 MiB): one
`INSERT … VALUES(:id,:name,:state,:metadata)` whose JSON-typed `metadata` (or `name`/`state`)
carries the shape.

| Shape (≈ 1 MB) | `parseBodyText` | core `identity_json` | rejected by compile (no DB) | atomic, keyed | interactive statement (owner) | SELECT it back (≈ 1 MB response) |
| --- | --- | --- | --- | --- | --- | --- |
| nested arrays, depth 56 | 96 | 87 | 147 | **221** | 205 | **512** |
| one object, unique keys | 73 | 50 | 123 | 164 | 146 | 413 (raw result > 1 MiB) |
| short strings `"s1"` | 48 | 27 | 107 | 151 | 114 | 413 (raw result > 1 MiB) |
| short decimals `37.4` | 64 | 32 | 87 | 115 | 111 | 311 |
| small integers | 59 | 24 | 77 | 101 | 100 | 262 |
| 17-digit decimals | 34 | 15 | 51 | 66 | 63 | 89 |
| 256 KiB BLOB + long string | 3 | 7 | 13 | 52 | 41 | 42 |
| one long ASCII string | 4 | 7 | 13 | 22 | 18 | 16 |
| one long CJK string | 3 | 5 | 10 | 20 | 17 | 14 |

At 250,000 and 64,000 bytes the costs scale linearly (nested arrays: atomic 47 ms and
12.5 ms, SELECT 113 ms and 28.7 ms; a small request costs 2–3 ms). The streamed HTTP read
itself is under 2 ms per MB. The earlier figures in #56 and the PR #55 review (108 ms for a
non-compiling body of short decimals, 43–52 ms for a compiling one, before SQL) agree in
magnitude; the shapes above are worse because they were chosen to be.

Findings that shape the decision:

1. **Cost is linear in bytes, with a large constant per MiB.** Worst measured: about
   **235 ms per MiB of request** and **540 ms per MiB of result** (public result bytes) on the
   reference machine. A 1 MiB body cannot fit 50 ms on any shape that is not one long string.
2. **The result path costs twice the request path per byte.** A CPU profile of the SELECT
   case puts the largest self time in `parseExact` (`src/exact-json.ts`, a `JSON.parse`
   reviver over every value of every step output), then GC, then the hand-written
   duplicate-key scanner of `parseBodyText` (its per-character `/\s/` test), then WASM. These
   are implementation costs, not inherent ones (pull request 7 below).
3. **Validation cost is bounded by the raw bound, not by `maxResultBytes`.** A statement's raw
   result is parsed and validated up to 1 MiB before `maxResultBytes` (default 64,000) is
   applied, and per statement, so an 8-statement envelope can make PolicySQL validate 8 MiB to
   return nothing.
4. **Hidden bounds are reachable with valid data.** A 1 MB JSON value accepted on write
   cannot be read back: Hrana returns it as a JSON-escaped text cell whose raw result exceeds
   the 1 MiB WASM bound (413). A body near 1 MiB plus a session can exceed the 1 MiB
   auth + request WASM bound (400 `POLICYSQL_INVALID_REQUEST`, a client-visible
   misclassification). The step event bound does not account for the JSON escaping of the
   body text it embeds.
5. **The upstream parser caps expression height at 100.** An OR chain of 33–99 terms is
   rejected by the binder (413 `POLICYSQL_LIMIT_EXCEEDED`), 100 or more by `turso_parser`
   (400 `POLICYSQL_INVALID_SQL`); nested parentheses hit the upstream cap at 99. The emitted
   SQL is re-parsed by the same parser, so the client depth plus what policy composition
   adds must stay below it.
6. **SQL text over 64 KiB is 400 `POLICYSQL_INVALID_REQUEST`**, while `website/api/errors.md`
   documents it as 413 `POLICYSQL_REQUEST_TOO_LARGE`.

Cloudflare facts used ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)):
Workers Paid allows `limits.cpu_ms` up to 300,000 ms (default 30,000 ms), the limit applies to
Durable Objects too (PR #55 review), network wait does not count, and an isolate has 128 MB
for the JavaScript heap and WebAssembly memory together.

## Decision

### Three kinds of bound, and nothing else

Every bound is exactly one of:

1. **Configured limit.** A `RuntimeLimits` field (ADR 0024 "One place for limits"): the wrapper
   sets it, the runtime validates it and fills the default, `limits_json` reports it, the
   engine and core enforce exactly that value, and Capabilities advertises exactly that
   value. Each has a default and a hard maximum.
2. **Fixed protocol constant.** Part of the specification, not of a deployment: it bounds a
   format PolicySQL defines (policy, durable state) or a platform storage unit. Not
   configurable; reported by `limits_json` where clients need it.
3. **Derived internal bound.** A memory guard on an internal hop (WASM input, raw database
   result, step event, hash input). It is a function of configured limits, computed by core
   at construction, never configured and never advertised, and always at least as large as
   the largest input the configured limits admit. A derived bound therefore never rejects
   data that every configured limit accepts; when it rejects, the data was already over a
   configured limit, and the error is that limit's error.

No other byte constant may exist on the request path. The engine-boundary test gains a rule:
no numeric byte limit literal in `deploy/cloudflare/src` outside the fixed list below.

### Configured limits

All are `RuntimeLimits` fields (camelCase in TypeScript, snake_case in `limits_json`).
Existing fields not listed (`timeoutMs`, `maxStatements`, `transactionMs`,
`maxTransactionStatements`, `maxTransactionResultBytes`, `maxCallbackRows`,
`beginTimeoutMs`, `costTimeoutMs`) keep their defaults and ranges.

| Field | Default | Range | Counted as | Enforced where | Error |
| --- | --- | --- | --- | --- | --- |
| `maxRequestBytes` (new; was fixed) | 1,048,576 | 65,536 – 4,194,304 | UTF-8 bytes of the body as received, BOM included | HTTP adapter (streamed), engine (`parseBodyText`), core (derived WASM bounds) | 413 `POLICYSQL_REQUEST_TOO_LARGE` |
| `maxSqlBytes` (new; was fixed) | 65,536 | 1,024 – min(1,048,576, `maxRequestBytes`) | UTF-8 bytes of one statement's `sql` | core, before parsing | 413 `POLICYSQL_REQUEST_TOO_LARGE`, path `/statements/<i>/sql` (was 400) |
| `maxBytesPerValue` (new; was fixed) | 262,144 | 1 – 3,145,728 | decoded bytes of one bytes value (parameter, preset, result cell) | core codecs, the Turso adapters (from the runtime) | 413 `POLICYSQL_LIMIT_EXCEEDED` (malformed: 400 `POLICYSQL_INVALID_PARAMETER`) |
| `maxParameters` (new) | 1,024 | 1 – 16,384 | distinct client parameter names per statement | binder | 413 `POLICYSQL_LIMIT_EXCEEDED`, statement path |
| `maxExpressionDepth` (new) | 64 | 1 – 64 | binder expression depth (an `a OR b OR …` chain of n terms has depth n − 1) | binder | 413 `POLICYSQL_LIMIT_EXCEEDED`, statement path |
| `maxProjections` (new) | 128 | 1 – 2,000 | result columns per SELECT/RETURNING | binder | 413 `POLICYSQL_LIMIT_EXCEEDED`, statement path |
| `maxJoins` (new; was fixed) | 8 | 1 – 64 | joins per FROM | binder | 413 `POLICYSQL_LIMIT_EXCEEDED`, statement path |
| `maxRows` | required | 1 – 100,000 (was 2^53 − 1) | rows per statement | core | 413 `POLICYSQL_LIMIT_EXCEEDED` |
| `maxResultBytes` | required | 1 – 4,194,304 (was 2^53 − 1) | public encoding of the rows (`JSON.stringify` of row objects, canonical numbers, base64 BLOBs), per statement and cumulatively per atomic envelope | core | 413 `POLICYSQL_LIMIT_EXCEEDED` |
| `maxResponseBytes` (new) | `maxResultBytes` + 65,536 | `maxResultBytes` – 4,259,840 | UTF-8 bytes of the complete success response body, with a fixed 1,024-byte reserve for fields added after commit (`requestId` ≤ 128 bytes, `meta`) | core, before COMMIT | 413 `POLICYSQL_LIMIT_EXCEEDED` |

Ranges and why:

- `maxRequestBytes` ≤ 4 MiB: the measured worst request costs about 1 s of CPU per 4 MiB on
  the reference machine, and peak memory per request is a small multiple of the body (UTF-16
  text, the parsed JS value, the UTF-8 copy in WASM, the `serde_json` tree, the event and
  volatile copies). 4 MiB keeps that well inside the 128 MB isolate. The minimum of 64 KiB
  keeps one maximal SQL text plus framing expressible.
- `maxBytesPerValue` ≤ 3,145,728: its base64 form (4,194,304 bytes) fits the largest request.
  No combination with `maxRequestBytes` or `maxResultBytes` is rejected: a deployment may
  read BLOBs larger than any request it accepts (written by another system), and ADR 0016
  already accepts a value too large to RETURNING. Capabilities advertises all three, and the
  documentation states that the usable size is the smallest that applies to the path.
- Parser limits against SQLite ([limits](https://sqlite.org/limits.html)): parameters 16,384
  is half of SQLite's 32,766 host parameters, leaving room for server-owned parameters in the
  emitted statement; core rejects an emitted statement over 32,766 parameters as
  `POLICYSQL_LIMIT_EXCEEDED`. Depth 64 is below `turso_parser`'s height cap of 100 so that
  client depth + policy composition still re-parses: policy activation rejects a predicate
  deeper than 16, and construction checks `maxExpressionDepth + 16 + 4 ≤ 96` (the 4 is the
  composition wrapper; the margin below 100 absorbs parentheses the emitter adds). If the
  dependency raises its cap, the maximum may rise with a new ADR. Projections 2,000 equals
  SQLite's `SQLITE_MAX_COLUMN`; joins 64 equals SQLite's join limit, and database time stays
  bounded by `timeoutMs` and cost admission.
- `maxResultBytes` ≤ 4 MiB and `maxRows` ≤ 100,000: the result path is the most expensive
  per byte (540 ms per MiB measured) and its memory scales the same way as the request's.
- `maxResponseBytes` ≥ `maxResultBytes` is checked at construction: a smaller value would
  make the configured result limit unreachable, which is the hidden-bound problem of #52.

The defaults raise `maxParameters` (128 → 1,024) and `maxExpressionDepth` (32 → 64); every
other default equals today's value, so a deployment that configures nothing new accepts a
superset of what it accepts today, except the bounds in "Breaking changes".

### Fixed protocol constants

| Constant | Value | Why fixed |
| --- | --- | --- |
| `maxCommitChecks`, `maxHookDurationMs` | 4, 1,500 ms | policy format bounds (ADR 0007/0021) |
| Durable owner record; `maxTransactionResultBytes` maximum | 96 KiB; 65,536 | Durable Object value size (ADR 0024); an interactive transaction's results stay ≤ 64 KiB, larger results need atomic execute |
| Configuration input (catalog, policy, physical schema) | 1 MiB each | construction input, not request data |
| Session JSON (wrapper-supplied) | 65,536 (was 1 MiB) | wrapper data; a larger one is a wrapper fault, 500 `POLICYSQL_INTERNAL` |
| Body JSON nesting (engine) / canonical nesting (core) | 64 / 127 | parser recursion; unchanged |
| Database control response (BEGIN, COMMIT, ROLLBACK, close) | 65,536 | not result data; over it is a transport failure (503, or `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` for COMMIT), never a limit |
| Validator (commit-check) response | 65,536 | an allow/deny answer; over it denies the commit as a failed validator |
| Upstream expression height | 100 (`turso_parser` 0.7.2) | dependency; deeper SQL is 400 `POLICYSQL_INVALID_SQL` before PolicySQL sees a tree, documented and unreachable by a client that respects the advertised depth |

### Derived internal bounds

Core computes these at construction from the effective limits (`MiB` = 1,048,576):

| Bound | Formula | Default value | Replaces |
| --- | --- | --- | --- |
| WASM compile input (session + body) | `maxRequestBytes + 65,536` | 1,114,112 | 1 MiB (finding 4) |
| Raw database result, cumulative per atomic envelope or per interactive statement | `6 × maxResultBytes + 65,536` | 449,536 | 1 MiB per statement (WASM) and 2 MiB per response (Turso) |
| Step event | `2 × maxRequestBytes + raw result bound + 65,536` | 2,612,224 | `max_statements` × 1 MiB + 64 KiB |
| Volatile state | `262,144 + 4 × step event` | unchanged formula | — |
| `identity_json` / `cost_estimate_json` input | `2 × maxRequestBytes + 65,536` | 2,162,688 | 4 MiB |

- The factor 2 covers JSON escaping of the body text inside the event (`"` and `\` become
  two bytes; raw control characters cannot appear in valid JSON text).
- The factor 6 covers Hrana's typed-cell framing against the public encoding: the worst cell
  is a one-digit integer, `{"type":"integer","value":"1"},` (31 bytes) against `"a":1,`
  (6 bytes with a one-character name), and escaping is the same in both encodings. Pull
  request 6 adds a property test that generates results exactly at `maxResultBytes` for the
  widest Catalog projection and asserts the raw form stays within the bound; if it does not,
  the factor changes, not the rule.
- The raw result bound is **cumulative and checked before parsing**: the engine hands the
  transport the remaining raw budget as its read cap, and core checks each statement's raw
  length against what remains before it parses a byte. Validation CPU is therefore
  proportional to `maxResultBytes`, not to `maxStatements` × 1 MiB (finding 3).
- Exceeding a derived bound is reported as the configured limit it derives from:
  request-derived bounds as 413 `POLICYSQL_REQUEST_TOO_LARGE`, result-derived bounds as 413
  `POLICYSQL_LIMIT_EXCEEDED` with rollback. The 400 for an oversized auth + request input
  (finding 4) disappears.

### Streamed enforcement

No component buffers past a limit it knows (relates to #53):

- **HTTP request body:** already streamed (`readBodyText`); it reads the limit from the
  engine's runtime limits instead of `MAX_BODY_BYTES` and cancels the stream at the first
  chunk that crosses it. A declared `Content-Length` over the limit is rejected unread.
- **Turso HTTP response:** read as a byte stream, counting UTF-8 bytes received, cancelled at
  the first chunk over the cap (the remaining raw result budget for a statement, 65,536 for a
  control request). A declared `Content-Length` over the cap is rejected unread; an
  understated one changes nothing because counting is on received bytes.
- **Durable Objects wire, validator responses:** bounded the same way by the response and
  validator bounds above.
- **Database drivers that buffer internally** (for example `@tursodatabase/serverless`)
  cannot honour a read cap. Their adapters still apply the raw bound before handing the result
  to core, and the port contract says so: a driver adapter bounds memory only after the
  driver returns. This is recorded as a conformance difference, not hidden.

### Final response

`maxResponseBytes` bounds what leaves PolicySQL, not only the rows:

- **Atomic execute:** core already builds the response before COMMIT (it is the
  `response_json` written to `policysql_idempotency` in the same transaction). Core measures
  it, plus the 1,024-byte reserve, before emitting `Commit`; over the limit, the envelope
  rolls back with 413 `POLICYSQL_LIMIT_EXCEEDED`, so no mutation and no idempotency record
  survives. A keyed retry of a committed request returns the stored response unchanged,
  even if the deployment has since lowered the limit (it fitted when it was committed).
- **Interactive statement, callback query:** the statement reply is measured the same way
  before it is sent; over the limit, the statement fails as a result limit does today, and
  the transaction's existing rule for a failed statement applies. Interactive results remain
  under the cumulative `maxTransactionResultBytes` (≤ 64 KiB) as well.
- **Explain, Catalog, Capabilities:** their size is a function of the Catalog and policy,
  validated at construction (configuration input ≤ 1 MiB), and is not limited per request.

### CPU budget

The CPU a single Worker or Durable Object invocation spends is modelled as

```
cpu_ms ≥ S × F × (C0 + a_req × R + a_res × P)
```

- `R` = `maxRequestBytes` / MiB, `P` = `maxResultBytes` / MiB (an atomic envelope's results
  are cumulative under it; an interactive invocation has either a body or results of one
  statement, so the sum is conservative).
- Coefficients on the reference machine, worst measured shape, current code: `C0` = 5 ms,
  `a_req` = 235 ms/MiB, `a_res` = 540 ms/MiB.
- `F` = Workers CPU time / reference machine time. Not yet measured; **2.0** until the
  real-environment smoke measures it (pull request 1).
- `S` = 1.25 safety margin (isolates tolerate occasional overruns, sustained ones are
  terminated).

With the defaults (`R` = 1, `P` = 64,000 / MiB = 0.061): 1.25 × 2.0 × (5 + 235 + 33) ≈ 683 ms.
Holding 50 ms with these coefficients would need about 29 KiB of request and 16 KiB of
result, which is not a usable deployment.

Decisions:

- **The library does not refuse a combination at construction because of CPU.** The CPU
  limit, the platform, and the hardware factor are deployment knowledge (ADR 0019); the
  library cannot know them, and a refusal based on a guessed `F` would be wrong in both
  directions. It refuses only structural inconsistencies: `maxResponseBytes` <
  `maxResultBytes`, `maxSqlBytes` > `maxRequestBytes`, the depth check above, and the
  existing durable-state check.
- **The formula and coefficients are documented** in `docs/configuration.md`, with the
  measurement script that produces them (`deploy/cloudflare/scripts/measure-cpu.mjs`, pull
  request 1) so a wrapper can re-measure on its own shapes. A wrapper raising a byte limit
  raises `cpu_ms` by the formula; one that cannot (Workers Free, 10 ms) must lower the byte
  limits instead.
- **The reference wrapper stays consistent by test.** `deploy/cloudflare/wrapper` gets a test
  that reads `wrangler.jsonc` `limits.cpu_ms` and `RUNTIME_LIMITS` and fails when the formula
  is violated. Its `cpu_ms` becomes **700** (from 50) with today's coefficients; pull request
  7 lowers the coefficients and then the value. The runbook alert "p95 CPU above 40 ms"
  becomes "p95 CPU above 50% of `cpu_ms`".
- **Rate limiting remains the cost guard** (ADR 0018). The 50 ms cap was acting as one; it
  cannot, because it fails valid requests of the authenticated caller with an
  outcome-unknown 5xx (#56) instead of rejecting them up front with 413.

### Capabilities

`limits` in Capabilities is built only from `limits_json` and advertises exactly the enforced
values: `maxRows`, `maxResultBytes`, `maxResponseBytes`, `timeoutMs`, `maxStatements`,
`maxRequestBytes`, `maxSqlBytes`, `maxBytesPerValue`, `maxParameters`, `maxExpressionDepth`,
`maxProjections`, `maxJoins`. `PolicySqlRuntime.max_bytes_per_value` is removed; the
per-value limit is a `limits_json` field like the others, and every TypeScript reader (driver
value classification, the Turso transport's `maxBytesPerValue` option, the WASM parameter
codec) takes it from there. `BindingLimits` is constructed from the runtime limits, so the
binder enforces the advertised values; a test asserts every advertised limit by sending a
request at the value and one over it. Derived bounds and fixed internal constants are not
advertised. `spec/openapi.yaml` lists the new `limits` properties (additive; the schema
already allows additional properties).

### Error semantics, summarised

| Condition | Status, code | Transaction effect |
| --- | --- | --- |
| Body over `maxRequestBytes` (declared, streamed, or engine text) | 413 `POLICYSQL_REQUEST_TOO_LARGE` | none started |
| SQL text over `maxSqlBytes` | 413 `POLICYSQL_REQUEST_TOO_LARGE`, `/statements/<i>/sql` | none started |
| Parameters, depth, projections, joins over their limit | 413 `POLICYSQL_LIMIT_EXCEEDED`, statement path | none started |
| Expression beyond the upstream height cap | 400 `POLICYSQL_INVALID_SQL` | none started |
| Bytes parameter malformed / over `maxBytesPerValue` | 400 `POLICYSQL_INVALID_PARAMETER` / 413 `POLICYSQL_LIMIT_EXCEEDED` | none started |
| Rows, result bytes, raw result bound, BLOB cell over the limit, response over `maxResponseBytes` | 413 `POLICYSQL_LIMIT_EXCEEDED` | rolled back before COMMIT; no idempotency record |
| Interactive cumulative limits | 429 `POLICYSQL_TRANSACTION_LIMIT_EXCEEDED` (unchanged) | per ADR 0024 |
| Control response or validator response over its fixed bound | 503 `POLICYSQL_DATABASE_UNAVAILABLE`, or `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` for COMMIT; validator: commit denied | per ADR 0007/0024 |
| Session JSON over 65,536 | 500 `POLICYSQL_INTERNAL` (wrapper fault) | none started |
| Invalid or inconsistent limits | construction error naming the field, never a value | no request served |

413 means "this request or its result is too large under this deployment's limits and
retrying the same request will not help"; it is never used for a COMMIT outcome.

## Breaking changes (beta; no compatibility layer, ADR 0019)

1. `RuntimeLimits` gains `maxRequestBytes`, `maxSqlBytes`, `maxBytesPerValue`,
   `maxParameters`, `maxExpressionDepth`, `maxProjections`, `maxJoins`, `maxResponseBytes`.
   `maxRows` and `maxResultBytes` gain hard maxima (100,000 and 4,194,304); a configuration
   above them now fails at construction.
2. `MAX_BODY_BYTES` is no longer exported; the HTTP adapter and conformance suite read the
   limit from the engine.
3. SQL text over the limit changes from 400 `POLICYSQL_INVALID_REQUEST` to 413
   `POLICYSQL_REQUEST_TOO_LARGE` (the documented code).
4. Parser defaults accept more: 1,024 parameters, depth 64.
5. The raw result bound becomes cumulative and derived (default 449,536 bytes instead of
   1 MiB per statement and 2 MiB per Turso response). Statements that were validated and
   then rejected for `maxResultBytes` are now rejected before validation, with the same code.
6. Database control responses are bounded at 65,536 bytes (were 2 MiB).
7. The session JSON bound becomes 65,536 bytes (was 1 MiB).
8. A response over `maxResponseBytes` is now 413 and rolls back.
9. `PolicySqlRuntime.max_bytes_per_value` is removed and the `limits_json` shape grows: WASM
   ABI 9. The snapshot changes, so open transactions and idempotency fingerprints from ABI 8
   do not match (as for every ABI change).
10. Reference wrapper: `cpu_ms` 50 → 700 (provisional), runbook alert threshold relative to
    `cpu_ms`.
11. Capabilities `limits` gains fields (additive).

## Implementation pull requests

Each is independently mergeable, keeps the suites green, and passes the real-environment
smoke (`deploy/cloudflare/scripts/provision-dev.mjs`) before merge.

1. **Measure, and make the reference wrapper consistent (#56, #42).** Add
   `scripts/measure-cpu.mjs` (the shapes above, request and result paths, harness time
   excluded) and a smoke step that sends the worst request shape at `maxRequestBytes` and
   reads the invocation's CPU time from Workers observability, recording `F`. Set the
   reference `cpu_ms` from the formula, add the wrapper consistency test, update the runbook
   and `docs/configuration.md` (formula, coefficients). No library behaviour change.
2. **Streamed Turso response (#53).** Byte-counted streaming read with cancel, UTF-8 byte
   counting, the 65,536 control-response bound; the statement cap is still 2 MiB until pull
   request 6. Regression fixtures from #53 (no length, understated length, chunked,
   exact/over by one, invalid UTF-8).
3. **Request budget (`maxRequestBytes`, `maxSqlBytes`).** Fields in `RuntimeLimits`; HTTP
   adapter and engine read them; derived WASM input, event, and hash-input bounds; session
   bound 65,536; SQL over limit becomes 413. ABI 9. Tests at the limit and one byte over, for
   ASCII, multi-byte UTF-8, a BOM, and a body whose escaping doubles inside the event.
4. **Parser limits (#63).** `maxParameters`, `maxExpressionDepth`, `maxProjections`,
   `maxJoins` in `RuntimeLimits`; `BindingLimits` built from them; policy predicate depth
   ≤ 16 and the construction depth check; the emitted-parameter check; Capabilities from
   `limits_json`. Positive, negative, bypass (depth through CTEs, subqueries, policy
   composition), and differential tests (a statement accepted by PolicySQL is accepted by
   SQLite) for long OR chains, many parameters, and long SQL.
5. **Per-value bytes (#52).** `maxBytesPerValue` in `RuntimeLimits`, threaded through
   `policysql-core` codecs, `policysql-sqlite`, `policysql-turso`, and the adapters; the
   getter removed. Shared byte vectors at the limit and one over, empty, invalid base64,
   unpadded Hrana form.
6. **Result and response budget (#52).** Hard maxima for `maxRows`/`maxResultBytes`;
   `maxResponseBytes`; the cumulative raw result bound passed to the transport as its read
   cap; the response measured before COMMIT; the raw-expansion property test. Rollback and
   keyed-replay tests (over the limit leaves no row and no idempotency record; a retry of a
   committed request returns the stored response).
7. **CPU reductions (#56).** Parse and duplicate-check the body once, in core, instead of
   the TypeScript scanner plus `JSON.parse` plus `serde_json`; read step output without a
   reviver when it holds no unsafe integer; stop restating results through volatile JSON
   more than once. Re-run pull request 1's measurement, update the coefficients and the
   reference `cpu_ms`. Target: `a_req` ≤ 100 and `a_res` ≤ 200 ms/MiB.

Pull requests 1, 2, and 4 depend on nothing else here; 3 precedes 5 and 6 (they share the
ABI bump and the derived-bound plumbing); 7 comes last so its measurements cover the final
paths.

## Consequences

- Every byte bound has one home and one kind; a wrapper raising a limit cannot meet a
  smaller hidden one, and Capabilities states the whole contract a client needs.
- CPU becomes a documented function of the byte limits that the deployment owns. The
  reference deployment's CPU cap rises substantially until pull request 7 lands.
- Validation work becomes proportional to configured result size, which also shrinks the
  default deployment's worst case (finding 3).
- Costs: an ABI bump; eight more configuration fields; a measurement step in the smoke run.

## Rejected alternatives

- **Keep the byte limits fixed and lower the request limit to fit 50 ms.** About 29 KiB of
  body with today's coefficients; it would break the existing 256 KiB per-value contract and
  ordinary bulk inserts.
- **Let the library refuse limits that exceed a declared CPU budget.** The coefficients
  depend on hardware and shapes; the library would either refuse valid deployments or give
  false assurance. A wrapper test with its own measured `F` is the same check in the right
  layer.
- **Separate configurable knobs for each internal hop** (WASM input, raw result, Turso
  response). They are memory guards whose only correct values follow from the configured
  limits; exposing them invites exactly the hidden-bound configurations of #52.
- **Bound the final response only by `maxResultBytes`.** Column descriptors, redactions,
  warnings, and meta are outside it; #52 asks for a bound on what actually leaves.

## Open questions for the maintainer

1. **Reference wrapper trade-off.** Keep `maxRequestBytes` at 1 MiB and raise `cpu_ms` to
   about 700 ms now (this ADR), or lower the reference wrapper's `maxRequestBytes` to
   256 KiB and use about 250 ms until pull request 7?
2. **`F` before measurement.** Is 2.0 an acceptable placeholder for the Workers/reference
   ratio until pull request 1 measures it?
3. **Interactive result size.** Interactive results stay ≤ 64 KiB because the durable record
   stores the last reply. Is that acceptable, or should a later ADR store only a digest of
   the last reply (making larger interactive results possible at the cost of replay)?
4. **Upstream depth error.** Keep 400 `POLICYSQL_INVALID_SQL` for SQL beyond
   `turso_parser`'s height cap, or classify it as 413 by matching the pinned version's error
   message?
5. **Hard maxima.** Are 4 MiB (request, result), 3 MiB (per value), 16,384 parameters, and
   depth 64 the right ceilings, or should any be lower for a first release?
6. **Buffering drivers.** Accept the documented conformance difference for drivers that
   cannot stream (`@tursodatabase/serverless`), or require HTTP transport for deployments
   that raise `maxResultBytes` above the default?
7. **Raw expansion factor.** Accept 6 as the starting factor, to be confirmed by the
   property test in pull request 6?
