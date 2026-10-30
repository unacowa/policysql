# ADR 0027: One model for byte, value, and CPU budgets

- Status: accepted (maintainer decisions of 2026-10-31, below)
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
| Turso HTTP response | 2,097,152 | `MAX_RESPONSE_BYTES`, `src/turso-http.ts`; streamed and counted in bytes, cancelled at the first chunk over it (#53, `src/bounded-body.ts`); the same cap for statement and control replies | TS constant |
| Validator (commit-check) response | none | `src/adapters/commit-check-hook.ts` reads it with `response.json()`, unbounded | — |
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
| 1,000 × 25, conditional, one-character aliases | 162,891 | 1,586,627 | 9.7 | 54 ms | 348 ms | 36 ms | 5.9 MiB |

At 250,000 and 64,000 bytes the request and JSON-cell costs scale linearly (nested arrays:
atomic 47 ms and 12.5 ms, SELECT 113 ms and 28.7 ms, WASM 18.3 and 15.7 MiB at 250,000; a small
request costs 2–3 ms). The streamed HTTP read itself is under 2 ms per MB. The earlier
figures in #56 and the PR #55 review agree in magnitude.

**Emitted expression height.** The emitter parenthesizes every binary node and every `NOT`,
`IS NULL`, and `LIKE` (`crates/policysql-sqlite/src/lib.rs`, `binary` → `parenthesized`),
`turso_parser` 0.7.2 counts a parenthesis as one level of height, the binder binds
`x IS NOT NULL` as `Not(IsNull(x))` and `x NOT LIKE y` as `Not(Like(x, y))` in **one** binder
level (`crates/policysql-parser/src/lib.rs`), and row filters compose as a left-deep `AND`
chain: `And(client, root filter)`, then one `And(previous, filter)` per inner join
(`crates/policysql-policy/src/lib.rs`). Each statement below was compiled by the committed
WASM (limits 32 / 8) at the largest repetition the binder accepts, and the height of its
emitted `WHERE` was measured by wrapping it in `(… AND (1 = 1))` (+2 each) until
`turso_parser` refused it:

| Client expression at the binder's depth limit (32) | emitted height, J = 0 | J = 2 |
| --- | --- | --- |
| OR chain, 32 terms | 67 | 71 |
| `\|\|` chain, 32 terms; `NOT` chain, 31 | 67 | 71 |
| `lower(…)` or `CAST(…)` nested 31 times | 36 | 40 |
| `CASE WHEN … = / IN / NOT IN / IS NULL … THEN col END`, 15 nestings | 50 | 54 |
| `CASE WHEN … IS NOT NULL / NOT LIKE / NOT GLOB … THEN col END`, 15 nestings | 82 | 86 |
| `CASE WHEN NOT … NOT LIKE … THEN col END`, 10 nestings | 79 | 83 |
| the `IS NOT NULL` nesting above as the deepest leaf of an `OR` | **84** | **88** |
| an `EXISTS` subquery holding that nesting | 32 (the subquery's own `WHERE` is a separate height) | — |

Background, not a contract: per binder level, the emitter adds 2 for a binary node, `NOT`,
`IS NULL`, `LIKE`, `IN`, a comparison, or a concatenation, 4 for `IS NOT NULL`, `NOT LIKE`,
`NOT GLOB` (two parenthesized nodes in one level), and 1 for `CASE`, `CAST`, or a function
call. With the binder's current closed node set, an operand of `IS NOT NULL` or `NOT LIKE` must
be a value, so the worst sustained rate is 2.5 per level (alternating 4 and 1); a future node
(for example `NOT BETWEEN` desugared to `Not(And(…))` in one level) would change it. Each
inner-join filter adds 2 (J = 0, 1, 2 measured; the development Catalog has no eight-join path,
so J = 8 is extrapolated). The review reproduced the table and found no shape above it across
UPDATE, DELETE, LEFT JOIN `ON`, HAVING, CTEs, projections, and companion columns.
`turso_parser` has two counters, both capped at 100: the tree height, which restarts inside a
subquery, and the parse recursion depth, which accumulates across `EXISTS` (the `EXISTS` row of
the table measures the remaining recursion budget). Today a re-parse failure reaches the client
as 400 `POLICYSQL_UNSUPPORTED_SQL`, and a database error such as `too many columns in result
set` as 503 `POLICYSQL_DATABASE_UNAVAILABLE`.

**Today's main:** at its limits (32 / 8) the worst measured statement emits height
84 + 16 = **100**, exactly the cap, which the parser still accepts. No within-limits statement
found exceeds it, but the margin is zero: a deeper policy predicate or an unmeasured shape would
turn a within-limits request into 400 `POLICYSQL_UNSUPPORTED_SQL`.

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
7. **The client's limits cannot promise that the emitted SQL fits.** The emitted statement's
   complexity depends on the policy (filters per join, companion columns) as well as on the
   client's SQL; today's defaults reach the parser's cap with no margin, and other downstream
   limits (SQLite's 2,000 result columns, 32,766 host parameters, 50,000-byte LIKE patterns)
   are reachable within the advertised limits.
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

   **One exception.** The column-metadata guard (1,048,576 bytes per envelope, below) is a
   memory guard measured on the compiled statements, and it can reject a request that is within
   every input-side limit (for example eight statements whose aliases fill `maxSqlBytes`). It
   then answers `POLICYSQL_SQL_TOO_COMPLEX` with cause `column_metadata`, like the other
   measured complexity limits, and is documented as such.

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
| `maxJsonValues` (new) | 65,536 | 1,024 – 131,072 | Request: JSON values plus object member names in one body. Result, separately: the values of the raw database response of one atomic envelope or interactive statement — every cell including visibility and check companion cells, every column descriptor in `cols`, and every value inside a JSON-typed cell — cumulatively; Capabilities documents that companions and descriptors count | engine body scan before `JSON.parse`, aborting at the limit (core in pull request 7); core while validating results | body: 413 `POLICYSQL_REQUEST_TOO_LARGE`; results: 413 `POLICYSQL_LIMIT_EXCEEDED` |
| `maxSqlBytes` (new; was fixed) | 65,536 | 1,024 – min(1,048,576, `maxRequestBytes`) | UTF-8 bytes of one statement's `sql` | core, before parsing | 413 `POLICYSQL_REQUEST_TOO_LARGE`, path `/statements/<i>/sql` (was 400) |
| `maxBytesPerValue` (new; was fixed) | 262,144 | 1 – 1,048,576 | decoded bytes of one bytes value (parameter, preset, result cell) | core codecs, the Turso adapters (from the runtime) | 413 `POLICYSQL_LIMIT_EXCEEDED` (malformed: 400 `POLICYSQL_INVALID_PARAMETER`) |
| `maxParameters` (new) | 1,024 | 1 – 16,384 | distinct client parameter names per statement | binder | 413 `POLICYSQL_LIMIT_EXCEEDED`, statement path |
| `maxExpressionDepth` (new) | 32 | 1 – 64 | binder expression depth of the client's SQL (an n-term `OR` chain has depth n); protects the binder's recursion, stack, and CPU | binder | 413 `POLICYSQL_LIMIT_EXCEEDED`, statement path |
| `maxJoins` (new; was fixed) | 8 | 1 – 63 | joins per FROM in the client's SQL | binder | 413 `POLICYSQL_LIMIT_EXCEEDED`, statement path |
| `maxProjections` (new) | 128 | 1 – 2,000 | result columns per SELECT/RETURNING in the client's SQL | binder | 413 `POLICYSQL_LIMIT_EXCEEDED`, statement path |
| `maxStatements` | required | 1 – 64 (was 2^32 − 1) | statements per atomic envelope | core | 413 `POLICYSQL_LIMIT_EXCEEDED` |
| `maxRows` | required | 1 – 100,000 (was 2^53 − 1) | rows per statement | core | 413 `POLICYSQL_LIMIT_EXCEEDED` |
| `maxResultBytes` | required | 1 – 524,288 (was 2^53 − 1) | public encoding of the rows (`JSON.stringify` of row objects, canonical numbers, base64 BLOBs), per statement and cumulatively per atomic envelope; counted while validating, aborting at the first row over the remaining budget | core | 413 `POLICYSQL_LIMIT_EXCEEDED` |
| `maxResponseBytes` (new) | `maxResultBytes` + 65,536 | `maxResultBytes` + 3,072 – 589,824 | UTF-8 bytes of the complete success response body, plus a fixed 1,024-byte reserve for fields added after commit (`requestId` ≤ 128 bytes, `meta`) | core, before COMMIT | 413 `POLICYSQL_LIMIT_EXCEEDED` |

Ranges and why:

- **Memory decides the maxima.** With the measured coefficients (finding 1), the WASM peak of
  one invocation is at most about `12 MiB × bytes (MiB) + 170 B × values` for whichever of
  the request phase and the result phase is larger (memory model below). The maxima keep both
  phases under 64 MiB, half the isolate, so the JavaScript heap has the other half: request
  phase `12 × 2 + 170 B × 131,072` ≈ 45 MiB; result phase `12 × 2.03` (`B` below: text,
  statement framing, and at most 1 MiB of column metadata) `+ 21` ≈ 46 MiB. Each maximum
  can rise when pull request 7 lowers the coefficients, by amending this ADR.
- `maxJsonValues` is the bound that makes cost predictable: CPU and memory per value are
  measured, and a dense body is rejected at the first value over the limit, before
  `JSON.parse` materializes it. Typical OLTP requests have hundreds of values; 65,536 admits a
  1,024-parameter bulk insert with large JSON parameters.
- `maxBytesPerValue` ≤ 1,048,576: its base64 form (1,398,104 bytes) fits the largest request
  with room for the envelope. It is an upper bound, and on every path **the smallest limit
  that applies governs**: a value can be written only if its base64 form and the rest of the
  body fit `maxRequestBytes` (at most about `¾ × maxRequestBytes`), and read only if its base64
  form and the row fit `maxResultBytes` (at most about `¾ × maxResultBytes`, 393,216 bytes at the
  hard maximum). No combination is rejected: a deployment may read BLOBs larger than any
  request it accepts (written by another system), and ADR 0016 already accepts a value too
  large to RETURNING. Capabilities advertises all of them, and `docs/configuration.md` gives the
  per-path formula.
- **Input-side limits, not a compile guarantee.** `maxExpressionDepth`, `maxJoins`,
  `maxProjections`, `maxParameters`, `maxSqlBytes`, `maxStatements`, and the byte and value
  limits bound what PolicySQL itself spends on the client's input. Capabilities advertises them
  as input-side limits: a request within them is parsed and bound, but whether its emitted
  statement fits downstream limits depends on the policy too, and is decided by measuring the
  actual emitted statement (next section), not predicted at construction. No construction
  check relates these limits to the parser's or SQLite's limits.
- **Defaults stay at today's values** for depth (32), joins (8), and projections (128). The
  measurements (Context) show that every shape found, including the worst at 8 joins, still
  fits the parser at these values, so common statements are unaffected; a deployment raising
  them accepts that more statements may end in `POLICYSQL_SQL_TOO_COMPLEX`. `maxParameters`
  rises to 1,024 (#63). The maxima are input-side bounds: depth 64 and joins 63 keep the binder
  cheap (client SQL deeper than about 98 is refused by `turso_parser` before binding anyway),
  projections 2,000 equals SQLite's column limit for the client's own columns, and parameters
  16,384 is half of SQLite's 32,766 host parameters. Joins stop at 63 because SQLite allows at
  most 64 tables in a join. The upper part of the join range is reachable only without row
  filters: each filtered inner join adds 2 to the emitted height (left-deep `AND`), so beyond
  about 45 filtered inner joins a statement returns `POLICYSQL_SQL_TOO_COMPLEX` however simple
  its predicate is; `docs/configuration.md` says so. Composing the filters as a balanced tree
  would lift this, but changes the emitter's golden output and is left for another ADR.
- `maxStatements` ≤ 64 bounds the per-statement framing of a raw response.
- `maxResponseBytes` ≥ `maxResultBytes` + 3,072 is checked at construction: the response adds
  the envelope (at least about 2 KiB for one statement with one column) and the 1,024-byte
  reserve to the rows, so a smaller value would make the configured result limit unreachable,
  which is the hidden-bound problem of #52. Statements with many columns or many statements
  need more; the default leaves 64 KiB.

The defaults raise `maxParameters` (128 → 1,024) and add
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
| Upstream expression height and parse recursion | 100 each (`turso_parser` 0.7.2) | dependency; client SQL beyond them is 400 `POLICYSQL_INVALID_SQL` before PolicySQL sees a tree; emitted SQL beyond them is `POLICYSQL_SQL_TOO_COMPLEX` (below) |
| Emitted statement limits of the database | SQLite defaults: 2,000 result columns, 32,766 host parameters, 50,000-byte LIKE/GLOB pattern, expression depth 1,000 | the database's; reaching one is `POLICYSQL_SQL_TOO_COMPLEX` (below) |
| Emitted column metadata per envelope | 1,048,576 bytes (exact Σ over emitted columns of `2·len(alias) + 2·len(declared type) + 32`) | memory guard on the raw response's column descriptors, measured on the compiled statements; over it is `POLICYSQL_SQL_TOO_COMPLEX` |

### Derived internal bounds

Each is the sum of its components' maxima plus framing stated separately (`MiB` =
1,048,576; `A` = 65,536, the session input; verified auth ≤ `A` + 1,024; binding ≤ 2,048;
key ≤ 128):

| Bound | Formula | Default value | Replaces |
| --- | --- | --- | --- |
| WASM compile input (verified auth + request) | `(A + 1,024) + maxRequestBytes + 1,024` | 1,116,160 | 1 MiB (finding 6) |
| Raw database result, per atomic envelope or interactive statement, computed at compile time | `2 × maxResultBytes + 64 × C + Σᵢ (512 + eᵢ × (2·nᵢ + 2·tᵢ + 32))`, with `C + Σᵢ eᵢ ≤ maxJsonValues` | see below | 1 MiB per statement (WASM), 2 MiB per response (Turso) |
| Idempotency lookup result | `2 × 589,824 + 4,096` = 1,183,744 (from the hard maximum of `maxResponseBytes`, not the current value) | 1,183,744 | the envelope raw bound |
| `identity_json` / `cost_estimate_json` input | `(A + 1,024) + 2,048 + 128 + 2 × maxRequestBytes + 1,024` | 2,166,912 | 4 MiB |
| Step event | `2 × maxRequestBytes + (A + 1,024) + 2,048 + max(raw bound, lookup bound) + 4,096` | 7,544,832 at the defaults' construction-time maximum | `max_statements` × 1 MiB + 64 KiB |
| Volatile state | `262,144 + 2 × maxRequestBytes + max(2 × maxResponseBytes, lookup bound)` (it holds the body text and either validated public results or a pending replay reply, `Task::AtomicReplay`; never raw results) | 3,543,040 | 256 KiB + 4 × event |

The raw result bound:

- `eᵢ` is statement i's emitted column count (projections plus visibility companions plus the
  check column), 512 the per-statement Hrana framing, and the column term is the exact sum over
  every emitted column c of the envelope,
  `M = Σ_c (2·|alias_c| + 2·|declared type_c| + 32)` (names doubled for JSON escaping, 32 the
  per-column `cols` framing). It is computed on the compiled statements and is at most
  1,048,576 bytes per envelope (the column-metadata guard; over it the envelope is
  `POLICYSQL_SQL_TOO_COMPLEX`, cause `column_metadata`); the count of column descriptors is
  under `maxJsonValues`. Client aliases appear in the SQL text, so their total is at most
  `maxSqlBytes` per statement, and names without an alias and declared types come from the
  Catalog and physical schema (bounded at construction). The guard is therefore at most
  `Σᵢ (2·maxSqlBytes + eᵢ·(2·T + 2·N + 32))` with `N`, `T` the longest Catalog name and declared
  type; at the defaults it is reached only when all eight statements fill their SQL with
  aliases, and at the hard maxima it is reachable, which the measured-limit policy accepts. No separate limit on emitted columns or name length is added. `C` is the number of cells, at most `min(Σᵢ rowsᵢ × eᵢ, maxJsonValues − Σᵢ eᵢ)`
  with `rowsᵢ` the statement's effective row limit, and 64 bytes is the largest per-cell Hrana
  framing (`{"type":"integer","value":"-9223372036854775808"},` is 49). The factor 2 on
  `maxResultBytes` covers escaping of a canonical JSON-typed value inside a text cell (every
  `"` and `\` doubles). This replaces a single expansion factor: measured raw/public reaches 7.9
  with two-character names and 9.7 with one-character names (all columns conditional), and
  about 12 with a check column, which the per-cell term covers exactly, while text-heavy
  results are covered by the factor 2.
- Result-side `maxJsonValues` counts the raw response's values (cells including companions,
  column descriptors, values inside JSON cells), so the value count that bounds the raw text
  is the same number the CPU and memory formulas use. Capabilities documents that companions
  and descriptors count, so it is not a hidden limit.
- **Values written by another system.** PolicySQL writes JSON-typed values in canonical form.
  A JSON column written by another system with indentation or `\u00XX` escapes can be several
  times larger raw than its canonical public form, and is then rejected by the raw bound with
  413 `POLICYSQL_LIMIT_EXCEEDED` even though its public form fits; this is the same exception
  ADR 0016 accepts for BLOBs written by other systems, and it is documented with them.
- It is cumulative and checked before parsing: the engine hands the transport the remaining
  raw budget as its read cap, and core checks each statement's raw length against what
  remains before it parses a byte. Core then validates row by row and stops at the first row
  that crosses `maxResultBytes` or `maxJsonValues`, so validation work is bounded by the
  configured limits, not by the raw bound (finding 4).
- Its construction-time maximum is
  `2 × maxResultBytes + 64 × maxJsonValues + 512 × maxStatements + 1,048,576`. At the defaults:
  128,000 + 4,194,304 + 4,096 + 1,048,576 = 5,374,976 bytes. Typical statements compile to far
  smaller bounds.
- Pull request 6 adds a property test that generates results exactly at `maxResultBytes` and
  `maxJsonValues` for a Catalog with conditional projections, RETURNING with a check column,
  JSON-typed and BLOB columns, one-character and long names, and many emitted columns,
  encodes them with the Hrana encoder, and asserts they fit the compiled bound. A
  failure changes a term, not the rule.

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
`maxResultBytes` (it fitted when it was committed). The pending replay reply
(`Task::AtomicReplay`) is held in volatile state, whose bound includes the lookup bound. Its CPU
and memory are counted in the formulas below.

Two consequences are stated rather than hidden:

- **Rows written under ABI 8.** Before this change `response_json` was effectively unbounded
  (`maxResultBytes` up to 2^53, Turso responses up to 2 MiB), so a stored row larger than
  1,183,744 bytes can exist. A keyed retry of it within the idempotency retention window W
  (ADR 0026, PR #79) after the upgrade finds the row (`keyHash` does not include the snapshot)
  and the lookup's read cap rejects it with 413 `POLICYSQL_LIMIT_EXCEEDED` before the
  fingerprint is compared. Nothing executes, so it is safe and never misreported as success,
  conflict, or replay, but it is the one exception to ADR 0007's replay contract, and it ends
  when W has passed. It is listed under Breaking changes.
- **Lowering the lookup bound later** (that is, lowering the hard maximum of
  `maxResponseBytes`) is a migration that must span W, for the same reason.

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
  `maxResultBytes` exceeds 64,000 (the reference wrapper's value; the field has no library
  default), so the operator sees the gap.

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

### Emitted statement complexity: measured, not predicted

The emitted statement contains the client's SQL composed with policy predicates, companion
columns, and server parameters. PolicySQL does not predict its complexity from the configured
limits. It compiles, emits, re-parses, and executes as usual, and when the **actual** emitted
statement hits a complexity limit downstream of the client's SQL, the request fails with one
fixed error:

- **Code** `POLICYSQL_SQL_TOO_COMPLEX`, HTTP **400**, path `/statements/<i>`, fixed message
  "The statement is too complex to run under the active policy." The message never contains
  the parser's or the database's text, because the emitted SQL contains policy predicates and
  hidden column names. The server log records `sql_too_complex` with the statement index and a
  fixed cause name (`height`, `recursion`, `columns`, `parameters`, `like_pattern`,
  `column_metadata`, `database_expression_depth`), never SQL text, parameters, or names.
- It is a definite rejection: every cause below is detected before COMMIT, so nothing is
  committed. The client's `REJECTIONS` lists it under 400, and the status table
  (`website/api/errors.md`) gains it; the existing table test covers the pair.

How each cause is recognized:

| Cause | Where | How |
| --- | --- | --- |
| Expression height over 100; parse recursion depth over 100 | core, at emit time, before re-parse | `turso_parser` 0.7.2 reports both as an untyped `ParseError(String)`, so core does not match its message. The emitter counts both quantities exactly on the AST it is about to print, with the parser's rules: height (a parenthesis +1, a binary node 1 + the taller operand, restarting inside a subquery) and recursion depth (accumulating across `EXISTS` and other subqueries). This measures the actual statement; it does not predict from limits. Because the counts copy a dependency's internal rules, pull request 4 tests them in **both directions** on generated shapes (count over 100 ⇔ the re-parse fails), and every pull request that changes the `turso_parser` version must run that test. (Classifying the re-parse failure by the pinned version's fixed message instead was considered; it was not chosen because the message is an untyped string that can change in any release, and it does not say which counter failed.) |
| Result columns over 2,000; host parameters over 32,766 | core, at emit time | exact count of the emitted result columns (companions and the check column included) and of the bound parameters (client and server) |
| LIKE/GLOB pattern over 50,000 bytes | core, when parameters are bound | exact byte length of a pattern that is a bound value (a parameter or a server value); a pattern computed by an expression is left to the database (next row) |
| Emitted column metadata over 1,048,576 bytes per envelope | core, at compile time | the exact per-column sum `M` over the compiled statements (raw bound above) |
| The database refuses the statement for complexity (for example `too many columns in result set`, `LIKE or GLOB pattern too complex`, `Expression tree is too large`, `too many SQL variables`) | the database adapter, on the statement's error; core decides | The adapter starts reading the Hrana error object of a statement request (today `decodeResult` in `turso-http.ts` discards it): `{"type":"error","error":{"message","code"}}`. A complexity match requires **`code` == `SQLITE_ERROR`** (which structurally excludes `SQLITE_BUSY`, `SQLITE_CONSTRAINT_*`, `SQLITE_FULL`, and the rest) **and** a message starting with one entry of a fixed allowlist derived mechanically from SQLite's `SQLITE_LIMIT_*` family for the pinned version: too many columns (`in result set`, `in ORDER BY clause`, `in GROUP BY clause`, `in set list`, `in index`, and the other "too many columns in …" forms), too many SQL variables, too many arguments on function, too many terms in compound SELECT, at most 64 tables in a join, LIKE or GLOB pattern too complex, Expression tree is too large. The message is read only to classify; it is never logged or returned. A match becomes a new outcome class (`complex`) on `ExecuteFailed`, which also carries the failed statement's index so core can answer `/statements/<i>`; core maps the class to `POLICYSQL_SQL_TOO_COMPLEX`. The class is never produced for COMMIT, and the COMMIT outcome mapping gains no entry for it, so a COMMIT is never classified this way. Anything else keeps today's classification (503) and is logged as `database_error_unclassified` with the Hrana `code` only. The smoke run sends one statement per allowlist entry to real Turso and **fails** if any is not matched, so a change on the server side cannot silently regress to 503. These errors arise when the statement is prepared or stepped, before COMMIT; the transaction effect is in the error table below (atomic: rollback; interactive: the transaction closes as `failed`). |

Any other re-parse failure of emitted SQL is an emitter bug: an internal invariant failure,
500 `POLICYSQL_INTERNAL`, logged as `emitted_sql_reparse_failed`, not this code. That log,
`sql_too_complex`, and `database_error_unclassified` carry only the statement index, the schema
and policy versions, the runtime ABI version, and a fixed cause name (or the Hrana `code`); never
the parser's or the database's text, the emitted SQL, parameters, or names, since the parser's
message can embed tokens of the emitted SQL and SQLite's constraint messages name columns. The
emitted SQL may be logged only under a development-only debug flag, never in a deployment. Client SQL
that the parser refuses remains 400 `POLICYSQL_INVALID_SQL`.

The input-side limits stay in place because they protect PolicySQL's own work, and they are
checked first, so a request over an input-side limit is still 413 `POLICYSQL_LIMIT_EXCEEDED`.

### CPU and memory budgets

The CPU of a single Worker or Durable Object invocation is modelled as

```
cpu_ms ≥ S × F × (C0 + a_b × (R + B) + a_v × (V_req + V_res))
```

- `R` = `maxRequestBytes` / MiB.
- `B` = the raw result bytes not attributable to values, / MiB: the larger of
  `2 × maxResultBytes + 512 × maxStatements + 1,048,576` (text content, statement framing, and
  the column metadata guard) and the lookup
  bound. This is the only definition of `B`; the raw bound's per-cell framing (64 × cells) is not
  in `B` because it is inside `a_v`.
- `V_req` = `V_res` = `maxJsonValues`; on the result side that is the raw value count (cells
  including companions, column descriptors, values inside JSON cells), the same number that
  bounds the raw text.
- Coefficients on the reference machine, worst measured shape per term, current code:
  `C0` = 5 ms, `a_b` = 80 ms per MiB (byte-bound shapes: 22–55 ms per request MiB, 14–17 ms per
  MiB of text result), `a_v` = 1.3 µs per value (request 0.4–0.9 µs; result 1.0–1.3 µs per value
  inside JSON cells, and 1.06–1.17 µs per raw value of the companion-heavy shapes after `C0`).
- `F` = Workers CPU time / reference machine time, `S` = 1.25 safety margin (isolates
  tolerate occasional overruns; sustained ones are terminated).

With the defaults (`R` = 1; `B` = max(128,000 + 4,096 + 1,048,576, 1,183,744) = 1.13 MiB;
`V` = 65,536 each): `5 + 80 × 2.13 + 1.3 µs × 131,072` ≈ 345 ms on the reference machine; with
`F` = 2.0 and `S` = 1.25, **about 860 ms**, which the reference wrapper rounds up to
1,000 ms. The model is conservative against every
measurement, using the same definitions: 85 ms predicted for the 1 MB string (measured 22),
158 ms for 1 MB of 17-digit decimals (66), 30 ms for the 100 × 64 conditional result
(`5 + 80 × 0.1 + 1.3 µs × 13,029` raw values; measured 18.9–20.3), 96 ms for the 1,000 × 25
one-character-alias conditional result (`5 + 80 × 0.31 + 1.3 µs × 51,051`; measured 54), and,
at the default value limit, 118 ms for the densest body shape (about 59 ms measured). At the
hard maxima (`R` = 2, `B` = 2.03, `V` = 131,072 each) it is about 668 ms on the reference
machine.

The WASM memory peak is modelled as the larger of two phases, with the same inputs:

```
request phase ≈ 12 MiB × R + 170 B × V_req      result phase ≈ 12 MiB × B + 170 B × V_res
```

(measured: 8.3 MiB for 1 MB of string and 69.5 MiB for 499,913 values of nested arrays on the
request path; 11.1 MiB and 59 MiB on the result path; 4.1 MiB for 25,929 and 5.9 MiB for 51,051
raw values of cell-framed results.) At the defaults: about 23 MiB and 24 MiB. At the hard
maxima (`B` = 2.03 MiB, including 1 MiB of column metadata): about 45 MiB and 46 MiB,
which is why the maxima above are lower than this ADR first proposed (4 MiB request, 4 MiB
result).

Decisions:

- **The library does not refuse a combination at construction because of CPU or memory.**
  The CPU limit, the platform, and the hardware factor are deployment knowledge (ADR 0019);
  a refusal based on a guessed `F` would be wrong in both directions. Memory is bounded by the
  hard maxima, which are library decisions. Construction refuses only structural
  inconsistencies: `maxResponseBytes` < `maxResultBytes` + 3,072, `maxSqlBytes` >
  `maxRequestBytes`, and the existing durable-state check. It makes no prediction about the
  complexity of emitted SQL.
- **The formulas and coefficients are documented** in `docs/configuration.md`, with the
  measurement script that produces them (`deploy/cloudflare/scripts/measure-cpu.mjs`, pull
  request 1) so a wrapper can re-measure on its own shapes. A wrapper raising a limit raises
  `cpu_ms` by the formula; one that cannot (Workers Free, 10 ms) lowers the limits instead.
- **The reference wrapper stays consistent by test.** `deploy/cloudflare/wrapper` gets a test
  that reads `wrangler.jsonc` `limits.cpu_ms` and `RUNTIME_LIMITS` and fails when the CPU
  formula is violated. Its `cpu_ms` becomes **1,000** (from 50), provisional: pull request 1
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
advertised. The depth, join, projection, parameter, and SQL-length limits are described as
input-side limits: a request within them can still be refused with `POLICYSQL_SQL_TOO_COMPLEX`
when the policy makes its emitted statement too complex or when the column metadata of its
emitted statements exceeds the 1 MiB guard, and result-side `maxJsonValues` is
described as counting companion cells and column descriptors. `spec/openapi.yaml` lists the new
`limits` properties (additive; the schema already allows additional properties).

### Error semantics, summarised

| Condition | Status, code | Transaction effect |
| --- | --- | --- |
| Body over `maxRequestBytes` (declared, streamed, or engine text) or over `maxJsonValues` | 413 `POLICYSQL_REQUEST_TOO_LARGE` | none started |
| SQL text over `maxSqlBytes` | 413 `POLICYSQL_REQUEST_TOO_LARGE`, `/statements/<i>/sql` | none started |
| Parameters, depth, projections, or joins of the client's SQL over their limit | 413 `POLICYSQL_LIMIT_EXCEEDED`, statement path | none started |
| Client SQL beyond the parser's caps | 400 `POLICYSQL_INVALID_SQL` | none started |
| The emitted statement exceeds a downstream complexity limit (parser height or recursion, result columns, host parameters, LIKE pattern, column metadata, or a recognized database complexity error) | 400 `POLICYSQL_SQL_TOO_COMPLEX`, statement path, fixed message | atomic: none started, or rolled back before COMMIT. Interactive: whether detected at emit time or by the database, the transaction closes as `failed` and is rolled back, like any compile or execute failure (ADR 0024); later statements and COMMIT get 409 `POLICYSQL_TRANSACTION_UNAVAILABLE` |
| Emitted SQL that fails to re-parse for any other reason | 500 `POLICYSQL_INTERNAL` | none started |
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
every request kind, `POLICYSQL_SQL_TOO_COMPLEX` is added under 400, and the existing server test
that compares the client table with the status table (`website/api/errors.md`) covers both.

## Breaking changes (beta; no compatibility layer, ADR 0019)

1. `RuntimeLimits` gains `maxRequestBytes`, `maxJsonValues`, `maxSqlBytes`,
   `maxBytesPerValue`, `maxParameters`, `maxExpressionDepth`, `maxProjections`, `maxJoins`,
   `maxResponseBytes`. `maxStatements`, `maxRows`, and `maxResultBytes` gain hard maxima (64,
   100,000, 524,288); a configuration above them now fails at construction, as does one that
   sets `maxResponseBytes` below `maxResultBytes` + 3,072.
2. Bodies and results with more than 65,536 JSON values (default) are rejected with 413.
3. `MAX_BODY_BYTES` is no longer exported; the HTTP adapter and conformance suite read the
   limit from the engine.
4. SQL text over the limit changes from 400 `POLICYSQL_INVALID_REQUEST` to 413
   `POLICYSQL_REQUEST_TOO_LARGE` (the documented code).
5. **Client:** `@unacowa/policysql` client's `REJECTIONS` adds 413 `REQUEST_TOO_LARGE`, so
   oversized bodies and SQL become definite rejections (`PolicySqlRejectedError`) instead of
   `PolicySqlOutcomeUnknownError`. Applications that caught the latter for this case see the
   former.
6. Parser defaults: 1,024 parameters (more accepted); depth 32, joins 8, and projections 128
   unchanged. These are advertised as input-side limits that no longer promise that every
   request within them compiles.
7. **New code `POLICYSQL_SQL_TOO_COMPLEX` (400).** An emitted statement over the parser's height
   or recursion cap, which today is 400 `POLICYSQL_UNSUPPORTED_SQL`, and a statement the database
   refuses for complexity (too many result columns or host parameters, LIKE pattern too long),
   which today is 503 `POLICYSQL_DATABASE_UNAVAILABLE`, now get this code. Any other re-parse
   failure of emitted SQL becomes 500 `POLICYSQL_INTERNAL` (was 400). The client's `REJECTIONS`
   lists the new code as a definite rejection.
8. The raw result bound becomes cumulative and compiled per envelope (instead of 1 MiB per
   statement and 2 MiB per Turso response). Statements that were validated and then rejected
   for `maxResultBytes` are now rejected earlier, with the same code.
9. Database control responses are bounded at 65,536 bytes (were 2 MiB).
10. The session JSON bound becomes 65,536 bytes (was 1 MiB).
11. A response over `maxResponseBytes` is now 413 and rolls back.
12. `PolicySqlRuntime.max_bytes_per_value` is removed and the `limits_json` shape grows: WASM
    the next ABI (11, unless another bump lands first; 9 was used by #80 and 10 by #65). The
    snapshot changes, so open transactions from the previous ABI do not match (as for every ABI
    change).
13. `DatabaseProvider` gains the `streamedReadCap` capability.
14. Reference wrapper: `cpu_ms` 50 → 1,000 (provisional), runbook alert threshold relative to
    `cpu_ms`.
15. Capabilities `limits` gains fields (additive).
16. **Idempotency rows written under ABI 8** whose `response_json` exceeds 1,183,744 bytes: a
    keyed retry within the retention window W after the upgrade gets 413
    `POLICYSQL_LIMIT_EXCEEDED` instead of a replay (nothing executes; see Idempotent replay).
17. JSON-typed values written by another system in non-canonical form can exceed the raw bound
    and be 413 even when their canonical public form fits (as for BLOBs, ADR 0016).

## Implementation pull requests

Each is independently mergeable, keeps the suites green, and passes the real-environment
smoke (`deploy/cloudflare/scripts/provision-dev.mjs`) before merge.

1. **Measure, and make the reference wrapper consistent (#56, #42).** Add
   `scripts/measure-cpu.mjs` (the request, JSON-cell, and cell-heavy shapes above, plus the
   companion-heavy shape — one-character aliases, every column `visible_if`, and RETURNING with
   the check column — to fix the per-raw-value coefficient; and SQL-dense shapes — depth 32,
   many projections, 8 joins with row filters, and statements at `maxSqlBytes` repeated
   `maxStatements` times — to decide whether `a_b` covers parse, bind, policy composition, emit,
   the height counts, and re-parse, or whether the CPU formula needs a separate term for SQL
   bytes; harness time excluded; WASM memory high-water). Add a smoke step that sends
   the worst shapes at the deployed limits and reads the invocations' CPU time from Workers
   observability, polling until the events are ingested (Workers Logs arrive with a delay) or
   capturing them with `wrangler tail` during the run; it records `F`. Set the reference
   `cpu_ms` to 1,000 and check it against the formula, add the wrapper consistency test, update the runbook and
   `docs/configuration.md` (formulas, coefficients). No library behaviour change.
2. **Streamed Turso response (#53, done in #86).** Byte-counted streaming read with cancel
   (`src/bounded-body.ts`, web streams only), with the existing 2 MiB cap for every reply and
   today's classification (statement 413, control 503, never a rejection of a COMMIT); the
   request timeout also bounds the body read. Regression fixtures from #53 (no length,
   understated length, chunked, exact and one over, invalid UTF-8, a stalled body). The
   statement cap stays 2 MiB until pull request 6. The 65,536 control-response bound is
   **not** in this pull request; it moves to pull request 3.
3. **Request budget and the ABI bump.** `maxRequestBytes`, `maxJsonValues` (body side),
   `maxSqlBytes` in `RuntimeLimits`; the HTTP adapter and engine read them; derived WASM input,
   event, and hash-input bounds; session bound 65,536; SQL over limit becomes 413; the client
   `REJECTIONS` change and its table test. The ABI change of this ADR happens here, once:
   `limits_json` gains **every** field this ADR adds (`maxBytesPerValue`, `maxParameters`,
   `maxExpressionDepth`, `maxProjections`, `maxJoins`, `maxResponseBytes`, and the result side
   of `maxJsonValues`), reported at today's fixed values and not yet configurable, and
   `PolicySqlRuntime.max_bytes_per_value` is removed (its readers switch to the field), so pull
   requests 4–6 only make existing fields configurable and change no host-visible ABI. Tests at each limit and one over, for ASCII,
   multi-byte UTF-8, a BOM, a body whose escaping doubles inside the event, and a value count
   exactly at and one over the limit with the abort before `JSON.parse`. The fixed 65,536
   reply bounds also land here, read with the streamed reader of pull request 2: the
   database control-response bound (BEGIN, COMMIT, ROLLBACK, close; over it 503, or
   `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` for an interactive COMMIT) and the validator response
   bound, which replaces the unbounded `response.json()` in
   `src/adapters/commit-check-hook.ts` (over it denies the commit as a failed validator).
   Tests at each bound and one over, and a COMMIT reply over it is never a rejection.
4. **Input-side parser limits and `POLICYSQL_SQL_TOO_COMPLEX` (#63).** `maxParameters`,
   `maxExpressionDepth`, `maxProjections`, `maxJoins` configurable in `RuntimeLimits`;
   `BindingLimits` built from them; Capabilities from `limits_json`, documented as input-side
   limits. The new code with its fixed message, its log event, and its mapping: the emitter's
   exact height and recursion counts, the emitted-column, host-parameter, LIKE-pattern, and
   column-metadata counts, and the database adapters' allowlist of complexity messages; other
   re-parse failures become `POLICYSQL_INTERNAL`. The code is added to the client's `REJECTIONS`
   and to `website/api/errors.md`. Tests for each mapped failure, including the shapes of the
   measurements (OR chains, `NOT` chains, alternating `CASE`/`IS NOT NULL` and `CASE`/`NOT LIKE`
   nestings, those nestings as the deepest OR leaf, EXISTS nestings that exhaust the recursion
   counter, many inner joins, wide conditional projections over 2,000 emitted columns, more than
   32,766 parameters, a 50,001-byte LIKE pattern), each run on SQLite and on Turso in the smoke,
   in atomic and interactive transactions (rollback before COMMIT), asserting that the response
   and the logs contain no SQL, parameter, policy, or column text. The two-way differential test
   on generated shapes (count over 100 ⇔ re-parse fails), required again on every
   `turso_parser` version change. The adapter's reading of the Hrana error object, the
   `complex` class with the statement index on `ExecuteFailed`, and the smoke check that every
   allowlist entry matches on real Turso.
5. **Per-value bytes (#52).** `maxBytesPerValue` becomes configurable, threaded through
   `policysql-core` codecs, `policysql-sqlite`, `policysql-turso`, and the adapters (no ABI
   change: the field exists in `limits_json` since pull request 3); the per-path documentation
   of which limit governs. Shared byte
   vectors at the limit and one over, empty, invalid base64, unpadded Hrana form.
6. **Result and response budget (#52).** Hard maxima for `maxStatements`/`maxRows`/
   `maxResultBytes`; `maxJsonValues` on the result side; `maxResponseBytes`; the compiled raw
   result bound passed to the transport as its read cap; the separate lookup bound; row-by-row
   abort; the response measured before COMMIT; the `streamedReadCap` port capability and its
   log; the Hrana-encoded property test. Rollback and replay tests: over the limit leaves no row
   and no idempotency record; a retry of a committed request returns the stored response,
   including after `maxResponseBytes` is lowered; an oversized ABI-8 row gives 413 before the
   fingerprint comparison.
7. **CPU and memory reductions (#56).** Parse, count, and duplicate-check the body once, in
   core, without materializing a `serde_json` tree for JSON-typed parameters beyond what
   validation needs; read step output without a reviver when it holds no unsafe integer; stop
   restating results through volatile JSON more than once. Re-run pull request 1's
   measurement, update the coefficients, the maxima if memory allows, and the reference
   `cpu_ms`. Targets: `a_v` ≤ 0.5 µs, `a_b` ≤ 40 ms per MiB, memory ≤ 50 B per value.

Pull requests 1 and 2 depend on nothing else here; 3 precedes 4, 5, and 6, which make the
fields it added configurable and are independent of one another; 7 comes last so its
measurements cover the final paths.

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
- **Predict emitted-SQL complexity at construction** (an earlier revision of this ADR: a
  per-node height table, a policy-height term, and a construction check relating depth and
  joins). It depends on the binder's closed node set and on the emitter's exact shape, every
  emitter change would have to update it, and it still needed an emit-time count as a backstop.
  Measuring the actual statement and returning one fixed error is simpler and exact.
- **A fixed limit on emitted columns per envelope.** Reachable within the advertised
  `maxStatements` × `maxProjections`, so a hidden limit; the raw value count under
  `maxJsonValues` and the column-metadata guard bound memory instead, and SQLite's column limit
  maps to `POLICYSQL_SQL_TOO_COMPLEX`.
- **A single raw-result expansion factor.** It is either too small for cell-heavy results
  with companion columns or far too large for text-heavy ones; the per-cell and per-column
  terms are exact.
- **Bound the final response only by `maxResultBytes`.** Column descriptors, redactions,
  warnings, and meta are outside it; #52 asks for a bound on what actually leaves.

## Maintainer decisions (2026-10-31)

The questions raised during review were decided as follows.

1. **Reference wrapper:** `maxRequestBytes` stays 1 MiB and `cpu_ms` is 1,000 ms. Both are
   revisited after pull request 1 measures `F` and pull request 7 lowers the coefficients.
2. **`F` = 2.0** is a placeholder until measured; no library default is raised before then.
3. **Hard maxima** as proposed: request 2 MiB, result 512 KiB, per value 1 MiB (the smallest
   limit on each path governs), `maxJsonValues` 131,072, parameters 16,384; input-side depth 64,
   joins 63, projections 2,000; defaults 32 / 8 / 128 unchanged.
4. **`POLICYSQL_SQL_TOO_COMPLEX`** as proposed: HTTP 400, fixed message, a definite rejection;
   database complexity errors are recognized by `SQLITE_ERROR` plus the `SQLITE_LIMIT_*`
   allowlist, unmatched errors stay 503, and the smoke run confirms every allowlist entry.
5. **Client SQL beyond the parser's caps** stays 400 `POLICYSQL_INVALID_SQL`.
6. **Interactive results** stay at most 64 KiB; larger results use atomic execute.
7. **Buffering drivers** are accepted as a declared port capability (`streamedReadCap`) with a
   one-time log when `maxResultBytes` exceeds 64,000.
8. **Raw results** are bounded by the per-cell and per-column formula, and result-side
   `maxJsonValues` counts raw values.
9. **Today's main** (emitted height exactly 100 at 32 / 8) gets no separate fix; pull request 4
   maps that case to `POLICYSQL_SQL_TOO_COMPLEX`.

No questions remain open.
