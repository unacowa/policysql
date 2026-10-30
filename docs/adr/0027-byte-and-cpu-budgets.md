# ADR 0027: One model for byte, value, and CPU budgets

- Status: proposed
- Issues: #56, #52, #63 (also #53, #42)
- Amends: [ADR 0016](0016-bytes-wire-contract.md) ("Bounds and failures": the per-value
  limit and the fixed internal result bounds),
  [ADR 0024](0024-transaction-step-machine.md) ("Bounds", "One place for limits": which
  limits are fixed protocol constants)
- Related: [ADR 0007](0007-transaction-retry-and-commit-check-protocol.md),
  [ADR 0018](0018-wrapper-owned-rate-limiting.md),
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
| Rows, result bytes per statement | required | `RuntimeLimits` (`maxRows`, `maxResultBytes`, up to 2^53 − 1) | configured |
| Statements per envelope | required | `RuntimeLimits` (`maxStatements`, up to 2^32 − 1) | configured |
| Turso HTTP response | 2,097,152 | `MAX_RESPONSE_BYTES`, `src/turso-http.ts`; read whole before the check (#53) | TS constant |
| Step event; volatile state | `max_statements` × 1 MiB + 64 KiB; 256 KiB + 4 × event | `policysql-transaction` machine | Rust, derived from `max_statements` |
| `identity_json`, `cost_estimate_json` input | 4 MiB | `policysql-transaction` | Rust constant |
| Durable owner record; interactive result bytes | 96 KiB; ≤ 65,536 | ADR 0024 | fixed / configured within a fixed max |
| Number of JSON values in a body or result | none | — | — |
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
  from constants, not from the `BindingLimits` the binder enforces.

### Measurements

Reference machine: i7-7700K 4.2 GHz, Node 26.4, the committed release WASM (ABI 8) on
origin/main `f44fcdb` (after ADR 0024 pull request 9, so no dual hashing). Each figure is the
best of five runs after a warm-up, in ms of wall time on a single-threaded CPU-bound path,
through the routing test harness with the real engine, HTTP adapter, Durable Objects
adapter (simulated platform), and Turso HTTP transport. Time spent inside the simulated Turso
server (request parse, SQLite, response build) and the harness client's `response.json()` is
measured separately and subtracted. WASM memory is the linear memory size after the
operation in a fresh process (linear memory never shrinks, so it is the high-water mark).

**Request and JSON-cell result path.** Bodies are about 1,000,000 bytes (0.954 MiB): one
`INSERT … VALUES(:id,:name,:state,:metadata)` whose JSON-typed `metadata` (or `name`/`state`)
carries the shape. "Values" counts every JSON value plus every object member name.

| Shape (≈ 1 MB) | values | `parseBodyText` | rejected by compile (no DB) | atomic, keyed | interactive statement | SELECT it back (≈ 1 MB response) | WASM after compile + hash | WASM after SELECT |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nested arrays, depth 56 | 499,913 | 96 | 147 | **221** | 205 | **492–512** | **69.5 MiB** | **59 MiB** |
| one object, unique keys | 183,803 | 73 | 123 | 164 | 146 | 413 (raw > 1 MiB) | — | — |
| short strings `"s1"` | 199,961 | 48 | 107 | 151 | 114 | 413 (raw > 1 MiB) | — | — |
| short decimals `37.4` | 204,043 | 64 | 87 | 115 | 111 | 273–311 | 19.1 MiB | 18.9 MiB |
| small integers | 257,028 | 59 | 77 | 101 | 100 | 262 | — | — |
| 17-digit decimals | 56,121 | 34 | 51 | 66 | 63 | 89 | — | — |
| 256 KiB BLOB + long string | 5 | 3 | 13 | 52 | 41 | 42 | — | — |
| one long ASCII string | 3 | 4 | 13 | 22 | 18 | 16 | 8.3 MiB | 11.1 MiB |
| one long CJK string | 3 | 3 | 10 | 20 | 17 | 14 | — | — |

**Cell-heavy result path.** A table of n INTEGER columns holding one-digit values, every
column projected with `visible_if` (so each emits a visibility `CASE` companion column),
SELECT of all rows, default-sized results:

| rows × columns | public rows | raw Hrana | raw / public | SELECT | per public MiB | per raw MiB | WASM after |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 × 64, conditional | 51,491 | 407,199 | 7.9 | 18.9 ms | 386 ms | 49 ms | 2.8 MiB |
| 200 × 64, conditional | 103,091 | 807,299 | 7.8 | 32.5 ms | 331 ms | 42 ms | 4.1 MiB |
| 1,000 × 10, conditional | 83,891 | 655,348 | 7.8 | 27.1 ms | 338 ms | 43 ms | 3.4 MiB |
| 2,000 × 4, conditional | 84,891 | 564,831 | 6.7 | 25.3 ms | 313 ms | 47 ms | 3.4 MiB |
| 100 × 64, plain | 51,491 | 205,480 | 4.0 | 15.3 ms | 311 ms | 78 ms | 2.2 MiB |

At 250,000 and 64,000 bytes the request and JSON-cell costs scale linearly (nested arrays:
atomic 47 ms and 12.5 ms, SELECT 113 ms and 28.7 ms, WASM 18.3 and 15.7 MiB at 250,000; a small
request costs 2–3 ms). The streamed HTTP read itself is under 2 ms per MB. The earlier
figures in #56 and the PR #55 review agree in magnitude.

**Emitted expression height.** The emitter parenthesizes every binary node
(`crates/policysql-sqlite/src/lib.rs`, `binary` → `parenthesized`), `turso_parser` 0.7.2
counts a parenthesis as one level of height, and row filters compose as a left-deep `AND`
chain: `And(client, root filter)`, then one `And(previous, filter)` per inner join
(`crates/policysql-policy/src/lib.rs`). Probing the parser with text of exactly the emitted
shape (one-comparison policy filters):

| inner-join filters J | 0 | 1 | 2 | 4 | 8 | 16 | 32 | 46 | 48 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| longest client OR chain that re-parses | 48 | 47 | 46 | 44 | 40 | 32 | 16 | 2 | 0 |

So the emitted height is `2·D + 2·J + 4` for a client expression of binder depth D (an
n-term OR chain has binder depth n), and the 100 cap is reached at `D + J = 48`. A
re-parse failure reaches the client as 400 `POLICYSQL_UNSUPPORTED_SQL`. Today's 32 / 8 fit by
a margin of 8.

Findings that shape the decision:

1. **Cost and memory follow the number of JSON values, not bytes.** Per value: 0.4–0.9 µs
   on the request path and 1.0–1.3 µs on the result path (a JSON cell is parsed and
   canonicalized in core); memory about 120–170 bytes of WASM per value (170 for a cell of a
   cell-framed result, its raw text included). Per byte, without
   many values: under 25 ms and about 8–12 MiB of WASM per MiB of request, under 80 ms and
   5 MiB per MiB of cell-framed raw result. A byte limit alone cannot bound either: 1 MiB of
   nested arrays costs ten times the CPU and eight times the memory of 1 MiB of string.
2. **The default already exceeds 50 ms, and its memory is large.** A 1 MiB body of the worst
   shape takes 221 ms and 69.5 MiB of WASM memory, which stays allocated for the isolate's
   lifetime; the isolate has 128 MB for JavaScript and WebAssembly together.
3. **Profile.** The largest self times are `parseExact` (`src/exact-json.ts`, a `JSON.parse`
   reviver over every value of every step output), GC, the hand-written duplicate-key scanner
   of `parseBodyText` (a per-character `/\s/` test), then WASM. These are implementation
   costs (pull request 7).
4. **Validation cost is bounded by the raw bound, not by `maxResultBytes`.** A statement's raw
   result is parsed and validated up to 1 MiB before `maxResultBytes` is applied, per
   statement, so an 8-statement envelope can make PolicySQL validate 8 MiB to return nothing.
5. **Raw results are much larger than public results.** Hrana frames every cell as a typed
   object, and the emitter adds columns that are stripped before the public result: a
   visibility `CASE` per `visible_if` projection and a check column per mutation row
   (`crates/policysql-sqlite/src/lib.rs`, stripped in `crates/policysql-turso/src/lib.rs`).
   Measured raw/public is 7.8 with two- and three-character names; with one-character names
   and a check column it reaches about 12. Column metadata (`cols`) adds about 40 bytes per
   emitted column per statement, even for zero rows.
6. **Hidden bounds are reachable with valid data.** A 1 MB JSON value accepted on write
   cannot be read back (413 at the 1 MiB WASM result bound). A body near 1 MiB plus a session
   can exceed the 1 MiB auth + request WASM bound (400 `POLICYSQL_INVALID_REQUEST`). The step
   event bound ignores the JSON escaping of the body text it embeds.
7. **Expression depth is limited by the emitted height** (table above), not by the client's.
8. **Error-code drift.** SQL text over 64 KiB is 400 `POLICYSQL_INVALID_REQUEST`, while
   `website/api/errors.md` documents 413 `POLICYSQL_REQUEST_TOO_LARGE`. The client
   (`packages/client/protocol.js` `REJECTIONS`) lists only `LIMIT_EXCEEDED` under 413, so a
   `REQUEST_TOO_LARGE` answer, already returned today for an oversized body, is reported to
   applications as outcome-unknown instead of a definite rejection.

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
   format PolicySQL defines (policy, durable state, session envelope) or a platform unit. Not
   configurable; reported by `limits_json` where clients need it.
3. **Derived internal bound.** A memory guard on an internal hop (WASM input, raw database
   result, step event, hash input). It is the sum of the maxima of its components plus
   explicitly stated framing, computed by core (at construction, or per envelope at compile
   time where it depends on the compiled statements), never configured and never advertised.
   It is never smaller than the largest input the configured limits admit, so it never
   rejects data that every configured limit accepts; when it rejects, the data was already
   over a configured limit, and the error is that limit's error.

No other byte constant may exist on the request path. The engine-boundary test gains a rule:
no numeric byte limit literal in `deploy/cloudflare/src` outside the fixed list below.

### Configured limits

All are `RuntimeLimits` fields (camelCase in TypeScript, snake_case in `limits_json`).
Existing fields not listed (`timeoutMs`, `transactionMs`, `maxTransactionStatements`,
`maxTransactionResultBytes`, `maxCallbackRows`, `beginTimeoutMs`, `costTimeoutMs`) keep their
defaults and ranges.

| Field | Default | Range | Counted as | Enforced where | Error |
| --- | --- | --- | --- | --- | --- |
| `maxRequestBytes` (new; was fixed) | 1,048,576 | 65,536 – 2,097,152 | UTF-8 bytes of the body as received, BOM included | HTTP adapter (streamed), engine, core (derived bounds) | 413 `POLICYSQL_REQUEST_TOO_LARGE` |
| `maxJsonValues` (new) | 65,536 | 1,024 – 131,072 | JSON values plus object member names: in one body; and, separately, cumulatively in one atomic envelope's or interactive statement's results (each cell, plus every value inside a JSON-typed cell) | engine body scan before `JSON.parse`, aborting at the limit (core in pull request 7); core while validating results | body: 413 `POLICYSQL_REQUEST_TOO_LARGE`; results: 413 `POLICYSQL_LIMIT_EXCEEDED` |
| `maxSqlBytes` (new; was fixed) | 65,536 | 1,024 – min(1,048,576, `maxRequestBytes`) | UTF-8 bytes of one statement's `sql` | core, before parsing | 413 `POLICYSQL_REQUEST_TOO_LARGE`, path `/statements/<i>/sql` (was 400) |
| `maxBytesPerValue` (new; was fixed) | 262,144 | 1 – 1,572,864 | decoded bytes of one bytes value (parameter, preset, result cell) | core codecs, the Turso adapters (from the runtime) | 413 `POLICYSQL_LIMIT_EXCEEDED` (malformed: 400 `POLICYSQL_INVALID_PARAMETER`) |
| `maxParameters` (new) | 1,024 | 1 – 16,384 | distinct client parameter names per statement | binder | 413 `POLICYSQL_LIMIT_EXCEEDED`, statement path |
| `maxExpressionDepth` (new) | 38 (was 32) | 1 – 45, with the height check below | binder expression depth (an n-term `OR` chain has depth n) | binder | 413 `POLICYSQL_LIMIT_EXCEEDED`, statement path |
| `maxJoins` (new; was fixed) | 8 | 1 – 45, with the height check below | joins per FROM | binder | 413 `POLICYSQL_LIMIT_EXCEEDED`, statement path |
| `maxProjections` (new) | 128 | 1 – 2,000 | result columns per SELECT/RETURNING | binder | 413 `POLICYSQL_LIMIT_EXCEEDED`, statement path |
| `maxStatements` | required | 1 – 64 (was 2^32 − 1) | statements per atomic envelope | core | 413 `POLICYSQL_LIMIT_EXCEEDED` |
| `maxRows` | required | 1 – 100,000 (was 2^53 − 1) | rows per statement | core | 413 `POLICYSQL_LIMIT_EXCEEDED` |
| `maxResultBytes` | required | 1 – 524,288 (was 2^53 − 1) | public encoding of the rows (`JSON.stringify` of row objects, canonical numbers, base64 BLOBs), per statement and cumulatively per atomic envelope; counted while validating, aborting at the first row over the remaining budget | core | 413 `POLICYSQL_LIMIT_EXCEEDED` |
| `maxResponseBytes` (new) | `maxResultBytes` + 65,536 | `maxResultBytes` – 589,824 | UTF-8 bytes of the complete success response body, plus a fixed 1,024-byte reserve for fields added after commit (`requestId` ≤ 128 bytes, `meta`) | core, before COMMIT | 413 `POLICYSQL_LIMIT_EXCEEDED` |

Ranges and why:

- **Memory decides the maxima.** With the measured coefficients (finding 1), the WASM peak of
  one invocation is at most about `12 MiB × bytes (MiB) + 170 B × values` for whichever of
  the request phase and the result phase is larger (memory model below). The maxima keep both
  phases under 64 MiB, half the isolate, so the JavaScript heap has the other half: request
  phase `12 × 2 + 170 B × 131,072` ≈ 45 MiB; result phase `12 × 1.13` (the larger of twice
  the result bytes and the replay bound) `+ 21` ≈ 35 MiB. Each maximum can rise when pull
  request 7 lowers the coefficients, by amending this ADR.
- `maxJsonValues` is the bound that makes cost predictable: CPU and memory per value are
  measured, and a dense body is rejected at the first value over the limit, before
  `JSON.parse` materializes it. Typical OLTP requests have hundreds of values; 65,536 admits a
  1,024-parameter bulk insert with large JSON parameters.
- `maxBytesPerValue` ≤ 1,572,864: its base64 form (2,097,152 bytes) fits the largest request.
  No combination with `maxRequestBytes` or `maxResultBytes` is rejected: a deployment may
  read BLOBs larger than any request it accepts (written by another system), and ADR 0016
  already accepts a value too large to RETURNING. Capabilities advertises all of them, and the
  documentation states that the usable size is the smallest that applies to the path.
- **Expression depth and joins are bounded by the emitted height**, not by SQLite. With the
  measured emitter shape, the emitted `WHERE` height is `2 · max(D, P) + 2 · J + 4`, where
  `D` = `maxExpressionDepth`, `J` = `maxJoins`, and `P` is the deepest predicate of the
  active policy (filter, check, or `visible_if`), which policy activation computes. Construction
  requires that height to be at most 96 (a margin of 4 below the cap of 100), i.e.
  `max(maxExpressionDepth, P) + maxJoins ≤ 46`, and rejects the limits otherwise, naming both
  fields. The defaults (38 + 8 = 46) use the whole budget; a deployment that needs more joins
  lowers the depth, and the other way round. The re-parse invariant is "every statement the
  binder accepts emits SQL that `turso_parser` re-parses"; pull request 4 proves it at the
  configured maxima, including EXISTS, CTE, derived-table, and LEFT JOIN `ON` shapes, and, if
  a subquery adds height, adds its term to the formula. The alternative — stop
  parenthesizing nested `AND`/`OR` of the same operator and compose policy filters as a
  balanced tree — would lift the bound toward the parser cap; it is left for a later ADR
  because it changes the emitter's golden output.
- Parameters 16,384 is half of SQLite's 32,766 host parameters, leaving room for
  server-owned parameters; core rejects an emitted statement over 32,766 parameters as
  `POLICYSQL_LIMIT_EXCEEDED`. Projections 2,000 equals SQLite's `SQLITE_MAX_COLUMN`.
- `maxStatements` ≤ 64 bounds the column metadata term of the raw bound below.
- `maxResponseBytes` ≥ `maxResultBytes` is checked at construction: a smaller value would
  make the configured result limit unreachable, which is the hidden-bound problem of #52.

The defaults raise `maxParameters` (128 → 1,024) and `maxExpressionDepth` (32 → 38) and add
`maxJsonValues` = 65,536, which is new: a body or result with more JSON values than that is
now rejected. Every other default equals today's value.

### Fixed protocol constants

| Constant | Value | Why fixed |
| --- | --- | --- |
| `maxCommitChecks`, `maxHookDurationMs` | 4, 1,500 ms | policy format bounds (ADR 0007/0021) |
| Durable owner record; `maxTransactionResultBytes` maximum | 96 KiB; 65,536 | Durable Object value size (ADR 0024); an interactive transaction's results stay ≤ 64 KiB, larger results need atomic execute |
| Configuration input (catalog, policy, physical schema) | 1 MiB each | construction input, not request data |
| Session input JSON (wrapper-supplied) `A` | 65,536 (was 1 MiB) | wrapper data; a larger one is a wrapper fault, 500 `POLICYSQL_INTERNAL` |
| Database binding, Idempotency-Key | 2,048; 128 | already bounded by their syntax (four parts ≤ 256 characters; 16–128 characters) |
| Body JSON nesting (engine) / canonical nesting (core) | 64 / 127 | parser recursion; unchanged |
| Database control response (BEGIN, COMMIT, ROLLBACK, close) | 65,536 | not result data; over it is a transport failure (503, or `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` for COMMIT), never a limit |
| Validator (commit-check) response | 65,536 | an allow/deny answer; over it denies the commit as a failed validator |
| Upstream expression height | 100 (`turso_parser` 0.7.2) | dependency; client SQL deeper than that is 400 `POLICYSQL_INVALID_SQL` before PolicySQL sees a tree, and a client within the advertised depth can never reach it (pull request 4 proves this with a differential test) |

### Derived internal bounds

Each is the sum of its components' maxima plus framing stated separately (`MiB` =
1,048,576; `A` = 65,536, the session input; verified auth ≤ `A` + 1,024; binding ≤ 2,048;
key ≤ 128):

