# ADR 0025: Core-defined canonical JSON, without byte equality with TypeScript

- Status: accepted
- Issues: #35
- Amends: [ADR 0024](0024-transaction-step-machine.md) ("Where byte-equal hashing is
  load-bearing", migration pull requests 2 and 9)
- Related: [ADR 0007](0007-transaction-retry-and-commit-check-protocol.md),
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

A hash value matters only when it is compared with a value stored earlier:

| Value | Stored in | Inputs |
| --- | --- | --- |
| `keyHash` | `policysql_idempotency.key_hash` (application database) | principal, subject, role, session, endpoint, database scope and id, the key |
| request fingerprint | `policysql_idempotency.fingerprint` | the same identity, the request body, the full database binding |
| auth fingerprint, start fingerprint | owner record (Durable Object storage) | identity and the full database binding |
| command digest, `commitSent.digest` | owner record | the command (statement body, or `{sequence}` for commit and rollback) |

The fingerprints include the database binding, and the binding includes the runtime snapshot,
which includes the ABI version (ADR 0014). Every deployment that changes the snapshot therefore
already makes earlier fingerprints unmatchable; a keyed retry straddling it gets
`POLICYSQL_IDEMPOTENCY_CONFLICT` today. Owner records live for one transaction (seconds).
PolicySQL is in beta, and backward compatibility of stored values is not a goal (ADR 0019).

## Decision

### Canonical form is defined by core

Core's canonical JSON is the only definition. It does not have to equal what any TypeScript
function produces. It must be deterministic, reject duplicate keys, and be documented:

- Parse the body text with a standard parser that rejects duplicate keys (for example
  `serde_json` with a duplicate-rejecting visitor). Do not keep a hand-written tokenizer only
  to mirror JavaScript.
- Object keys are ordered by a fixed rule chosen by core (for example by UTF-8 bytes).
- Numbers are printed by one fixed, round-tripping algorithm chosen by core (for example the
  shortest round-trip representation `serde_json` / `ryu` already produce). The ECMAScript
  `Number::toString` reproduction and its ties-to-even correction are removed.
- Strings use standard JSON escaping. Escaped lone surrogates (`"\ud800"`) are rejected when
  the engine parses the body, with the same `POLICYSQL_INVALID_REQUEST` the engine already
  returns for raw lone surrogates (`request-body.ts`), so they never reach hashing. This makes
  the two forms of the same invalid text behave the same.
- The parser's limits (depth, size) equal the engine's body limits, so a body the engine
  accepts is never rejected by hashing.

### No version marker, no dual-hash gate

Stored values carry no format version. When the hashing rule changes, values written before
the change no longer match. The dual-hash gate (`deploy/cloudflare/src/identity.ts`) and the
TypeScript computation in `deploy/cloudflare/src/idempotency.ts` are removed; the engine and the
owner use core's result only.

### What changes at the deployment that switches the rule

- **`keyHash` and the auth and start fingerprints**: their inputs are objects whose keys are
  ASCII (session keys match `^[a-z][a-z0-9_]*$`, ADR 0005) and whose values are strings. Any
  standard canonical JSON with sorted keys encodes them exactly as `stableJson` did, so these
  values stay equal and no committed keyed request executes twice. A test pins this with the
  current encoding of representative identities.
- **Commit and rollback digests**: the command is `{sequence}` with a small integer, which every
  standard canonical JSON encodes identically, so a commit retry straddling the deployment is
  still recognised (ADR 0007).
- **Request fingerprints and statement digests** include the request body. They can differ for
  bodies with non-integer numbers, large integers, or non-ASCII keys. A keyed atomic retry
  straddling the deployment may then get `POLICYSQL_IDEMPOTENCY_CONFLICT`, the same outcome as
  every snapshot-changing deployment today. A statement retry straddling it is not recognised
  as an exact retry; no commit outcome is misreported. This is accepted.

### Consequences for ADR 0024

- The "Where byte-equal hashing is load-bearing" paragraph and the pull request 2 corpus,
  randomized differential, and "Risk and gate" items are superseded by this ADR.
- Pull request 9 no longer deletes a TypeScript side of the identity gate; it is removed by the
  follow-up pull request below.
- Everything else in ADR 0024 stands.

## Follow-up

One pull request, before ADR 0024 pull request 4:

1. Replace `canonical.rs` with a standard-parser-based canonical form as above; keep the
   duplicate-key rejection and the performance tests (wide objects, number-heavy bodies).
2. Remove `identity.ts` and the TypeScript hashing in `idempotency.ts`; keep only key syntax
   validation where the engine needs it before calling core, or move it into core.
3. Reject escaped lone surrogates in the engine's body parser.
4. Replace the byte-equality differential tests with tests that pin core's canonical form,
   determinism, duplicate-key rejection, and the stability of `keyHash` and commit digests
   for representative inputs.
5. Update ADR 0024's references to this ADR.

## Rejected alternatives

- **Keep byte equality, using `ryu-js` and `serde_json` instead of a hand-written formatter.**
  Smaller than today, but still couples core to JavaScript's number printing and keeps the
  dual-hash gate and its CPU cost, for compatibility that snapshot changes already break.
- **Prefix stored values with a format version** and answer old-format mismatches with an
  outcome-unknown error. It protects only retries that straddle one deployment, which is not a
  goal in beta, and keyed identities and commit digests are already stable without it.
- **Hash the raw body bytes.** Changes the retry rule of ADR 0007 from "same canonical payload"
  to "same bytes" (whitespace and key order would matter to clients).
