# ADR 0025: Core-defined canonical JSON, without byte equality with TypeScript

- Status: accepted
- Issues: #35
- Amends: [ADR 0024](0024-transaction-step-machine.md) ("Where byte-equal hashing is
  load-bearing", "ABI 5", migration pull requests 2, 4, and 9)
- Related: [ADR 0005](0005-jwt-and-trusted-session-contract.md),
  [ADR 0007](0007-transaction-retry-and-commit-check-protocol.md),
  [ADR 0014](0014-wrapper-provided-database-bindings.md),
  [ADR 0019](0019-library-layers-and-the-wrapper-boundary.md)

## Context

ADR 0024 moved canonical JSON, SHA-256, idempotency identities, fingerprints, and command
digests into core. It required core's output to equal the TypeScript `stableJson` + `sha256`
byte for byte, and pull request 2 (#55) added a dual-hash gate that computes both and fails
with `POLICYSQL_INTERNAL` on a mismatch until pull request 9 deletes the TypeScript side.

Byte equality forced `crates/policysql-transaction/src/canonical.rs` (984 lines) to reproduce
JavaScript exactly: its own JSON tokenizer, object keys ordered by UTF-16 code units, string
escaping identical to `JSON.stringify`, and the ECMAScript `Number::toString` algorithm,
including a ties-to-even correction that Rust's formatter does not apply. Three review rounds
on #55 found a quadratic duplicate-key check and CPU costs above the 50 ms Durable Object limit;
the remaining cost (23–26 ms per ~1 MB body during the transition) exists only because both
implementations run on every request.

A hash value matters only when it is compared with a value stored earlier. Today's
computations (`crates/policysql-transaction/src/identity.rs`, `deploy/cloudflare/src/idempotency.ts`,
`engine.ts` begin, `transaction-owner.ts`), where `stable` is `stableJson` and
`identity = stable({principal, subject, role, session, endpoint, database: {scope, databaseId}})`:

| Value | Stored in | Computed as |
| --- | --- | --- |
| `keyHash` | `policysql_idempotency.key_hash` (application database); its first 32 hex digits are the keyed transaction id | `sha256(identity + ":" + key)` |
| request fingerprint | `policysql_idempotency.fingerprint` | `sha256(identity + ":" + stable(body) + ":" + stable(databaseBinding))` |
| auth fingerprint | owner record (Durable Object storage) | `sha256(stable({principal, subject, role, session, databaseBinding}))` |
| start fingerprint, unkeyed begin | owner record | `sha256(stable({transactionId, request: body}))`: the begin body, no identity, no binding |
| start fingerprint, keyed begin | owner record | the request fingerprint (endpoint `interactive-start`) |
| command digest (`last.digest`), `commitSent.digest` | owner record | `sha256(stable({kind, command}))`: the statement command, or `{sequence}` for commit and rollback |
| callback digest | owner record (callback session) | `sha256(stable(command))` |

The inputs are not only strings. `databaseBinding.version` is the number `1` (ADR 0014), and
it is part of the request and auth fingerprints. `sequence` is an integer. `principal`,
`subject`, and session values are arbitrary non-empty strings (`crates/policysql-wasm/src/session.rs`
checks only that `principal` and `subject` are non-empty), so they may contain non-ASCII
characters and characters `JSON.stringify` escapes. The object keys of every identity input
are ASCII: fixed names, session keys matching `^[a-z][a-z0-9_]*$` (ADR 0005), and the begin
body, which the engine restricts to `mode` and `expected` (`schemaVersion`, `policyVersion`)
before hashing.

The request and auth fingerprints include the database binding, and the binding includes the
runtime snapshot, which includes the ABI version (ADR 0014). Every deployment that changes the
snapshot therefore already makes earlier fingerprints unmatchable; a keyed retry straddling it
gets `POLICYSQL_IDEMPOTENCY_CONFLICT` today. `keyHash` and the command digests do not include
the snapshot. Owner records live for one transaction (seconds). PolicySQL is in beta, and
backward compatibility of stored values is not a goal (ADR 0019).

## Decision

### Canonical form is defined by core

Core's canonical JSON is the only definition. It does not have to equal what any TypeScript
function produces for every input. It must be deterministic, reject duplicate keys, be
documented (the rules below, in the module documentation of `canonical.rs`), and meet the
stability requirements in the next section.

- Parse the text with a standard parser that rejects duplicate keys (for example `serde_json`
  with a duplicate-rejecting visitor). Do not keep a hand-written tokenizer only to mirror
  JavaScript.
- Output has no insignificant whitespace; arrays keep their order; `true`, `false`, and `null`
  are printed as such.
- Numbers, strings, and object keys follow requirements (b), (c), and (d) below.
- Lone surrogates never reach hashing. Escaped lone surrogates (`"\ud800"` as six ASCII
  characters) are rejected when the engine parses the body, with the same
  `POLICYSQL_INVALID_REQUEST` the engine already returns for raw lone surrogates
  (`request-body.ts`), so the two forms of the same invalid text behave the same. Core's
  canonicalization also rejects them (fails closed with `POLICYSQL_INTERNAL`), as a standard
  parser does.
- Every body that compiles is accepted by canonicalization. Its limits are at least the
  engine's (nesting deeper than 64 levels and bodies over 1 MiB are rejected before compile),
  and its number range is compile's: a number outside the finite IEEE double range (for
  example `1e400`) is rejected, as `serde_json` rejects it in compile ("number out of range")
  with `POLICYSQL_INVALID_REQUEST`. Hashing never runs before the compile (execute, statement,
  callback) or validation (begin, whose body has no numbers) that would reject such a body,
  as today.

### Stability requirements

These requirements keep `keyHash`, the auth fingerprint, the start fingerprint, and the commit
and rollback `{sequence}` digests byte-identical to today's values for every input that reaches
them. They are requirements, not examples, and the follow-up pull request must meet them.

- **(a) Hash construction is unchanged.** The fields, their nesting, and the composition in the
  table above stay exactly as they are: the identity object and its members (`role`, not `roles`
  or `access`; `database` with `scope` and `databaseId` only), `identity + ":" + key`,
  `identity + ":" + body + ":" + binding`, `{principal, subject, role, session, databaseBinding}`,
  `{transactionId, request: body}`, `{kind, command}`, and the bare callback command. Hashes
  remain lowercase hexadecimal SHA-256 of the UTF-8 bytes of the text.
- **(b) Integers are printed as today.** A number whose value is an integer of magnitude at
  most 2^53 − 1 is printed as its decimal digits with an optional leading `-`, without a
  fraction or an exponent, whatever its spelling in the input: `1`, `1.0`, `1e0`, and `10E-1`
  print `1`, and `-0` prints `0`. This is what `JSON.stringify` prints after `JSON.parse`
  today. A printer that keeps every number as a double does not meet this on its own
  (`ryu` and `serde_json`'s `f64` printing give `1.0`), so the follow-up must special-case
  integers. Every other number (non-integers, and integers beyond 2^53 − 1) is printed by
  one fixed, round-tripping rule chosen and documented by core, for example the shortest
  representation that reads back as the same double; it may differ from today's
  `Number::toString` (`1e+21`, `1e-7`). The ECMAScript `Number::toString` reproduction and
  its ties-to-even correction are removed.
- **(c) Strings are escaped as `JSON.stringify` escapes them.** `"` is `\"`, `\` is `\\`,
  U+0008, U+0009, U+000A, U+000C, and U+000D are `\b`, `\t`, `\n`, `\f`, and `\r`, and every
  other character below U+0020 is `\u00xx` with lowercase hexadecimal digits. Every other
  character, `/`, U+007F, U+2028, U+2029, and all non-ASCII characters included, is emitted
  raw, as its UTF-8 bytes. No ASCII-only (`\uXXXX`) output.
- **(d) Object keys are ordered by their UTF-8 bytes** (equivalently, by Unicode code
  points). Today's order is by UTF-16 code units (`Array.prototype.sort`). The two orders are
  equal for ASCII keys, and for any two keys except where, at the first position they
  differ, one has a character at or above U+10000 and the other a character in
  U+E000–U+FFFF. Identity inputs have only ASCII keys (see Context), so their order is
  unchanged. Non-ASCII keys reach hashing only inside request bodies and statement and
  callback commands, whose values are covered by
  [What happens at the deployment that switches the rule](#what-happens-at-the-deployment-that-switches-the-rule).

### No version marker, no dual-hash gate

Stored values carry no format version. When the hashing rule changes, values written before
the change no longer match, except where the stability requirements hold. The dual-hash gate
(`deploy/cloudflare/src/identity.ts`) and the TypeScript identity computation in
`deploy/cloudflare/src/idempotency.ts` are removed; the engine and the owner use core's result
only.

The two helpers of `idempotency.ts` that are not identity computations stay in TypeScript (the
follow-up may move them out of `idempotency.ts` into a module named for them, but not into
core):

- `stableJson` in `database.ts` (`sameDatabaseBinding`) compares two validated bindings as
  values (version `1` and four ASCII strings of `[A-Za-z0-9_.:-]`). Nothing is hashed or
  stored, and the result is never compared with a value core computed.
- `sha256` in `commit-checks.ts` hashes the capability token. The hash is computed and
  compared inside TypeScript only, and its input is a random token, not canonical JSON. It
  moves to core with capability verification (ADR 0024 pull request 5), not with this ADR.
  (Pull request 5 hashes and verifies the machine's capabilities in core; the TypeScript
  copy serves `TransactionOwnerCore` until ADR 0024 pull request 9.)

### The switch bumps the ABI

The follow-up pull request bumps `ABI_VERSION` (4 to 5). Reasons:

- ADR 0024's rule: pull request 2 added `identity_json` without a bump because no existing
  method, value, or limit changed. The follow-up changes values that `identity_json` returns
  for some inputs, so by that rule it is an ABI change.
- Uniform, observable behavior: the snapshot changes (`…:abi-5`), so every request fingerprint
  changes at once, as on every snapshot-changing deployment. Without a bump, whether a keyed
  atomic retry straddling the deployment conflicts would depend on how the body spells its
  numbers (`1.5`, `1e21`) or orders non-ASCII keys, with no observable reason. With it, the
  deployment is one more snapshot change, visible in Capabilities (`abiVersion`, `snapshot`).
- The bump does not relax the stability requirements; see below.

ADR 0024's ABI numbering shifts by one: pull request 4 (`step_json`) bumps to 6.

### What happens at the deployment that switches the rule

- **`keyHash`** does not include the snapshot. By (a)–(d) it stays byte-identical, so a keyed
  atomic retry straddling the deployment finds its row (and then, because the fingerprint
  includes the new snapshot, gets `POLICYSQL_IDEMPOTENCY_CONFLICT`, as on every snapshot
  change today), and a keyed begin retry reaches the same owner (the transaction id is derived
  from `keyHash`). No committed keyed request executes twice.
- **Commit retries** (ADR 0007). A commit whose COMMIT may have been sent leaves a `committing`
  or `committed` record with `commitSent` (#48). A retry after the deployment carries the new
  snapshot, so `owned()` (`transaction-owner.ts`) takes `sameExceptSnapshot`: it recomputes the
  auth fingerprint of the stored `auth` under the stored binding with the new rule and requires
  it to equal the stored fingerprint, then recomputes it under the caller's binding. Then
  `commitRetry()` requires `commitSent.digest` to equal the new rule's digest of `{sequence}`.
  By (a)–(d) both hold, and the retry gets its recorded reply or
  `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`. If either value changed, the retry would get 409
  `POLICYSQL_TRANSACTION_UNAVAILABLE` from `prepareCommand`, a definite rejection after COMMIT
  that ADR 0007 forbids. This is why the requirements are needed with the bump as well.
- **Request fingerprints** change with the snapshot, as on every snapshot change.
- **Statement, rollback, and callback digests, and start fingerprints** are not compared across
  the deployment: a statement or rollback retry with a changed snapshot is unavailable in
  `owned()`, a keyed begin retry with a changed snapshot already conflicts in
  `startTransaction`, an unkeyed begin has a fresh transaction id, and callback sessions do not
  survive an owner restart. No commit outcome is misreported. The start fingerprint and the
  rollback digest are byte-identical anyway by (a)–(d).

### Escaped lone surrogates

Rejecting escaped lone surrogates in the engine's body parser changes no request that succeeds
today. Every body that reaches core passes compile's `serde_json::from_str`
(`crates/policysql-wasm/src/lib.rs`), which already rejects `"\ud800"` and `"\udc00"`, and
the engine answers that with `POLICYSQL_INVALID_REQUEST`. The observable differences:

- An interactive statement containing one no longer fails the open transaction. Today the
  owner's compile error closes it as `failed`; afterwards the engine answers 400
  `POLICYSQL_INVALID_REQUEST` before forwarding, and the transaction stays open.
- A begin whose `expected` values contain one gets `POLICYSQL_INVALID_REQUEST` instead of
  `POLICYSQL_STALE_OPERATION`.
- The error message of other rejected bodies may change; their code does not.

## Consequences for ADR 0024

- The "Where byte-equal hashing is load-bearing" paragraph and the pull request 2 corpus,
  randomized differential, and "Risk and gate" items are superseded by this ADR.
- The "ABI 5" item: the follow-up below is the first bump (to 5); pull request 4 bumps to 6.
- Pull request 9 no longer deletes a TypeScript side of the identity gate or the identity
  computation in `idempotency.ts`; the follow-up pull request below removes them.
- Everything else in ADR 0024 stands.

## Follow-up

One pull request, before ADR 0024 pull request 4:

1. **Goldens first.** Before changing any implementation, capture golden values from today's
   implementation (`identity_json` on main, which the gate checks against `stableJson` +
   `sha256`) and commit them as fixtures. They cover at least:
   - `keyHash` and auth fingerprints with non-ASCII `principal`, `subject`, and session values
     (accented Latin, CJK, a character above U+FFFF, and characters with escapes: `"`, `\`,
     U+0000, U+001F, U+007F, U+2028), with several session keys;
   - auth fingerprints with the binding's `version: 1`;
   - unkeyed start fingerprints with and without `expected`;
   - commit and rollback `{sequence}` digests for sequences `0`, `1`, `2`, and 2^53 − 1.

   The rest of the pull request must keep these goldens passing unchanged. A golden that would
   change is a breaking change this ADR does not allow. Request fingerprints are not among
   them: they change with the snapshot, and the new rule may legitimately change them for
   bodies with non-integer numbers, integers beyond 2^53 − 1, or non-ASCII keys. A
   request-fingerprint golden is allowed only for a body inside the stability set (integers of
   magnitude at most 2^53 − 1, ASCII keys) computed under the same snapshot, as a check of
   (a)–(d), not as a value kept across the bump.
2. Replace `canonical.rs` with a standard-parser-based canonical form as above; keep the
   duplicate-key rejection and the performance tests (wide objects, number-heavy bodies); add
   tests for (b) (`1.0`, `1e0`, `-0`, 2^53 − 1), (c), (d), and the number range (`1e400`).
3. Remove `identity.ts` and the identity computation in `idempotency.ts`; keep only key syntax
   validation where the engine needs it before calling core, or move it into core. Keep
   `stableJson` and `sha256` for `database.ts` and `commit-checks.ts` as stated above.
4. Reject escaped lone surrogates in the engine's body parser. Test the escaped form
   (`'{"a":"\\ud800"}'` and `'{"a":"\\udc00"}'` as JavaScript source, that is, six ASCII
   characters) alongside the raw form that `http.test.mjs` and `in-process-example.test.mjs`
   test today, including the two observable differences above.
5. Bump `ABI_VERSION` to 5.
6. Replace the byte-equality differential tests with tests that pin core's canonical form,
   determinism, and duplicate-key rejection.
7. Update ADR 0024's references to this ADR.

## Implementation notes

Recorded by the follow-up pull request (ABI 5):

- `canonical.rs` parses with `serde_json` (a visitor that sorts each object's members once and
  rejects neighbouring equal keys) with `float_roundtrip`: `serde_json`'s default reads
  `9007199254740991.0` as 2^53 − 2, which (b) does not allow. `policysql-wasm` enables the
  feature explicitly, so compile reads decimals as the same correctly rounded double; before,
  such a parameter could be one unit off. Nesting is bounded by `serde_json`'s recursion limit
  (127 levels).
  The client-facing note, including that a REAL value written by an older release may no
  longer match an equality predicate with the same literal, is in
  [`docs/http-api.md`](../http-api.md#numeric-parameters) and the website page on types and
  formats (`website/data-validity/types-and-formats.md`).
- Core's rule for numbers outside (b) is `serde_json`'s printing of the number it read: an
  integer lexeme in the 64-bit range keeps its exact digits (`9007199254740993`, which compile
  also keeps), and every other number is the shortest text that reads back as the same double
  (`1.5`, `1e+21`, `1e-7`).
- `deploy/cloudflare/src/identity.ts` and `idempotency.ts` are removed; `core-identity.ts`
  calls `identity_json`. `stableJson` now lives in `database.ts` and `sha256` in
  `commit-checks.ts`.
- Goldens: `tests/fixtures/identity-goldens.json`, asserted by core
  (`crates/policysql-transaction/tests/goldens.rs`) and by the deployed WASM
  (`identity-goldens.test.mjs`); `abi-bump-retry.test.mjs` retries owner records and
  idempotency rows written with the ABI 4 implementation.

## Rejected alternatives

- **Keep byte equality, using `ryu-js` and `serde_json` instead of a hand-written formatter.**
  Smaller than today, but still couples core to JavaScript's number printing and keeps the
  dual-hash gate and its CPU cost, for compatibility that snapshot changes already break.
- **Prefix stored values with a format version** and answer old-format mismatches with an
  outcome-unknown error. It protects only retries that straddle one deployment, which is not a
  goal in beta, and keyed identities and commit digests are already stable by the requirements
  above.
- **Switch without an ABI bump.** Fewer keyed atomic retries would conflict across the
  deployment, but which ones would depend on the spelling of numbers in the body, with no
  observable reason, and it breaks ADR 0024's rule that a changed value of an existing method
  is an ABI change. The commit-retry path needs the same stability requirements either way.
- **Hash the raw body bytes.** Changes the retry rule of ADR 0007 from "same canonical payload"
  to "same bytes" (whitespace and key order would matter to clients).