| Bound | Formula | Default value | Replaces |
| --- | --- | --- | --- |
| WASM compile input (verified auth + request) | `(A + 1,024) + maxRequestBytes + 1,024` | 1,116,160 | 1 MiB (finding 6) |
| Raw database result, per atomic envelope or interactive statement, computed at compile time | `2 × maxResultBytes + 64 × C + Σᵢ (512 + eᵢ × (2·nᵢ + 2·tᵢ + 32))` | see below | 1 MiB per statement (WASM), 2 MiB per response (Turso) |
| Idempotency lookup result | `2 × 589,824 + 4,096` = 1,183,744 (from the hard maximum of `maxResponseBytes`, not the current value) | 1,183,744 | the envelope raw bound |
| `identity_json` / `cost_estimate_json` input | `(A + 1,024) + 2,048 + 128 + 2 × maxRequestBytes + 1,024` | 2,166,912 | 4 MiB |
| Step event | `2 × maxRequestBytes + (A + 1,024) + 2,048 + max(raw bound, lookup bound) + 4,096` | 6,891,008 at the defaults' construction-time maximum | `max_statements` × 1 MiB + 64 KiB |
| Volatile state | `262,144 + 2 × maxRequestBytes + 2 × maxResponseBytes` (it holds the body text and validated public results, never raw results) | 2,618,368 | 256 KiB + 4 × event |

