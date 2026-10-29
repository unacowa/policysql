# ADR 0024: Transaction decisions as a pure `step` machine in core

- Status: accepted (design; implemented by the pull requests under [Migration](#migration))
- Issue: #35 (stage 4 of [ADR 0019](0019-library-layers-and-the-wrapper-boundary.md))
- Related: [ADR 0007](0007-transaction-retry-and-commit-check-protocol.md),
  [ADR 0011](0011-use-versioned-backend-profiles-for-multi-database-support.md),
  [ADR 0014](0014-wrapper-provided-database-bindings.md),
  [ADR 0020](0020-trusted-session-input-and-jwt-identity-adapter.md),
  [ADR 0021](0021-explicit-engine-config.md),
  [ADR 0022](0022-transaction-owner-port.md),
  [ADR 0023](0023-operations-api-and-http-adapter.md)

## Context

ADR 0011 says the transaction safety state machine is authoritative Rust code. ADR 0019 says
every decision whose outcome the PolicySQL specification determines belongs to core, and that
core exposes transaction rules as `step(state, event) -> (state, effects)`. Today the engine
makes those decisions in TypeScript, and the Rust `execute_checked_transaction` is a
synchronous coordinator that no production path calls. This ADR fixes the ABI, the state, the
effect contract, and the migration. Line numbers refer to `main` at 9ccd38c.

### Inventory of decisions made in TypeScript

Paths are under `deploy/cloudflare/src/`. "Core" means the `step` machine unless another core
function is named. "Stays" means the code is mechanism (waiting, I/O, a codec, or a lane) and
remains in the engine or an adapter.

**Interactive transaction states and transitions** (`transaction-owner.ts`)

| Decision | Today | Goes to |
| --- | --- | --- |
| Owner input shape (exact keys, id and fingerprint syntax, mode) | 33-37, 234-238, 317-320, 394-395, 539-545 | core (forwarded events are validated as untrusted) |
| Snapshot equality and binding check on entry; failure closes the transaction | 111-129 | core decides when; `CheckBinding` effect performs it |
| Fingerprint, id, binding, and snapshot match for a command | 212-219 | core |
| Owner loss (`!this.transaction`) and expiry detection on a command; `expired` vs `failed` | 220-231 | core (absent volatile state, injected time) |
| Begin retry: same start fingerprint replays, different conflicts, lost owner fails | 240-251 | core |
| Expiry time, begin mode, begin timeout (1,000 ms), initial record | 252-276 | core (limits from runtime configuration) |
| Public state shape | 279-289 | core (`Respond` value) |
| Sequence rules: exact retry by digest, gap or reuse fails and rolls back, terminal is unavailable | 291-304 | core |
| Statement cap, compile, compile error closes, read-mode violation, execute failure closes | 324-351 | core |
| Usage accumulation and rounding, cumulative result bytes, mutation summary, check merge | 353-390 | core (checks are recomputed, not merged; see [Plans](#plans-across-requests)) |
| Commit triggers checks iff a mutation changed rows; re-check after the validator; terminal status and response | 393-431 | core |
| Commit or rollback outcome; a commit error becomes `failed`; commit without a connection becomes `failed` | 195-210 | core (`Commit` / `Rollback` effects and their outcome events) |
| Timer expires `active` and `validating` | 437-440 | core (`TimerFired`) |
| Client lane and callback lane queues | 138-148, 170-184 | stays (ADR 0022 port mechanism) |
| A callback failure ends the open transaction | 177-178 | core |

**Commit checks and the callback capability** (`commit-checks.ts`, `transaction-owner.ts`)

| Decision | Today | Goes to |
| --- | --- | --- |
| Triggered checks: changed rows in a `triggeredBy` resource, ascending id | `commit-checks.ts` 41-52 | core |
| Unconfigured check rejects before any capability or hook | `commit-checks.ts` 83-90 | core, with configured ids as a host fact |
| URL and secret re-check at the exit | `commit-checks.ts` 91-96 | stays (adapter defense in depth; config is validated at construction) |
| Capability token (32 random bytes), expiry `min(now + timeout, deadline)`, remaining time | `commit-checks.ts` 17-21, 97-100 | core (entropy and time from host facts) |
| Callback session: check role, roles, `access: ["execute"]` | `commit-checks.ts` 101-107 | core |
| Hook payload | `commit-checks.ts` 127-138 | core (the hook adapter adds `query` and signs) |
| Decision shape and verdict; any failure rejects | `commit-checks.ts` 30-39, 143-148 | core |
| Capability verification (syntax, expiry, constant-time hash compare) | `commit-checks.ts` 154-164 | core |
| Capability lifecycle: activate (status `validating`), deactivate, reject if the connection closed meanwhile | `transaction-owner.ts` 447-458 | core |
| Validation id `cval_` from the transaction id; synthetic `affectedRows: 1` per recorded mutation | `transaction-owner.ts` 460-483 | core |
| Callback query: capability, binding and snapshot match, expiry, sequence and exact retry, compile under the callback session, read-only single statement, 100 rows, 64,000 bytes, response meta | `transaction-owner.ts` 485-536 | core |

**Atomic execution and idempotency** (`engine.ts`, `turso.ts`, `idempotency.ts`, `transaction-owner.ts`)

| Decision | Today | Goes to |
| --- | --- | --- |
| Canonical JSON (`stableJson`), SHA-256 | `idempotency.ts` 3-15 | core |
| Key syntax; identity (`principal`, subject, role, session, endpoint, database scope and id); `keyHash`; fingerprint (identity, payload, full binding) | `idempotency.ts` 22-46 | core |
| Interactive fingerprint (`authFingerprint`) | `idempotency.ts` 48-57 | core |
| Idempotency only for write mode | `engine.ts` 313-321 | core |
| Route to an owner iff a commit check could trigger | `engine.ts` 322-327 | core (`Forward` effect) |
| Validation id, transaction id, start fingerprint derivation | `engine.ts` 329, 418-422; `transaction-owner.ts` 569 | core (entropy from host facts) |
| Begin body (`mode`, `expected`) and stale `expected` | `engine.ts` 400-416 | core |
| Atomic response shape (`commitChecks`, original request id, debug trace) | `engine.ts` 334-353, 373-391 | core |
| Direct path: lookup, more than one row is 500, conflict is `IDEMPOTENCY_CONFLICT`, loose stored-record check, replay, transaction id `atomic_<requestId>`, insert, commit | `turso.ts` 383-489 | core |
| Owner path: same lookup, conflict is `TRANSACTION_CONFLICT`, strict stored-record check, transaction id `atomic_<validation hex>`, write-only, deadline 4 s, begin timeout = strictest statement timeout | `transaction-owner.ts` 39-59, 546-646 | core (one rule for both paths) |
| Cumulative rows, bytes, and elapsed time | `turso.ts` 215-238 | core |
| Mutation `affectedRows` (RETURNING row count vs `rowsAffected`), public result columns, redaction list | `turso.ts` 240-313 | core |
| Execution trace content | `turso.ts` 174-200 | core (`Execute` carries it); the sink call stays |
| Driver failure class (`QueryTimeoutError` is a timeout) | `turso.ts` 494-495 | stays (adapter classification); the class-to-code rule goes to core |
| Client and server parameter namespaces must not collide | `driver-values.ts` 18-23 | core (BLOB decoding stays as the database codec) |
| Driver value and row codecs (`rawDriverValue`, `rowValues`) | `driver-values.ts` 25-59 | stays (codec; core validates every value again) |

**Cost** (`cost.ts`). The issue calls it cost admission, but no request is admitted or
rejected by it: `observeCostEnvelope` runs after the response and only logs. The evaluation
(`evaluate`, 24-68: catalog bounds, `POLICYSQL_USAGE_BUDGET_EXCEEDED`, insert estimates) moves
to a pure core function `cost_estimate_json`. The orchestration (85-137, a separate read
connection with 1,000 ms timeouts) stays as the execution of an `Observe` effect, with its
timeouts from runtime configuration. `estimateSealedOnTransaction` (71-83) has no caller and is
deleted.

**Hard-coded limits.** `MAX_TRANSACTION_MS = 4_000`, `MAX_STATEMENTS = 8`, and
`MAX_RESULT_BYTES = 64_000` (`transaction-owner.ts` 19-21), plus the callback row limit `100`
(525), the callback sequence cap `MAX_STATEMENTS` (501), the begin timeout `1_000` (254), and
the cost connection timeouts `1_000` (`cost.ts` 103-104). `presenters.ts` advertises
`maxInteractiveDurationMs: 4000` (115) and derives `maxCallbackQueriesPerCheck` and
`maxCallbackRowsPerCheck` (111-112) from `LIMITS` merged with `publicConfig.limits`, so an
override changes what is advertised but not what is enforced. All of them become fields of the
runtime limits that `PolicySqlRuntime` is constructed with (`RuntimeLimits` in
`crates/policysql-wasm/src/lib.rs`), and the capabilities response reads them from the runtime.
The provider timeout in `database.ts` 255 is an adapter bound, not a specification limit, and
stays.

### Inconsistencies the move must resolve

Moving the rules into one place exposes cases where the two TypeScript paths disagree or where
ADR 0007 is not kept. Each is decided below and listed as an expected difference in the
differential harness.

1. **Idempotency conflict code.** The direct path returns `POLICYSQL_IDEMPOTENCY_CONFLICT`; the
   owner path returns `POLICYSQL_TRANSACTION_CONFLICT` for the same condition. Core returns
   `POLICYSQL_IDEMPOTENCY_CONFLICT` on both. Both are definite rejections of `execute` in the
   client (`packages/client/protocol.js` 107-127), so client outcomes do not change.
2. **Duplicate idempotency rows and stored-record validation.** The direct path returns 500 and
   checks the stored record loosely; the owner path returns 409 and checks strictly. Core
   returns 500 and checks strictly on both.
3. **Commit outcome after a lost owner.** The owner calls `transaction.commit()` and persists the
   terminal record afterwards (`transaction-owner.ts` 410-422). If the owner is lost between
   the two, the successor finds `active`, and a repeated commit gets 409
   `POLICYSQL_TRANSACTION_UNAVAILABLE`, which the client treats as a definite rejection of a
   commit that may have committed. Core persists a `committing` record before the `Commit`
   effect, and a successor that finds `committing` answers with an outcome-unknown reply.
4. **Commit error.** `close("committed")` turns any commit error into the value
   `{ status: "failed" }` (200). A transport error during commit does not prove that nothing
   committed. Core distinguishes a definite failure from an unknown outcome (see
   [Effect contract](#effect-execution-contract)).
5. **Expiry during a validator.** The expiry rolls back at once, but the commit replies only when
   the validator call ends. Core replies to the waiting commit when it expires the transaction.

## Decision

### Where the machine lives

A new crate `policysql-transaction` holds the machine as plain Rust with no `wasm-bindgen`, no
I/O, no clock, and no randomness. It is generic over a small `Compiler` trait (compile an
envelope for a session and return a statement summary plus an execution handle; validate a raw
result against a handle; release a handle; recompute triggered checks for a set of mutated
resources) so property tests run with a fake compiler. `policysql-wasm` implements the trait
with the existing gateway and handle table and exports one method:

```ts
runtime.step_json(durableJson: string | null, volatileJson: string | null,
                  eventJson: string, hostJson: string): string
// → {"durable": Durable | null, "volatile": Volatile | null, "effects": Effect[]}
```

`compile_json(..., "execute")`, `validate_result_json`, and `release_execution` stop being
called by the engine; `step_json` uses them internally. `compile_json(..., "explain")`,
`catalog_json`, and `authorize_session_json` are unchanged.

### One machine, three kinds

| Kind | Runs in | State persisted | Created by |
| --- | --- | --- | --- |
| `request` | the engine that received the operation | never | every client operation and callback query, with no prior state |
| `interactive` | the owner of `tx_<id>` | yes | a forwarded begin |
| `atomic` | the engine (direct) or the owner of `tx_<validation hex>` | only on the owner | an execute |

A `request` step validates the operation, computes identities and ids, and either returns
`Forward { owner, lane, event }` (begin, statement, commit, rollback, callback query, and an
execute whose compiled envelope could trigger a commit check) or turns into an `atomic` machine
with placement `direct` in the same engine. Atomic execution therefore uses the same machine as
interactive transactions: the same compile, execute, validate, idempotency, commit-check,
commit, and failure rules, with placement deciding only whether `Persist` and `SetTimer` are
emitted. The direct placement still allows read-mode envelopes; the owner placement requires
write mode, as today.

### State

State has two parts. **Durable** is what a successor owner must see; the engine writes it to
the `TransactionOwner` store when told to. **Volatile** is what dies with the owner instance:
the open connection, pending effects, execution handles, and the callback capability. The engine
keeps both in memory for the owner's lifetime and passes them back on every step. A successor
starts with the stored durable part and no volatile part, and core reads "no volatile part"
as "the connection is gone": that is how owner loss is detected, without an incarnation id.

```rust
struct Durable {
    v: u32,                         // TX_STATE_VERSION = 1; anything else is rejected
    owner: OwnerName,               // "tx_" + 32 hex; must equal host.owner
    kind: Kind,                     // interactive | atomic
    phase: Phase,                   // active | validating | committing
                                    // | committed | rolled_back | failed | expired | commit_unknown
    identity: Identity,             // auth fingerprint, replay identity, start fingerprint, mode
    binding: DatabaseBinding,       // pinned (ADR 0014)
    snapshot: SnapshotId,
    expires_at_ms: Option<u64>,     // Some iff phase is active, validating, or committing
    next_sequence: u32,
    last: Option<Replay>,           // { digest, response } of the last completed command
    counters: Counters,             // statements, result bytes, usage
    mutations: Vec<Mutation>,       // { index, operation, resource }, at most max statements
    versions: Versions,             // schema and policy version of the compiled statements
    atomic: Option<AtomicIds>,      // validation id, idempotency key hash
}

struct Volatile {
    v: u32,
    owner: OwnerName,
    next_effect_id: u64,
    pending: Pending,               // at most one awaited effect per lane, at most one on the connection
    connection: Connection,         // none | opening | open | closing
    handles: Vec<u64>,              // live execution handles of this owner
    commit: Option<CommitProgress>, // checks to run, current index, callback session, request id
    capability: Option<Capability>, // token hash, expiry, check, callback sequence, last, rows, bytes
    rollback_requested: bool,       // set when expiry arrives while the connection is busy
    atomic: Option<AtomicProgress>, // started time, results so far, idempotency fingerprint
}
```

- **No session in durable state.** Today the record stores the begin session and compiles every
  statement under it. Core instead compiles each client command under the session the wrapper
  supplied with that command, which core has just validated and whose fingerprint must equal
  `identity.auth_fingerprint`. The callback session is derived from the commit's session and
  lives in volatile state. The store therefore holds no session values, and a stored value
  cannot raise the privileges of a later command.
- **Replay identity.** `identity.replay` is a hash of `principal`, subject, role, session, and
  the binding without its `snapshot`. An exact retry of a completed command is answered from
  `last` when the replay identity and digest match, before any snapshot or liveness check, so a
  lost commit response can still be confirmed after a deployment changed the snapshot. Every
  command that does work still requires the full fingerprint and the current snapshot.
- **Bounds.** Durable JSON is at most 96 KiB, so it fits a Durable Object value (128 KiB) with
  room for the key and framing; volatile JSON is at most 256 KiB; an event is at most
  `max_statements` × 1 MiB of raw results plus 64 KiB. `last.response` is bounded by the
  transaction result-byte limit; runtime construction rejects a limit that could make durable
  state exceed its bound. Core never emits a state over its bound: the transition fails
  closed instead.
- **Versioning.** `v` is checked exactly. A later change that alters the durable shape bumps
  `TX_STATE_VERSION`; while PolicySQL is in beta, core reads only the current version plus,
  for one release after this ADR's switch-over, the legacy shape described under
  [ABI impact](#abi-impact-and-rollout).

### Events and host facts

Each call passes one event and the host facts. Host facts are everything nondeterministic or
deployment-owned that core needs, supplied by the engine on every call:

```rust
struct HostFacts {
    now_ms: u64,                    // Date.now() when the engine took the event
    entropy: [u8; 32],              // fresh crypto.getRandomValues bytes; core uses them or not
    request_id: RequestId,          // the caller's or a fresh UUID (ADR 0023 rules)
    owner: Option<OwnerName>,       // the owner running this step; None in the engine
    configured_checks: Vec<CheckId>,// ids with an endpoint in PolicySqlConfig, plus publicBaseUrl presence
}

enum TxEvent {
    // client and validator inputs (untrusted)
    Request(Operation),             // execute, begin, statement, commit, rollback, callback query
    Forwarded(OwnerInput),          // what a Forward effect delivered to an owner
    TimerFired,
    // outcomes of awaited effects; every one names the effect id
    Opened { id }, OpenFailed { id, class },
    BindingChecked { id, allowed }, BindingCheckFailed { id, class },
    Executed { id, results: Vec<RawResult> }, ExecuteFailed { id, class },
    Committed { id }, CommitFailed { id, class },
    RolledBack { id }, RollbackFailed { id, class },
    ValidatorReplied { id, ok, decision }, ValidatorFailed { id, class },
    OwnerReplied { id, reply }, ForwardFailed { id, class },
    Persisted { id }, PersistFailed { id },
    TimerSet { id }, TimerFailed { id },
    // the engine is discarding volatile state (owner shutdown, unexpected engine error)
    Abandon,
}
```

`class` is a closed enum (`timeout`, `unavailable`, `rejected`, `not_committed`, `unknown`).
An adapter that cannot classify an error reports `unknown`. Core never sees an error message.

Core uses `entropy` for the unkeyed transaction and validation ids (16 bytes) and the capability
token (32 bytes); a step that needs both takes disjoint slices. Expiry is checked against
`now_ms` on every event, as the TypeScript code checks `Date.now()` today, and `TimerFired` is
the same check when no client event arrives.

### Effects

```rust
enum Effect {
    // awaited: the engine feeds back exactly one outcome event with the same id
    Forward { id, owner, lane, input },              // → OwnerReplied | ForwardFailed
    Open { id, mode, timeout_ms, deadline_ms },      // → Opened | OpenFailed
    CheckBinding { id, binding, deadline_ms },       // → BindingChecked | BindingCheckFailed
    Execute { id, statements, trace },               // → Executed | ExecuteFailed
    Commit { id },                                   // → Committed | CommitFailed
    Rollback { id },                                 // → RolledBack | RollbackFailed
    CallValidator { id, check, payload, capability, timeout_ms }, // → ValidatorReplied | ValidatorFailed
    SetTimer { id, at_ms },                          // → TimerSet | TimerFailed
    Persist { id },                                  // → Persisted | PersistFailed
    // immediate: no outcome
    Respond { lane, reply },                         // OwnerReply or operation result
    Observe { statements, context },                 // background cost observation
    Log { record },                                  // a structured log record decided by core
}
```

- `Execute.statements` are `{ sql, args }` as the database port takes them, with BLOBs in the
  private ABI form the codec decodes. Every SQL text the engine sends comes from an effect,
  including the constant idempotency lookup and insert, which move from TypeScript into core.
- `CallValidator` names the check id; the hook adapter looks up the endpoint and secret in the
  validated configuration, adds the `query` block, and signs. Secrets never enter core or state.
- `Persist` writes the durable part returned by the step that emitted it, not a later one.
- `Log` records are the ones the engine writes today (`transaction_started`,
  `transaction_terminal`, `transaction_usage`, `transaction_owner_unavailable`,
  `commit_check_unconfigured`, ...), so the differential harness compares them.

**Batch rule.** The effects of one step run in order. A batch holds any number of immediate
effects followed by at most one awaited effect, which is last. Ordering such as "persist
`committing`, then commit" or "persist the terminal record, then respond" is therefore built
into the sequence of steps, not left to the engine. Lanes are those of ADR 0022: client,
callback, and timer. Core keeps at most one awaited effect per lane and at most one effect on
the connection at a time.

### Fail-closed rules

- **Invalid durable state** (does not parse, unknown `v`, out of bounds, `owner` differs from
  the routing name, internally inconsistent, such as `committed` with an expiry): core emits
  `Log(tx_state_rejected { reason })`, rolls back a connection if volatile state says one is
  open, replies `POLICYSQL_INTERNAL` on the lane, and writes a tombstone durable state
  (`phase: failed`, no `last`), so later commands get `POLICYSQL_TRANSACTION_UNAVAILABLE`.
- **Invalid volatile state** is an engine fault: the same as above, and the engine discards it.
- **Invalid host facts** (`step_json` cannot read them) return `{"error": POLICYSQL_INTERNAL}`
  and no state; the engine replies 500 and sends `Abandon` with the previous state.
- **An outcome event for an id that is not pending.** If the transaction is terminal, core logs
  and ignores it (a validator that answers after expiry). Otherwise core fails the transaction
  closed. Duplicated and reordered outcomes therefore never commit.
- **A client or validator event that is invalid** gets the client-facing codes of today, and
  ADR 0007's rule that a conflicting command fails and rolls back an active transaction.
- **A Rust invariant violation inside a transition** is reported as an invalid durable state.
  Clippy already denies `panic`, `unwrap`, and `expect`.

### Plans across requests

A verified plan never leaves the request that compiled it, and nothing in durable state is a
plan. This is already true of the behavior and becomes true of the data:

- An interactive statement is compiled, executed, and validated in one command; its handle is
  in volatile state for that span and released by the step that consumes the `Executed` or
  `ExecuteFailed` outcome, or by `Abandon`.
- Commit needs only which resources changed. Durable state keeps `mutations` (index, operation,
  resource id), and the commit step recomputes the triggered checks from the runtime's policy.
  The stored `commitChecks` list (`transaction-owner.ts` 387, 442-445) is dropped, so a stored
  value cannot remove, reorder, or retime a check. This is sound because every step first
  requires the durable snapshot to equal the runtime snapshot, so the policy is the one that
  compiled the statements.
- Callback queries are compiled per query under the callback session in volatile state.
- An atomic envelope is compiled, executed, checked, and committed within one request.

We recompile per command and do not seal plans. Sealing would serialize a
`VerifiedExecutionPlan` and accept it back, which is a constructor that bypasses emission
verification (ADR 0011 keeps those constructors private); it would need a key with rotation; and
it would buy nothing, because no flow needs a plan in a later request. Compile cost is bounded
by the 64 KiB SQL limit and is paid today already.

`Observe` carries the explain statements and an evaluation context (operation, resource id,
explain resource per statement) to the background task, which calls `cost_estimate_json` with
the results. That context round-trips through the engine, but its only use is a log record; it
never affects a reply.

### State integrity: shape and version, no MAC

Core validates durable state for shape, version, bounds, owner name, and internal consistency,
and does not authenticate it with a MAC.

The store is platform-trusted: ADR 0022 makes it private to one owner, and the Durable Objects
adapter backs it with storage that only the object can reach. Whoever can write it can also
replace the Worker, the WASM module, or the secrets, so a MAC keyed by a deployment secret does
not raise the bar against the platform. What the store can do by accident (a rollout writing an
older shape, a bug in a custom adapter, a value put under the wrong name) is caught by `v`,
the shape check, and the `owner` field.

The design also limits what a modified value could achieve:

- no session, plan, check list, secret, or capability token is stored (only the token hash, and
  only in volatile state);
- every command re-validates its session and must match the stored fingerprint;
- the binding is re-checked through the wrapper's provider before work and before commit;
- triggered checks are recomputed from the policy;
- a successor never trusts `active` without a live connection.

The residual exposure is a forged `last` reply returned on an exact retry, which only someone
who controls the platform can write. A MAC would cost a key in `PolicySqlConfig`, key ids and
dual acceptance for rotation, and verification on every step. If PolicySQL later supports a
store adapter that is not private to the owner, a new state version adds an HMAC over the
durable JSON with a key id, and that adapter's conformance requires it.

### Determinism and purity

- Core reads no clock and no random source. `policysql-transaction` has no dependency on
  `getrandom` or `js-sys`; a structural test fails if `cargo tree` for the WASM target shows
  either under it, or if its source names `SystemTime` or `Instant`.
- The engine supplies `now_ms` from `Date.now()`, `entropy` from `crypto.getRandomValues`, and
  `request_id` by the ADR 0023 rules, for every step. Elapsed time for the cumulative timeout is
  `now_ms - started_at_ms`, so it has millisecond resolution instead of `performance.now()`.
- Replay: the engine can record a transcript per owner (one JSON line per step with all four
  inputs and the output). Running `step_json` over the inputs must reproduce every output byte
  for byte. Transcripts from the conformance suite and from every security fix are checked in
  under `tests/fixtures/transactions/` and replayed by a Rust test, which gives each fix the
  regression fixture AGENTS.md requires.

### Effect execution contract

The engine's owner (the successor of `TransactionOwnerCore`) and the engine's operation code
become effect executors:

1. Call `step_json` with the current state, the event, and fresh host facts; keep the returned
   state in memory as current.
2. Run the effects in order. Immediate effects are not awaited by the lane and never fail it: a
   `Respond` the transport cannot deliver, a failed `Observe`, or a failed log write is logged by
   the engine and changes nothing.
3. Run the awaited effect, if any. Catch every outcome, including exceptions and timeouts, map
   it to exactly one outcome event with a class, and go to step 1. The engine never skips an
   outcome and never decides what it means.
4. Client-lane events are fed one at a time, the next only after the lane's `Respond` (ADR 0022
   order of arrival). Callback-lane events likewise. `TimerFired` is fed immediately.
   `step_json` is synchronous, so steps never interleave; effects of different lanes may be in
   flight together.
5. Store writes apply in call order (a port obligation the conformance suite already exercises
   for Durable Objects). On owner shutdown or an engine error the engine feeds `Abandon`, which
   releases handles, and lets the database adapter close the connection.

What each failure leads to (all decided by core, listed here because ADR 0007 depends on them):

| Failure | Outcome |
| --- | --- |
| `OpenFailed`, `ExecuteFailed`, `BindingCheckFailed`, or binding not allowed | roll back if open, phase `failed`, reply with the class's code (`DATABASE_TIMEOUT`, `DATABASE_UNAVAILABLE`, `DATABASE_BINDING_REJECTED`, as today) |
| `PersistFailed` before `Commit` | roll back, phase `failed`, reply `POLICYSQL_INTERNAL`; no commit is sent |
| `PersistFailed` of the terminal record after `Committed` | reply committed (true); a retry finds `committing` and gets the outcome-unknown reply, never a rejection |
| `CommitFailed { class: not_committed }` | phase `failed`, reply as today (`status: "failed"`) |
| `CommitFailed` of any other class | phase `commit_unknown`; the reply and every exact retry of that commit get an outcome-unknown error the client does not treat as a rejection |
| `ValidatorFailed`, deny, malformed decision | roll back, `POLICYSQL_COMMIT_CHECK_REJECTED` |
| `TimerFired` while `validating` | phase `expired`, reply `POLICYSQL_COMMIT_CHECK_REJECTED` to the waiting commit now, roll back (deferred via `rollback_requested` if a callback query holds the connection); the late validator outcome is ignored |
| `TimerFired` while `committing` | nothing; the commit is already sent and its outcome decides |
| Successor finds `active` | phase `failed`, `POLICYSQL_TRANSACTION_UNAVAILABLE` (true: commit is never sent without `committing` persisted first) |
| Successor finds `validating` | stays `validating` until the timer expires it (ADR 0022); commands get `POLICYSQL_TRANSACTION_UNAVAILABLE` |
| Successor finds `committing` | phase `commit_unknown` |
| `RollbackFailed` | phase stays terminal as decided; the database deadline ends the server transaction, and no commit is sent |

So: a commit outcome is reported as committed only after `Committed`, as rejected only when no
`Commit` was sent or the adapter proved it did not apply, and as unknown otherwise; exact
retry of every completed command replays `last`; owner loss fails closed; and expiry ends a
commit that waits on a validator.

### ABI impact and rollout

- **ABI 5.** `ABI_VERSION` goes from 4 to 5 when `step_json` and the extended `RuntimeLimits`
  (`transaction_ms`, `max_transaction_statements`, `max_transaction_result_bytes`,
  `max_callback_rows`, `begin_timeout_ms`, `cost_timeout_ms`) ship. The snapshot string contains
  the ABI version, so the switch-over deployment changes the snapshot, exactly as any policy or
  schema version change does today.
- **In-flight transactions** do not survive: a deployment restarts owners, so their connections
  are already gone, and the snapshot changes. They fail closed as today.
- **Keyed atomic retries across the deployment** get `POLICYSQL_IDEMPOTENCY_CONFLICT`, because
  the fingerprint includes the binding's snapshot (ADR 0014). This is today's behavior for every
  snapshot change and is unchanged by this ADR.
- **Hash compatibility.** `keyHash`, the fingerprints, and the command digest must stay byte for
  byte what `idempotency.ts` computes, or a retry after the switch would see a different key
  (and execute again) or a different fingerprint (and get a false conflict). Core implements
  `stableJson` as JavaScript does: keys sorted by UTF-16 code units, strings escaped as
  `JSON.stringify` escapes them, and numbers parsed as IEEE doubles and printed by the
  ECMAScript `Number::toString` algorithm. The first migration pull request proves equality with
  a corpus and a randomized differential test before anything depends on it.
- **Legacy durable records** (no `v`, written by `TransactionOwnerCore`) are read for one
  release, read-only: a terminal record answers an exact retry of its terminal command when the
  digest matches and the request's identity equals the identity recomputed from the stored
  `auth` and binding without the snapshot; a non-terminal record answers a commit with the
  outcome-unknown error (it may be the gap in inconsistency 3) and every other command with
  `POLICYSQL_TRANSACTION_UNAVAILABLE`. The reader is deleted in the cleanup pull request. A
  one-time incompatibility beyond that is acceptable in beta (ADR 0019); the legacy reader exists
  only so that a lost commit response is never answered with a rejection during the rollout.
- The Durable Objects class name and storage key stay; the value's shape is discriminated by `v`.
  The internal owner wire (ADR 0022, ADR 0023) keeps its paths; the forwarded inputs become the
  `Forwarded` event's JSON.

## Migration

Every pull request keeps `just fmt lint test coverage`, `cd deploy/cloudflare && npm run verify`
(both owner adapters), `npm run docs:build`, and the real-environment smoke
(`deploy/cloudflare/scripts/provision-dev.mjs`) green, and is mergeable on its own.

1. **This ADR.** Design only.
2. **Canonical JSON, hashing, and identities in core.** `policysql-transaction` with
   `stable_json`, SHA-256 (the `sha2` crate), key syntax, `keyHash`, fingerprints, digest;
   exported as `identity_json`. A TypeScript differential test compares it with
   `idempotency.ts` on a corpus and on random JSON (numbers, escapes, astral keys). The engine
   switches to it; `idempotency.ts` keeps only the call. No behavior change.
3. **Limits into runtime configuration.** Extend `RuntimeLimits` and `createRuntimeFactory`;
   `transaction-owner.ts`, `commit-checks.ts`, `cost.ts`, and `presenters.ts` read the runtime.
   Defaults equal today's constants. Advertised and enforced values become one source.
4. **The machine for interactive transactions, unused.** `TxState`, `TxEvent`, `Effect`,
   `HostFacts`, `step` for begin, statement, commit, rollback, expiry, and owner loss, without
   commit checks; `step_json` (ABI 5); property tests. A test-only `StepOwnerCore` (an effect
   executor) and a **differential harness** run every `transaction-owner` and conformance
   scenario through both `TransactionOwnerCore` and `StepOwnerCore` with the same fake clock,
   database, and store, and assert equal replies, database calls (SQL and arguments), terminal
   records, and log events, except the differences listed in this ADR, each named in an
   allowlist with its reason.
5. **Commit checks and callbacks in the machine.** Capability, validator payload and verdict,
   callback queries, expiry during validation; extend the harness and the property tests.
6. **Atomic execution in the machine.** Direct and owner placements, idempotency lookup, replay,
   insert, cumulative limits, response shape, execution trace; `cost_estimate_json`. Harness
   covers `turso.test.mjs`, `execute-egress.test.mjs`, `idempotency.test.mjs`, and
   `cost.test.mjs` scenarios.
7. **Switch interactive transactions.** `TransactionOwnerCore` becomes the effect executor for
   `interactive`; `engine.ts` begin and commands run the `request` kind; legacy-record reader.
   The TypeScript decision path remains only as the harness's reference. Smoke.
8. **Switch atomic execution.** `engine.ts` execute and the owner's atomic input run the
   machine. Smoke.
9. **Delete.** The TypeScript decision code: the decision parts of `transaction-owner.ts`,
   `commit-checks.ts` (except what the hook adapter needs), `idempotency.ts`, the decision parts
   of `turso.ts` (`executeSealedEnvelope`, `executeSealedOnTransaction`,
   `enforceCumulativeLimits`, result shaping), `cost.ts` `evaluate` and
   `estimateSealedOnTransaction`, `driverArgs`' namespace check; the differential harness (the
   transcripts replace it); the legacy reader after one release. In Rust:
   `execute_checked_transaction`, `TransactionFactory`, `TransactionSession`, `CommitCheck`,
   `CheckDecision`, `ReadOnlyCallback`, `CallbackError`, `TransactionError`, and
   `Gateway::execute_transactional`; the `policysql-turso` tests that use them move to the
   machine's tests. `VerifiedExecutionPlan`, `PlanVerifier`, and `DatabaseExecutor` stay. The
   engine-boundary guard gains a rule that engine modules construct no `POLICYSQL_*` code other
   than `POLICYSQL_INTERNAL` and adapter-class codes. `docs/architecture.md` and ADR 0011's
   statement are updated.

## Testing strategy

- **Properties of `step`** (with `proptest` as a dev dependency), over random event sequences
  generated from a model of the engine and adversarial inputs:
  - at most one `Commit` per transaction, ever; none after a terminal phase, after expiry,
    without a preceding `Persisted` for `committing`, without every triggered check allowed in
    the current volatile state, or without a `BindingChecked { allowed: true }` after the last
    validator;
  - a reply says committed only after `Committed`;
  - a reply is a definite rejection of a commit only if no `Commit` was emitted or the outcome
    was `not_committed`;
  - duplicated, reordered, and stale outcome events never produce `Commit`, and never panic;
  - `TimerFired` injected before or after any event leaves no `Commit` unless one was already
    emitted;
  - a second commit with the same digest replays, with a different payload conflicts;
  - tampered durable state (byte mutations of valid states, field mutations, other owners'
    states, legacy states) is either rejected by the fail-closed rule or behaves as some valid
    state; it never yields a `Commit` that the untampered state would not;
  - every reachable state is within its bounds; at most one awaited effect per lane and one on
    the connection; every handle is released on every path;
  - `step` is deterministic: the same inputs give the same output bytes.
- **Fuzzing.** A `cargo fuzz` target on `step_json` with arbitrary strings for all four inputs,
  and one that starts from valid transcripts and mutates them. It runs in a scheduled job, not in
  `just test`.
- **Conformance.** `test/transaction-owner-port.test.mjs` (serialization, order of arrival,
  single owner, owner loss, timer expiry, expiry and loss during a validator, exact retry,
  callback routing, binding pinning) runs unchanged against both adapters through every
  migration step; its scenarios also produce the checked-in transcripts.
- **Differential harness** during pull requests 4-8, as described above.
- **Smoke.** `provision-dev.mjs` after pull requests 7 and 8, covering begin, statement,
  commit, rollback, a commit check with a callback query, and a keyed atomic retry.

## Rejected alternatives

- **Core keeps transaction state in WASM memory across requests.** A successor or another
  isolate would not see it, and ADR 0019 keeps the handle table as the only per-request
  exception.
- **An asynchronous core that calls the database and validators through host callbacks.**
  Rejected by ADR 0019: it breaks the purity that makes the machine testable and replayable.
- **Making `execute_checked_transaction` asynchronous.** It coordinates one call stack; it
  cannot express a validator that calls back through another request, owner loss, persistence,
  or expiry, and it would still leave the decisions in its callers.
- **A coarse step that returns a whole script of effects per request.** Core could not branch on
  outcomes (replay, conflict, check verdict), so the branches would return to the engine.
- **Several awaited effects per batch.** The connection is serial, so nothing runs in parallel,
  and a partial failure would need rules for which effects ran.
- **Sealed (MAC-protected) plans in durable state** and **a MAC over durable state**: see
  [Plans across requests](#plans-across-requests) and
  [State integrity](#state-integrity-shape-and-version-no-mac).
- **Keeping canonical JSON and hashing in TypeScript.** The identity rules would stay split
  between two languages, which is the condition this stage removes.

## Consequences

- After pull request 9, no branch in the engine decides an outcome the specification
  determines; the engine waits, persists, keeps timers, and translates. ADR 0011's statement is
  true.
- The owner store holds no session values, plans, or check lists.
- ADR 0007 is kept in two places where it is not today: a lost owner during commit and a commit
  transport error are reported as unknown rather than as a rejection or `failed`.
- Clients see `POLICYSQL_IDEMPOTENCY_CONFLICT` from both atomic paths, and a commit that expires
  on its validator is answered at expiry.
- Costs: a new crate and ABI method, `sha2` and `proptest`, a WASM call per effect outcome, and
  durable writes at `committing` in addition to the terminal write.

## Open questions

- The public form of the outcome-unknown reply: an existing code that the client treats as
  uncertain (503 `POLICYSQL_DATABASE_UNAVAILABLE`) or a new 503 code
  `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` in `website/api/errors.md`.
- Whether `publicConfig.limits` keeps overriding advertised limits once they come from the
  runtime, or is removed.