The raw result bound:

- `eᵢ` is statement i's emitted column count (projections plus visibility companions plus the
  check column), `nᵢ` its longest emitted column alias and `tᵢ` its longest declared type in
  bytes (both doubled for JSON escaping), 512 the per-statement Hrana framing, and 32 the
  per-column `cols` framing. `C` is the number of cells, at most
  `min(Σᵢ rowsᵢ × eᵢ, maxJsonValues)` with `rowsᵢ` the statement's effective row limit, and
  64 bytes is the largest per-cell Hrana framing (`{"type":"integer","value":"-9223372036854775808"},`
  is 49). The factor 2 on `maxResultBytes` covers escaping of a JSON-typed value inside a
  text cell (every `"` and `\` doubles). This replaces a single expansion factor: measured
  raw/public reaches 7.8 and, with one-character names and a check column, about 12, which
  the per-cell term covers exactly, while text-heavy results are covered by the factor 2.
- It is cumulative and checked before parsing: the engine hands the transport the remaining
  raw budget as its read cap, and core checks each statement's raw length against what
  remains before it parses a byte. Core then validates row by row and stops at the first row
  that crosses `maxResultBytes` or `maxJsonValues`, so validation work is bounded by the
  configured limits, not by the raw bound (finding 4).
- For the CPU and memory formulas, its construction-time maximum is
  `2 × maxResultBytes + 64 × maxJsonValues + maxStatements × (512 + (2 × maxProjections + 1) × (2·N + 2·T + 32))`
  with `N`, `T` the longest alias and declared type in the Catalog (at the defaults with
  `N` = 64, `T` = 16: 128,000 + 4,194,304 + 398,848 = 4,721,152 bytes). Typical statements
  compile to far smaller bounds.
- Pull request 6 adds a property test that generates results exactly at `maxResultBytes` and
  `maxJsonValues` for a Catalog with conditional projections, RETURNING with a check column,
  JSON-typed and BLOB columns, and maximal names, encodes them with the Hrana encoder, and
  asserts they fit the compiled bound. A failure changes a term, not the rule.

Exceeding a derived bound is reported as the configured limit it derives from:
request-derived bounds as 413 `POLICYSQL_REQUEST_TOO_LARGE`, result-derived bounds as 413
`POLICYSQL_LIMIT_EXCEEDED` with rollback. The 400 for an oversized auth + request input
(finding 6) disappears.

### Idempotent replay

The idempotency lookup (`crates/policysql-transaction/src/machine/step/atomic.rs`) returns the
stored `response_json` as a TEXT cell. Its read cap is the lookup bound above, derived from the
hard maximum of `maxResponseBytes` rather than from the current configuration, and it is
separate from the envelope's raw budget. So a keyed retry of a committed request returns the
stored response unchanged even after the deployment lowered `maxResponseBytes` or
`maxResultBytes` (it fitted when it was committed), and ADR 0007's retry contract holds
without exception. Its CPU and memory are counted in the formulas below.

### Streamed enforcement

No component buffers past a limit it knows (relates to #53):

- **HTTP request body:** already streamed (`readBodyText`); it reads the limit from the
  engine's runtime limits instead of `MAX_BODY_BYTES` and cancels the stream at the first
  chunk that crosses it. A declared `Content-Length` over the limit is rejected unread.
- **JSON values:** counted by the body scan that already walks every value, aborting before
  `JSON.parse` (and before WASM) at the first value over `maxJsonValues`.
- **Turso HTTP response:** read as a byte stream, counting bytes received, cancelled at the
  first chunk over the cap (the remaining raw budget for a statement, the lookup bound for the
  idempotency lookup, 65,536 for a control request). A declared `Content-Length` over the cap
  is rejected unread; an understated one changes nothing.
- **Durable Objects wire, validator responses:** bounded the same way by the response and
  validator bounds above.
- **Database drivers that buffer internally** (for example `@tursodatabase/serverless`)
  cannot honour a read cap. This becomes a declared capability of the `DatabaseProvider` port
  (`streamedReadCap: boolean`). Such an adapter applies the raw bound only after the driver
  returns; the engine logs `database_read_cap_unenforced` once per provider when
  `maxResultBytes` exceeds the default (64,000), so the operator sees the gap.

### Final response

`maxResponseBytes` bounds what leaves PolicySQL, not only the rows:

- **Atomic execute:** core already builds the response before COMMIT (it is the
  `response_json` written to `policysql_idempotency` in the same transaction). Core measures
  it, plus the 1,024-byte reserve, before emitting `Commit`; over the limit, the envelope
  rolls back with 413 `POLICYSQL_LIMIT_EXCEEDED`, so no mutation and no idempotency record
  survives. Replay is described above.
- **Interactive statement, callback query:** the statement reply is measured the same way
  before it is sent; over the limit, the statement fails as a result limit does today, and
  the transaction's existing rule for a failed statement applies. Interactive results remain
  under the cumulative `maxTransactionResultBytes` (≤ 64 KiB) as well.
- **Explain, Catalog, Capabilities:** their size is a function of the Catalog and policy,
  validated at construction (configuration input ≤ 1 MiB), and is not limited per request.

### CPU and memory budgets

The CPU of a single Worker or Durable Object invocation is modelled as

```
cpu_ms ≥ S × F × (C0 + a_b × (R + B) + a_v × (V_req + V_res))
```

- `R` = `maxRequestBytes` / MiB; `B` = max(2 × `maxResultBytes`, lookup bound) / MiB, the
  result bytes that are parsed as text; `V_req` = `V_res` = `maxJsonValues` (result cells
  count as values, so the cell framing of a cell-heavy raw result is inside `a_v`).
- Coefficients on the reference machine, worst measured shape per term, current code:
  `C0` = 5 ms, `a_b` = 80 ms per MiB (byte-bound shapes: 22–55 ms per request MiB, 42–78 ms per
  raw result MiB), `a_v` = 1.3 µs per value (request 0.4–0.9 µs, result 1.0–1.3 µs).
- `F` = Workers CPU time / reference machine time, `S` = 1.25 safety margin (isolates
  tolerate occasional overruns; sustained ones are terminated).

With the defaults (`R` = 1, `B` = 1.13, `V` = 65,536 each): `5 + 80 × 2.13 + 1.3 µs × 131,072`
≈ 345 ms on the reference machine; with `F` = 2.0 and `S` = 1.25, **about 860 ms**. The
model is conservative against every measurement: it predicts 85 ms for the 1 MB string
(measured 22), 158 ms for 1 MB of 17-digit decimals (66), 53 ms for the 100 × 64 conditional
result (18.9), and, at the default value limit, 118 ms for the densest body shape (about
59 ms measured).

The WASM memory peak is modelled as the larger of two phases, with the same inputs:

```
request phase ≈ 12 MiB × R + 170 B × V_req      result phase ≈ 12 MiB × B + 170 B × V_res
```

(measured: 8.3 MiB for 1 MB of string and 69.5 MiB for 499,913 values of nested arrays on the
request path; 11.1 MiB and 59 MiB on the result path; 4.1 MiB for 25,800 cells of
cell-framed raw result.) At the defaults: about 23 MiB and 24 MiB. At the hard maxima: about
45 MiB and 35 MiB, which is why the maxima above are lower than this ADR first proposed (4 MiB request,
4 MiB result).

Decisions:

- **The library does not refuse a combination at construction because of CPU or memory.**
  The CPU limit, the platform, and the hardware factor are deployment knowledge (ADR 0019);
  a refusal based on a guessed `F` would be wrong in both directions. Memory is bounded by the
  hard maxima, which are library decisions. Construction refuses only structural
  inconsistencies: `maxResponseBytes` < `maxResultBytes`, `maxSqlBytes` > `maxRequestBytes`,
  the emitted-height check, and the existing durable-state check.
- **The formulas and coefficients are documented** in `docs/configuration.md`, with the
  measurement script that produces them (`deploy/cloudflare/scripts/measure-cpu.mjs`, pull
  request 1) so a wrapper can re-measure on its own shapes. A wrapper raising a limit raises
  `cpu_ms` by the formula; one that cannot (Workers Free, 10 ms) lowers the limits instead.
- **The reference wrapper stays consistent by test.** `deploy/cloudflare/wrapper` gets a test
  that reads `wrangler.jsonc` `limits.cpu_ms` and `RUNTIME_LIMITS` and fails when the CPU
  formula is violated. Its `cpu_ms` becomes **900** (from 50), provisional: pull request 1
  replaces `F` = 2.0 with the measured value and pull request 7 lowers the coefficients, and
  each recomputes `cpu_ms`. No library default is raised before `F` is measured. The runbook
  alert "p95 CPU above 40 ms" becomes "p95 CPU above 50% of `cpu_ms`".
- **Rate limiting remains the cost guard** (ADR 0018). The 50 ms cap was acting as one; it
  cannot, because it fails valid requests of the authenticated caller with an
  outcome-unknown 5xx (#56) instead of rejecting them up front with 413.

### Capabilities

`limits` in Capabilities is built only from `limits_json` and advertises exactly the enforced
values: `maxRows`, `maxResultBytes`, `maxResponseBytes`, `timeoutMs`, `maxStatements`,
`maxRequestBytes`, `maxJsonValues`, `maxSqlBytes`, `maxBytesPerValue`, `maxParameters`,
`maxExpressionDepth`, `maxProjections`, `maxJoins`. `PolicySqlRuntime.max_bytes_per_value` is
removed; the per-value limit is a `limits_json` field like the others, and every TypeScript
reader (driver value classification, the Turso transport's `maxBytesPerValue` option, the WASM
parameter codec) takes it from there. `BindingLimits` is constructed from the runtime limits,
so the binder enforces the advertised values; a test asserts every advertised limit by sending
a request at the value and one over it. Derived bounds and fixed internal constants are not
advertised. `spec/openapi.yaml` lists the new `limits` properties (additive; the schema
already allows additional properties).

### Error semantics, summarised

| Condition | Status, code | Transaction effect |
| --- | --- | --- |
| Body over `maxRequestBytes` (declared, streamed, or engine text) or over `maxJsonValues` | 413 `POLICYSQL_REQUEST_TOO_LARGE` | none started |
| SQL text over `maxSqlBytes` | 413 `POLICYSQL_REQUEST_TOO_LARGE`, `/statements/<i>/sql` | none started |
| Parameters, depth, projections, joins over their limit | 413 `POLICYSQL_LIMIT_EXCEEDED`, statement path | none started |
| Expression beyond the upstream height cap | 400 `POLICYSQL_INVALID_SQL` | none started |
| Bytes parameter malformed / over `maxBytesPerValue` | 400 `POLICYSQL_INVALID_PARAMETER` / 413 `POLICYSQL_LIMIT_EXCEEDED` | none started |
| Rows, result bytes, result values, raw result bound, BLOB cell over the limit, response over `maxResponseBytes` | 413 `POLICYSQL_LIMIT_EXCEEDED` | rolled back before COMMIT; no idempotency record |
| Interactive cumulative limits | 429 `POLICYSQL_TRANSACTION_LIMIT_EXCEEDED` (unchanged) | per ADR 0024 |
| Control response or validator response over its fixed bound | 503 `POLICYSQL_DATABASE_UNAVAILABLE`, or `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` for COMMIT; validator: commit denied | per ADR 0007/0024 |
| Session JSON over 65,536 | 500 `POLICYSQL_INTERNAL` (wrapper fault) | none started |
| Invalid or inconsistent limits | construction error naming the field, never a value | no request served |

413 means "this request or its result is too large under this deployment's limits and
retrying the same request will not help"; it is never used for a COMMIT outcome. Both 413
codes are definite rejections, so the client's `REJECTIONS` table
(`packages/client/protocol.js`) lists `[413, ["LIMIT_EXCEEDED", "REQUEST_TOO_LARGE"]]` for
every request kind, and the existing server test that compares the client table with the
status table (`website/api/errors.md`) covers the pair.

## Breaking changes (beta; no compatibility layer, ADR 0019)

1. `RuntimeLimits` gains `maxRequestBytes`, `maxJsonValues`, `maxSqlBytes`,
   `maxBytesPerValue`, `maxParameters`, `maxExpressionDepth`, `maxProjections`, `maxJoins`,
   `maxResponseBytes`. `maxStatements`, `maxRows`, and `maxResultBytes` gain hard maxima (64,
   100,000, 524,288); a configuration above them now fails at construction, as does one that
   violates the emitted-height check.
2. Bodies and results with more than 65,536 JSON values (default) are rejected with 413.
3. `MAX_BODY_BYTES` is no longer exported; the HTTP adapter and conformance suite read the
   limit from the engine.
4. SQL text over the limit changes from 400 `POLICYSQL_INVALID_REQUEST` to 413
   `POLICYSQL_REQUEST_TOO_LARGE` (the documented code).
5. **Client:** `@unacowa/policysql` client's `REJECTIONS` adds 413 `REQUEST_TOO_LARGE`, so
   oversized bodies and SQL become definite rejections (`PolicySqlRejectedError`) instead of
   `PolicySqlOutcomeUnknownError`. Applications that caught the latter for this case see the
   former.
6. Parser defaults accept more: 1,024 parameters, depth 38.
7. The raw result bound becomes cumulative and compiled per envelope (instead of 1 MiB per
   statement and 2 MiB per Turso response). Statements that were validated and then rejected
   for `maxResultBytes` are now rejected earlier, with the same code.
8. Database control responses are bounded at 65,536 bytes (were 2 MiB).
9. The session JSON bound becomes 65,536 bytes (was 1 MiB).
10. A response over `maxResponseBytes` is now 413 and rolls back.
11. `PolicySqlRuntime.max_bytes_per_value` is removed and the `limits_json` shape grows: WASM
    ABI 9. The snapshot changes, so open transactions and idempotency fingerprints from ABI 8
    do not match (as for every ABI change).
12. `DatabaseProvider` gains the `streamedReadCap` capability.
13. Reference wrapper: `cpu_ms` 50 → 900 (provisional), runbook alert threshold relative to
    `cpu_ms`.
14. Capabilities `limits` gains fields (additive).

## Implementation pull requests

Each is independently mergeable, keeps the suites green, and passes the real-environment
smoke (`deploy/cloudflare/scripts/provision-dev.mjs`) before merge.

1. **Measure, and make the reference wrapper consistent (#56, #42).** Add
   `scripts/measure-cpu.mjs` (the request, JSON-cell, and cell-heavy conditional/check-column
   shapes above, harness time excluded, WASM memory high-water). Add a smoke step that sends
   the worst shapes at the deployed limits and reads the invocations' CPU time from Workers
   observability, polling until the events are ingested (Workers Logs arrive with a delay) or
   capturing them with `wrangler tail` during the run; it records `F`. Set the reference
   `cpu_ms` from the formula, add the wrapper consistency test, update the runbook and
   `docs/configuration.md` (formulas, coefficients). No library behaviour change.
2. **Streamed Turso response (#53).** Byte-counted streaming read with cancel, the 65,536
   control-response bound; the statement cap stays 2 MiB until pull request 6. Regression
   fixtures from #53 (no length, understated length, chunked, exact and one over, invalid
   UTF-8).
3. **Request budget and ABI 9.** `maxRequestBytes`, `maxJsonValues` (body side),
   `maxSqlBytes` in `RuntimeLimits`; the HTTP adapter and engine read them; derived WASM input,
   event, and hash-input bounds; session bound 65,536; SQL over limit becomes 413; the client
   `REJECTIONS` change and its table test. The ABI change of this ADR happens here, once:
   `PolicySqlRuntime.max_bytes_per_value` is removed in this pull request (its readers switch
   to the `limits_json` field, still fixed at 262,144 until pull request 5), so no later pull
   request changes the host-visible ABI. Tests at each limit and one over, for ASCII,
   multi-byte UTF-8, a BOM, a body whose escaping doubles inside the event, and a value count
   exactly at and one over the limit with the abort before `JSON.parse`.
4. **Parser limits (#63).** `maxParameters`, `maxExpressionDepth`, `maxProjections`,
   `maxJoins` in `RuntimeLimits`; `BindingLimits` built from them; policy predicate depth `P`
   computed at activation; the emitted-height construction check; the emitted-parameter check;
   Capabilities from `limits_json`. It must contain the re-parse invariant test: a statement
   at maximum depth × maximum inner joins × the deepest policy predicate compiles, re-parses,
   and executes on SQLite, for plain, EXISTS, CTE, derived-table, and LEFT JOIN shapes; one
   level more is 413, never 400. Plus positive, negative, bypass, and differential tests for
   long OR chains, many parameters, and long SQL.
5. **Per-value bytes (#52).** `maxBytesPerValue` becomes configurable, threaded through
   `policysql-core` codecs, `policysql-sqlite`, `policysql-turso`, and the adapters (no ABI
   change: the field already exists in `limits_json` since pull request 3). Shared byte
   vectors at the limit and one over, empty, invalid base64, unpadded Hrana form.
6. **Result and response budget (#52).** Hard maxima for `maxStatements`/`maxRows`/
   `maxResultBytes`; `maxJsonValues` on the result side; `maxResponseBytes`; the compiled raw
   result bound passed to the transport as its read cap; the separate lookup bound; row-by-row
   abort; the response measured before COMMIT; the `streamedReadCap` port capability and its
   log; the Hrana-encoded property test. Rollback and replay tests: over the limit leaves no row
   and no idempotency record; a retry of a committed request returns the stored response,
   including after `maxResponseBytes` is lowered.
7. **CPU and memory reductions (#56).** Parse, count, and duplicate-check the body once, in
   core, without materializing a `serde_json` tree for JSON-typed parameters beyond what
   validation needs; read step output without a reviver when it holds no unsafe integer; stop
   restating results through volatile JSON more than once. Re-run pull request 1's
   measurement, update the coefficients, the maxima if memory allows, and the reference
   `cpu_ms`. Targets: `a_v` ≤ 0.5 µs, `a_b` ≤ 40 ms per MiB, memory ≤ 50 B per value.

Pull requests 1, 2, and 4 depend on nothing else here; 3 precedes 5 and 6 (they use the
`limits_json` fields and derived-bound plumbing it adds); 7 comes last so its measurements
cover the final paths.

## Consequences

- Every byte bound has one home and one kind; a wrapper raising a limit cannot meet a
  smaller hidden one, and Capabilities states the whole contract a client needs.
- CPU and memory become documented functions of the limits, and the value count makes them
  predictable regardless of the body's shape.
- Validation work becomes proportional to the configured result limits (finding 4).
- The reference deployment's CPU cap rises substantially until pull requests 1 and 7 land.
- Costs: an ABI bump; ten more configuration fields; a measurement step in the smoke run; a
  new client-visible rejection.

## Rejected alternatives

- **Keep `cpu_ms` at 50 and lower the limits to fit.** With `F` = 2.0 and `S` = 1.25 that
  leaves 20 ms of reference CPU, about 11,000 JSON values in request and result together and
  almost no bytes; it would break the 256 KiB per-value contract and ordinary bulk inserts.
- **Bound only bytes.** The measurements show a tenfold spread in CPU and eightfold in memory
  per byte between shapes; any byte limit is either too low for strings and BLOBs or too high
  for dense JSON.
- **Let the library refuse limits that exceed a declared CPU budget.** The coefficients
  depend on hardware and shapes; the library would either refuse valid deployments or give
  false assurance. A wrapper test with its own measured `F` is the same check in the right
  layer.
- **Separate configurable knobs for each internal hop** (WASM input, raw result, Turso
  response). They are memory guards whose only correct values follow from the configured
  limits; exposing them invites exactly the hidden-bound configurations of #52.
- **A single raw-result expansion factor.** It is either too small for cell-heavy results
  with companion columns or far too large for text-heavy ones; the per-cell and per-column
  terms are exact.
- **Bound the final response only by `maxResultBytes`.** Column descriptors, redactions,
  warnings, and meta are outside it; #52 asks for a bound on what actually leaves.

## Open questions for the maintainer

Each has a proposed answer from the review of this ADR, pending maintainer confirmation.

1. **Reference wrapper trade-off.** Keep `maxRequestBytes` at 1 MiB with a provisional
   `cpu_ms`, or lower it? *Proposed:* keep 1 MiB; `cpu_ms` 900 provisional (the first draft
   said 700, before the value term and the replay bound were added), finalized after pull
   request 1 measures `F` and pull request 7 lowers the coefficients.
2. **`F` before measurement.** *Proposed:* 2.0 as a placeholder; no library default is raised
   until `F` is measured.
3. **Interactive result size.** *Proposed:* keep interactive results ≤ 64 KiB (the durable
   record stores the last reply); larger results use atomic execute.
4. **Upstream depth error.** *Proposed:* keep 400 `POLICYSQL_INVALID_SQL` beyond
   `turso_parser`'s cap, and guarantee by a differential test that a client within the
   advertised depth never reaches it.
5. **Hard maxima.** *Proposed by the review:* request 4 MiB, result about 1 MiB, per value
   3 MiB, parameters 16,384, depth and joins derived from the emitter. *This revision:* the
   memory measurements (69.5 MiB of WASM for 1 MiB of dense JSON) lower them to request
   2 MiB, result 512 KiB, per value 1.5 MiB, with `maxJsonValues` ≤ 131,072; parameters 16,384
   and the emitter-derived depth and joins as proposed. To be confirmed, or raised after pull
   request 7.
6. **Buffering drivers.** *Proposed:* accepted as a declared port capability
   (`streamedReadCap: false`) with a one-time log when `maxResultBytes` exceeds the default.
7. **Raw expansion.** *Proposed by the review:* a factor of at least 11 plus metadata slack.
   *This revision:* the compiled per-cell and per-column formula above, which covers the
   measured 7.8 and the computed 12 exactly and is confirmed by the Hrana-encoded property
   test. To be confirmed.
