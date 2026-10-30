# ADR 0024: Transaction decisions as a pure `step` machine in core

- Status: accepted (design; implemented by the pull requests under [Migration](#migration))
- Issue: #35 (stage 4 of [ADR 0019](0019-library-layers-and-the-wrapper-boundary.md))
- Amended by: [ADR 0025](0025-core-defined-canonical-json.md) (canonical JSON is defined by
  core; byte equality with TypeScript and the dual-hash gate are dropped)
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
| Direct path: lookup, more than one row is 500, conflict is `IDEMPOTENCY_CONFLICT`, loose stored-record check, replay, transaction id `atomic_<requestId>`, insert, commit | `turso.ts` 189-338 (lookup and replay 222-272, terminal 296-305, insert 306-318, commit 319) | core |
| Owner path: same lookup, conflict is `TRANSACTION_CONFLICT`, strict stored-record check, transaction id `atomic_<validation hex>`, write-only, deadline 4 s, begin timeout = strictest statement timeout | `transaction-owner.ts` 39-59, 546-646 | core (one rule for both paths) |
| Cumulative rows, bytes, and elapsed time | `turso.ts` 54-78 | core |
| Mutation `affectedRows` (RETURNING row count vs `rowsAffected`), public result columns, redaction list | `turso.ts` 79-87, 88-99, 100-153 | core |
| Execution trace content | `turso.ts` 13-40 | core (`Execute` carries it); the sink call stays |
| Driver failure class (`QueryTimeoutError` is a timeout) | `turso.ts` 7-11, 334 | stays (adapter classification); the class-to-code rule goes to core |
| Client and server parameter namespaces must not collide | `driver-values.ts` 19-24 | core (BLOB decoding stays as the database codec) |
| Driver value and row codecs (`rawDriverValue`, `rowValues`) | `driver-values.ts` 26-60 | stays (codec; core validates every value again) |
| Binding shape, `version`, part syntax, snapshot equality (`POLICYSQL_DATABASE_BINDING_REJECTED`, `POLICYSQL_STALE_OPERATION`) for every operation | `database.ts` 94-105 | core: the `request` step validates the binding before it emits `CheckBinding`, and owners validate the forwarded binding again; the provider call (`checkDatabaseBinding` 109-115, `bounded` 76-92) stays |

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
The provider timeout of 1,000 ms in `bounded` (`database.ts` 76-92) is an adapter bound, not a specification limit, and
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
3. **Any failure between COMMIT and the terminal record.** `terminal()` sends COMMIT through
   `close()` (`transaction-owner.ts` 198), writes only `status` in `close()` (207-208), and
   writes `last` and `nextSequence` later (416-422). There are two windows. If the owner is lost
   between 198 and 208, the successor finds `active` and writes `failed`. If it is lost between
   208 and 416, the record says `committed` (or `rolled_back`) while `last.digest` is still the
   previous statement's. The same happens without owner loss when the `put` after COMMIT fails:
   the first reply is 500 (uncertain to the client), but a repeated commit reaches `active()`
   with no connection (224). In every case the repeated commit gets 409
   `POLICYSQL_TRANSACTION_UNAVAILABLE`, which the client treats as a definite rejection of a
   commit that may have committed. Old code can also write `failed` (the catch at 200-204, the
   successor's fail-closed at 227-230) or `expired` (inconsistency 6) after COMMIT was sent, so
   no old record's status proves that COMMIT was not sent. #48 fixes this in TypeScript ahead of
   stage 4 by persisting `committing` before COMMIT and answering commit retries in the unsafe
   windows with `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`. Core keeps that rule: it persists a
   `committing` record before the `Commit` effect, and a successor that finds `committing`
   answers with `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`. Records written before the switch-over,
   #48's included, are handled under [ABI impact](#abi-impact-and-rollout).
4. **Commit error.** `close("committed")` turns any commit error into the value
   `{ status: "failed" }` (200). A transport error during commit does not prove that nothing
   committed. Core distinguishes a definite failure from an unknown outcome (see
   [Effect contract](#effect-execution-contract)).
5. **Expiry during a validator.** The expiry rolls back at once, but the commit replies only when
   the validator call ends. Core replies to the waiting commit when it expires the transaction.
6. **Expiry during an in-flight COMMIT.** `onTimer` (437-440) is not serialized with the client
   lane, and the Turso HTTP transaction keeps `open` true while COMMIT is in flight
   (`turso-http.ts` 221-233). An expiry while `transaction.commit()` is pending therefore sends
   ROLLBACK on the same baton through `close("expired")`, and the timer's `close` and the
   commit's `close` then persist `expired` or `failed` and `committed` in either order. Core does
   not expire a `committing` transaction (see [Events](#events-and-host-facts)): the commit
   outcome alone decides. The harness lists this difference, and a transcript fixture of the
   race is checked in with pull request 4.

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

**Atomic on the owner: the database decides retries.** For `kind: atomic` the durable phase only
serializes work on the owner (it lets the timer expire a stuck execution and keeps a second
execution from starting while one is open). It is never used to answer a request. Every atomic
request, including a keyed retry that reaches an owner whose durable state is `active`,
`failed`, or unreadable, starts a fresh execution (atomic durable state uses only `active` and
the terminal phases; it never enters `committing`): compile, open, and, when keyed,
the `policysql_idempotency` lookup. The row in `policysql_idempotency` is the only record of the
outcome: a row with the same fingerprint is replayed, a row with another fingerprint is
`POLICYSQL_IDEMPOTENCY_CONFLICT`, and no row means the earlier attempt did not commit (the row is
written in the same database transaction as the mutation), so the request executes. This is
what `executeAtomic` does today (`transaction-owner.ts` 546-552 ignores the previous status).
The `committing` and `commit_unknown` phases below apply to `kind: interactive` only. An unkeyed
atomic request gets a fresh owner and cannot be retried.

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
                                    // | discarded (see Fail-closed rules)
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
  `last` of a current-version record when the replay identity and digest match, before any
  snapshot or liveness check, so a
  lost commit response can still be confirmed after a deployment changed the snapshot. Every
  command that does work still requires the full fingerprint and the current snapshot.
- **Bounds.** Durable JSON is at most 96 KiB, so it fits a Durable Object value (128 KiB) with
  room for the key and framing; volatile JSON is at most 256 KiB; an event is at most
  `max_statements` × 1 MiB of raw results plus 64 KiB. `last.response` is bounded by the
  transaction result-byte limit; runtime construction rejects a limit that could make durable
  state exceed its bound. Core never emits a state over its bound: the transition fails
  closed instead.
- **Versioning.** `v` is checked exactly. A later change that alters the durable shape bumps
  `TX_STATE_VERSION`. While PolicySQL is in beta, core reads only the current version; any
  other record, including every record written by `TransactionOwnerCore`, is discarded by the
  rule under [Fail-closed rules](#fail-closed-rules).

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
`now_ms` on every client, callback, and timer event, as the TypeScript code checks `Date.now()`
today, and `TimerFired` is the same check when no client event arrives. Phase `committing` has
exactly one deadline check: the step that consumes `Persisted` for `committing` compares
`now_ms` with `expires_at_ms` before it emits `Commit`, and expires the transaction instead
(rollback, no COMMIT) when the deadline has passed. A `TimerFired` while `committing` is
ignored: before `Commit` that step decides, and after it nothing expires the transaction. The
outcome of a `Commit` effect (`Committed`, `CommitFailed`) and the `Persist` of the terminal
record that follows it are never judged against the deadline. COMMIT has been sent by then, so
only its outcome can decide; a `Committed` that arrives after `expires_at_ms` is reported as
committed. The database deadline passed to `Open` still bounds how long COMMIT can take.

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
    Reset,                                           // drop in-memory state; the next event starts
                                                     // from the store with no volatile part
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

- **Unreadable durable state** (does not parse, no `v` or another `v`, out of bounds, `owner`
  differs from the routing name, internally inconsistent, such as `committed` with an expiry).
  This includes every record written by `TransactionOwnerCore` before the switch-over. Core
  emits `Log(tx_state_discarded { reason })`, rolls back a connection if volatile state says one
  is open, and replaces the record with a tombstone (`phase: discarded`, the owner name, nothing
  else). The tombstone and the record it replaces are answered alike:
  - a `commit` command, whatever its sequence, digest, or the old record's status, gets
    `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`. Nothing in an old record proves that COMMIT was not sent
    (inconsistencies 3 and 6), so no commit retry is ever answered with a definite rejection;
  - every other interactive command (begin retry, statement, rollback) and every callback query
    gets `POLICYSQL_TRANSACTION_UNAVAILABLE`; nothing executes;
  - an atomic request ignores the record and runs as described under
    [Atomic on the owner](#one-machine-three-kinds), so a keyed retry still resolves through the
    `policysql_idempotency` lookup.

  The cost is that a commit retry against a transaction that really rolled back also gets
  outcome-unknown; the client then resolves it by its own means.
- **Invalid volatile state** is an engine fault. If the durable state is readable, core handles
  it exactly as `Abandon` (below) applied to that durable state, so an interactive transaction in
  `committing` becomes `commit_unknown` (persisted). If the durable state is unreadable too, the
  rule above applies (`discarded`). In both cases the engine discards the volatile state.
- **Invalid host facts** (`step_json` cannot read them) return `{"error": POLICYSQL_INTERNAL}`
  and no state; the engine replies 500 and sends `Abandon` with the previous state.
- **`Abandon`** releases every handle in volatile state, drops its pending effects, and moves
  the durable phase as follows, emitting `Persist` as its one awaited effect when the phase
  changes. The engine runs that `Persist` before it discards the state:
  - `active` or `validating` with an open connection → `failed` (the database adapter closes
    the connection; COMMIT was never sent);
  - `committing` → `commit_unknown`, whether or not `Commit` was emitted, because only the
    volatile state knew whether it had been;
  - a terminal phase, `discarded`, or `atomic` placement `direct` → unchanged (nothing to
    persist).
  If that `Persist` cannot run (the owner is gone), a successor finds `committing` and reaches
  `commit_unknown` by the successor rule.
- **An outcome event for an id that is not pending.** If the transaction is terminal (including
  `commit_unknown`, where a late `Committed` or `CommitFailed` after `Abandon` lands), core logs
  and ignores it (a validator that answers after expiry). Otherwise core fails the transaction
  closed. Duplicated and reordered outcomes therefore never commit.
- **Fail closed never turns `committing` into `failed`.** Every fail-closed path above (an
  invalid volatile state, an outcome that is not pending, an invariant violation, `Abandon`)
  moves an interactive transaction in phase `committing` to `commit_unknown` (persisted), so a
  commit retry gets `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`. It reaches `failed`, `expired`, or
  `rolled_back` only in three ways, each before `Commit` is emitted or after the adapter proved
  that COMMIT did not apply:
  - the deadline check of the step that consumes `Persisted` for `committing`;
  - a `PersistFailed` for `committing` (see [Effect contract](#effect-execution-contract));
  - `CommitFailed { class: not_committed }`.

  Even then the new phase becomes current, and is answered to anyone, only after it has been
  persisted.
- **Phases change in memory only after they are persisted, when the change is a rejection.**
  When core moves a transaction to `failed`, `expired`, or `rolled_back` after it emitted
  `Persist(committing)`, it emits `Persist` for the new phase and replies only on `Persisted`. If that `Persist`
  fails too, core emits `Reset` (below): the owner replies `POLICYSQL_INTERNAL`, drops its
  in-memory state, and answers the next event from the store as a successor would. The store
  then holds either the previous phase or `committing`. Either way, a same-owner retry and a
  successor give the same answer, and that answer is never a definite rejection of a COMMIT that
  may have been sent.
- **A client or validator event that is invalid** gets the client-facing codes of today, and
  ADR 0007's rule that a conflicting command fails and rolls back an active transaction.
- **A Rust invariant violation inside a transition** is handled like invalid volatile state: as
  `Abandon` applied to the readable durable state (`committing` becomes `commit_unknown`), or
  as `discarded` when the durable state itself fails validation. Clippy already denies `panic`,
  `unwrap`, and `expect`.

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

The store is platform-trusted. `OwnerStore` is already a wrapper-supplied port (ADR 0022), so
this is a property every adapter must have now, and no conformance test can observe it. This ADR
therefore adds it to the `TransactionOwner` port obligations in ADR 0022, and pull request 4 adds
it to the port's documentation in `src/transaction-owner-port.ts`: **an owner's store is
readable and writable only by the live owner of that name, through the adapter.** The Durable
Objects adapter keeps it with storage that only the object can reach. Whoever can write it can also
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

The residual exposure is a forged `last`, which only someone who can write the store can plant.
It is returned on an exact retry without re-validation, so it can (1) answer a repeated
statement with arbitrary rows that never passed the policy or result validation, and (2) answer
a repeated commit of a transaction that rolled back with `committed`. It cannot execute SQL,
widen a later command's session, skip a commit check, or commit anything. A MAC would cost a key in `PolicySqlConfig`, key ids and
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
   releases handles, and lets the database adapter close the connection. On `Reset` the engine
   closes any connection, drops its in-memory durable and volatile state, and reads the durable
   state from the store for the next event, as a successor would.

What each failure leads to (all decided by core, listed here because ADR 0007 depends on them):

| Failure | Outcome |
| --- | --- |
| `OpenFailed`, `ExecuteFailed`, `BindingCheckFailed`, or binding not allowed | roll back if open, phase `failed`, reply with the class's code (`DATABASE_TIMEOUT`, `DATABASE_UNAVAILABLE`, `DATABASE_BINDING_REJECTED`, as today) |
| `PersistFailed` for a phase before `committing` (`active`, `validating`) | roll back, emit `Persist(failed)`; on `Persisted` reply `POLICYSQL_INTERNAL`, on `PersistFailed` `Reset` and reply `POLICYSQL_INTERNAL`; no commit is sent |
| `PersistFailed` for `committing` | COMMIT was never sent; the store may hold `committing` or the earlier phase. Roll back and emit `Persist(failed)`. On `Persisted` the phase becomes `failed`, and the commit gets `POLICYSQL_INTERNAL` (later retries get `POLICYSQL_TRANSACTION_UNAVAILABLE` from the persisted `failed`, true because COMMIT was never sent). On `PersistFailed`: `Reset`, reply `POLICYSQL_INTERNAL`. The next event then sees the store's `committing` (outcome unknown) or the earlier phase without a connection (unavailable), from this owner and a successor alike |
| `PersistFailed` for `expired` after the deadline check | COMMIT was never sent and the rollback is already emitted. `Reset` and reply `POLICYSQL_INTERNAL` (not the definite `POLICYSQL_TRANSACTION_UNAVAILABLE`). The store still holds `committing`, so a retry gets `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` from this owner and a successor alike |
| `Persisted` for `committing` arrives at or after `expires_at_ms` | the consuming step does not emit `Commit`: it rolls back, persists `expired`, and only then replies `POLICYSQL_TRANSACTION_UNAVAILABLE` (true: COMMIT was never sent). If the owner is lost before `expired` is persisted, a successor finds `committing` and answers a retry with outcome-unknown, which is not a misreport. Before the deadline it emits `Commit`, and from then on nothing expires the transaction |
| `PersistFailed` of the terminal record after `Committed` | reply committed (true); a retry finds `committing` and gets `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`, never a rejection |
| `CommitFailed { class: not_committed }` | phase `failed`, reply as today (`status: "failed"`) |
| `CommitFailed` of any other class | phase `commit_unknown`; the reply and every exact retry of that commit get `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` |
| `ValidatorFailed`, deny, malformed decision | roll back, `POLICYSQL_COMMIT_CHECK_REJECTED` |
| `TimerFired` while `validating` | phase `expired`, reply `POLICYSQL_COMMIT_CHECK_REJECTED` to the waiting commit now, roll back (deferred via `rollback_requested` if a callback query holds the connection); the late validator outcome is ignored |
| `TimerFired` while `committing`, or `Committed` after the deadline | nothing expires; the commit is already sent and its outcome decides |
| Interactive successor finds `active` | phase `failed`, `POLICYSQL_TRANSACTION_UNAVAILABLE` (true: commit is never sent without `committing` persisted first) |
| Interactive successor finds `validating` | stays `validating` until the timer expires it (ADR 0022); commands get `POLICYSQL_TRANSACTION_UNAVAILABLE` |
| Interactive successor finds `committing` | phase `commit_unknown`; a commit gets `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`, other commands `POLICYSQL_TRANSACTION_UNAVAILABLE` |
| Atomic owner finds any earlier phase | ignored; the request starts from the idempotency lookup |
| Unreadable or old-format record | discarded as under [Fail-closed rules](#fail-closed-rules) |
| `RollbackFailed` | phase stays terminal as decided; the database deadline ends the server transaction, and no commit is sent |

So: a commit outcome is reported as committed only after `Committed`, as rejected only when no
`Commit` was sent or the adapter proved it did not apply, and as unknown otherwise; exact
retry of every completed command replays `last`; owner loss fails closed; and expiry ends a
commit that waits on a validator.

### `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`

A new public code, HTTP 503, message "The commit outcome is unknown." It means that COMMIT may
have been sent and PolicySQL cannot tell whether it applied. Core returns it for a commit in
phase `commit_unknown`, for a commit that an interactive successor finds `committing`, and for a
commit against a discarded record. It is never returned for `execute`: an atomic request
resolves through the idempotency row or, unkeyed, is reported with the error of the failure as
today.

- The client library must treat it as outcome-unknown, never as a rejection:
  `packages/client/protocol.js` does not list it in `REJECTIONS`, so `sendCommand` raises
  `PolicySqlOutcomeUnknownError`, and Kysely's rollback-on-error path must not send a rollback
  that contradicts the unresolved commit (ADR 0007). Client tests assert both.
- It is added by #48, the TypeScript fix of inconsistency 3 that ships ahead of stage 4: to the
  library table in `website/api/errors.md`, to `src/http/status.ts`, to the HTTP conformance
  suite (`src/http/conformance.ts`), and to the client tests (`packages/client`,
  `packages/kysely`). The ADR 0023 table test then requires that the code is returned somewhere
  and appears in exactly one table. From pull request 7, core returns it.

### ABI impact and rollout

- **ABI 5.** `ABI_VERSION` goes from 4 to 5 in the first pull request that changes the ABI
  surface; each later pull request that changes the ABI bumps it again. Under
  [ADR 0025](0025-core-defined-canonical-json.md), that first pull request is ADR 0025's
  follow-up (it changes values `identity_json` returns, and bumped to 5), and pull request 4,
  which adds `step_json`, bumps to 6. The snapshot is
  `{profile}:{schema}:{policy}:abi-{ABI_VERSION}` (`crates/policysql-wasm/src/lib.rs` 382), so it
  changes on the deployments of those pull requests, not necessarily on the switch-over
  deployments (pull requests 7 and 8). Pull request 2 adds the `identity_json` method without a
  bump: no existing method, value, or limit changes, the engine and the module ship in one
  bundle, and keeping the snapshot is what keeps the hashes equal across that deployment.
  Pull request 3 is additive for the same reasons and does not bump either: the fields it adds
  to `RuntimeLimits` (`transaction_ms`, `max_transaction_statements`,
  `max_transaction_result_bytes`, `max_callback_rows`, `begin_timeout_ms`, `cost_timeout_ms`)
  are optional with defaults equal to the constants they replace, so every existing limits
  JSON is accepted and enforced exactly as before, and the new `limits_json` method only
  reports values. Limits were never part of the snapshot, so a later change of a configured
  limit does not change it either. (Decided in pull request 3; it was planned as the bump.)
  Pull request 5 bumps to 7: it changes what `step_json` returns for existing inputs (a commit
  whose mutations trigger a check now emits `callValidator` instead of a rejection, and a
  `callbackQuery` input is served instead of answered unavailable), which is the rule ADR 0025
  applied to `identity_json`. Nothing in production calls `step_json` yet, so the deployment
  is one more snapshot change.
  Pull request 6 bumps to 8 by the same rule: an `atomic` owner input is executed instead of
  answered `POLICYSQL_INTERNAL`, a `request` event is accepted with no owner in the host facts,
  `execute.trace` carries the execution trace, and the `observe` context changes shape. The new
  `cost_estimate_json` method alone would not have needed a bump (the rule of pull request 2).
- **In-flight transactions** do not survive any deployment: owners restart, so their
  connections are gone, and they fail closed as today.
- **Keyed atomic retries across a snapshot change** get `POLICYSQL_IDEMPOTENCY_CONFLICT`,
  because the fingerprint includes the binding's snapshot (ADR 0014). This is today's behavior
  for every snapshot change and is unchanged by this ADR.
- **Where byte-equal hashing is load-bearing.** (Superseded by
  [ADR 0025](0025-core-defined-canonical-json.md), which drops byte equality with TypeScript
  and states the stability requirements for `keyHash`, the auth and start fingerprints, and
  the `{sequence}` digests; kept as the record of pull request 2.) `keyHash` must equal what `idempotency.ts`
  computes on every deployment that changes who computes it (pull requests 2, 7, and 8). It does
  not include the snapshot, so a different `keyHash` finds no row and executes a committed keyed
  request again. The fingerprints and the command digest must be equal on those deployments
  whenever the snapshot is unchanged (always for pull request 2, and for pull requests 7 and 8
  unless they bump the ABI): a different fingerprint turns a committed keyed retry into a false
  `POLICYSQL_IDEMPOTENCY_CONFLICT`, which the client takes as a definite rejection. Core
  canonicalizes from the body text with its own tokenizer, not through `serde_json` values or a
  JavaScript string: object keys sorted by UTF-16 code units, string values decoded to UTF-16
  code units and escaped exactly as `JSON.stringify` escapes them, and numbers parsed as IEEE
  doubles and printed by the ECMAScript `Number::toString` algorithm. The text crosses the
  wasm-bindgen boundary as well-formed UTF-8 (ADR 0023), so an escaped lone surrogate in it
  (`"\ud800"` as six ASCII characters) arrives intact, whereas a decoded JavaScript string with
  a lone surrogate would be replaced by U+FFFD. Pull request 2 states the corpus and the gate.
- **Old-format records are discarded, not read.** From the switch-over (pull request 7), every
  record written by `TransactionOwnerCore` is unreadable: a commit retry gets
  `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`, other interactive commands
  `POLICYSQL_TRANSACTION_UNAVAILABLE`, and a keyed atomic retry resolves through the idempotency
  lookup (see [Fail-closed rules](#fail-closed-rules)). This is a **one-time incompatibility**,
  accepted while PolicySQL is in beta (ADR 0019): exact retries of commands completed before the
  switch-over are no longer replayed (a statement or rollback retry is unavailable; a commit
  retry is outcome-unknown, even when the transaction rolled back), and no compatibility layer
  or migration guide is provided. ADR 0007 still holds across it, because no commit retry is
  answered with a definite rejection.
- The Durable Objects class name and storage key stay; the value's shape is discriminated by `v`.
  The internal owner wire (ADR 0022, ADR 0023) keeps its paths; the forwarded inputs become the
  `Forwarded` event's JSON.

## Migration

Every pull request keeps `just fmt lint test coverage`, `cd deploy/cloudflare && npm run verify`
(both owner adapters), `npm run docs:build`, and the real-environment smoke
(`deploy/cloudflare/scripts/provision-dev.mjs`) green, and is mergeable on its own.

Ahead of stage 4, **#48** fixes inconsistency 3 in today's TypeScript owner: `terminal()`
persists `status: "committing"` before COMMIT, and a commit retry in the unsafe windows gets
`POLICYSQL_COMMIT_OUTCOME_UNKNOWN`, which #48 adds to the status table, the specification, and
the client. #48 is a separate pull request and not part of this sequence. Its records, including
`committing`, have no `v` and are the old format at the switch-over in pull request 7, so the
discard rule answers a commit against any of them with `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`. That
is the answer #48 gives for its own `committing` record and for its unsafe windows, so clients
see no regression at the switch-over. For a commit that #48 could still replay from a matching
`last`, the answer becomes outcome-unknown (the one-time incompatibility above).

1. **This ADR.** Design only.
2. **Canonical JSON, hashing, and identities in core.** `policysql-transaction` with
   `stable_json`, SHA-256 (the `sha2` crate), key syntax, `keyHash`, fingerprints, digest;
   exported as `identity_json`. The engine uses core's result; `idempotency.ts` stays as the
   second computation of the gate below until ADR 0025's follow-up removes the gate and that
   computation (ADR 0025 supersedes the corpus, randomized test, and gate items below). No
   behavior change. (ADR 0025's follow-up has removed `identity.ts` and `idempotency.ts`;
   `core-identity.ts` calls `identity_json`, and `stable_json` is now `canonical_json`.)
   - **Corpus** (each case also as an object key, a nested value, and an array element):
     integers above 2^53 (`9007199254740993`, which JavaScript rounds), `-0` (printed `0`),
     overflow (`1e400` parses to Infinity, which `JSON.stringify` prints as `null`), number
     spellings (`1.0` → `1`, `1E5` → `100000`, `1e21` → `1e+21`, `1e-7` → `1e-7`, `0.1`,
     `5e-324`), escapes (control characters, U+2028, `\/`, `\"`), escaped lone surrogates
     (`"\ud800"`), astral keys sorted against BMP keys above U+E000, and deep nesting. As a
     negative case, an identity value that is `undefined` (which `stableJson` prints as
     `undefined`): core rejects it before hashing, and the test asserts that every identity
     field reaching the hash is a string.
   - **Randomized test**: generated JSON texts compared between `stableJson` + `sha256` and
     `identity_json`, in `npm run verify`.
   - **Risk and gate.** If the hashes differ while the snapshot is unchanged, a committed keyed
     retry gets a false `POLICYSQL_IDEMPOTENCY_CONFLICT` (a definite rejection) or, with a
     different `keyHash`, executes again. Until pull request 9 (under ADR 0025, until its follow-up) the engine computes both and
     compares them before any database work; a mismatch logs `identity_mismatch` (no values) and
     fails the request with `POLICYSQL_INTERNAL` (500, which the client treats as uncertain). A
     mismatch is therefore an availability fault, never a wrong retry decision.
3. **Limits into runtime configuration.** Extend `RuntimeLimits` and `createRuntimeFactory`;
   `transaction-owner.ts`, `commit-checks.ts`, `cost.ts`, and `presenters.ts` read the runtime.
   Defaults equal today's constants. `publicConfig.limits` and the `LIMITS` merge in
   `presenters.ts` are removed, so Capabilities advertises exactly the enforced values. The
   runtime reports the effective limits and the fixed protocol constants core enforces through
   `limits_json`; the new fields are optional, so this needs no ABI bump (see
   [ABI impact](#abi-impact-and-rollout)). The fields and their ranges are listed in
   `docs/configuration.md`.
4. **The machine for interactive transactions, unused.** `TxState`, `TxEvent`, `Effect`,
   `HostFacts`, `step` for begin, statement, commit, rollback, expiry, and owner loss, without
   commit checks; `step_json` (ABI 6, after ADR 0025's bump to 5); property tests. A test-only `StepOwnerCore` (an effect
   executor) and a **differential harness** run every `transaction-owner` and conformance
   scenario through both `TransactionOwnerCore` and `StepOwnerCore` with the same fake clock,
   database, and store, and assert equal replies, database calls (SQL and arguments), terminal
   records, and log events, except the differences listed in this ADR, each named in an
   allowlist with its reason. Transcript fixtures cover both windows of inconsistency 3, the
   failed terminal `put`, and the expiry race of inconsistency 6. The owner-private store
   obligation is added to the port documentation.
5. **Commit checks and callbacks in the machine.** Capability, validator payload and verdict,
   callback queries, expiry during validation; extend the harness and the property tests.
6. **Atomic execution in the machine.** Direct and owner placements, idempotency lookup, replay,
   insert, cumulative limits, response shape, execution trace; `cost_estimate_json`. Harness
   covers `turso.test.mjs`, `execute-egress.test.mjs`, `idempotency.test.mjs`, and
   `cost.test.mjs` scenarios.
7. **Switch interactive transactions.** `TransactionOwnerCore` becomes the effect executor for
   `interactive`; `engine.ts` begin and commands run the `request` kind; old-format records are
   discarded, including #48's `committing` records. The TypeScript decision path remains only as
   the harness's reference. Smoke.
8. **Switch atomic execution.** `engine.ts` execute and the owner's atomic input run the
   machine. Smoke.
9. **Delete.** The TypeScript decision code: the decision parts of `transaction-owner.ts`,
   `commit-checks.ts` (except what the hook adapter needs), the decision parts
   of `turso.ts` (`executeSealedEnvelope`, `executeSealedOnTransaction`,
   `enforceCumulativeLimits`, result shaping), `cost.ts` `evaluate` and
   `estimateSealedOnTransaction`, `driverArgs`' namespace check; the differential harness (the transcripts replace it).
   The identity gate and the identity computation in `idempotency.ts` are not deleted here:
   ADR 0025's follow-up removed them earlier. Its `stableJson` and `sha256` helpers moved next
   to their only callers (`database.ts`, `commit-checks.ts`) and are deleted only when no
   TypeScript caller remains (ADR 0025). In Rust:
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
  - at most one `Commit` per interactive transaction, ever, and per atomic owner execution (one
    database transaction; a keyed retry is a new execution whose duplicate the idempotency row
    prevents); none after a terminal phase, none when `now_ms` in the step that would emit it is
    at or after `expires_at_ms`, none without every triggered check allowed in the current
    volatile state, and none without a `BindingChecked { allowed: true }` after the last
    validator; for interactive transactions, none without a preceding `Persisted` for
    `committing` (atomic owner executions never persist `committing`);
  - once `Commit` has been emitted for an interactive transaction, no event sequence (duplicated,
    stale, or reordered outcomes, `Abandon`, invalid volatile state, owner loss, `TimerFired`)
    leads to a definite rejection of that commit or to phase `failed`, `expired`, or
    `rolled_back`, except through `CommitFailed { class: not_committed }`; once
    `Persist(committing)` has been emitted, whether it succeeded or failed, a definite rejection
    of that commit is possible only if `Commit` was never emitted and the rejecting state
    (`failed` or `expired`) was persisted (`Persisted` observed) before the reply, and a
    same-owner retry after `Reset` gets the same answer as a successor;
  - a reply says committed only after `Committed`, and after `Committed` no reply says expired,
    failed, or rolled back;
  - a reply is a definite rejection of a commit only if (no `Commit` was emitted and the
    rejecting state is persisted) or the outcome was `not_committed`;
  - duplicated, reordered, and stale outcome events never produce `Commit`, and never panic;
  - `TimerFired` injected before or after any event leaves no `Commit` unless one was already
    emitted;
  - a second commit with the same digest replays, with a different payload conflicts;
  - tampered durable state (byte mutations of valid states, field mutations, other owners'
    states, old-format records) is either discarded by the fail-closed rule or behaves as some
    valid state; it never yields a `Commit` that the untampered state would not, and a commit
    against a discarded record always gets `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`;
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
- ADR 0007 is kept in places where it is not today: a failure between COMMIT and the terminal
  record, an expiry during COMMIT, and a commit transport error are reported as
  `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` rather than as a rejection or `failed`.
- One-time beta incompatibility at the switch-over: records written before it are discarded.
- Clients see `POLICYSQL_IDEMPOTENCY_CONFLICT` from both atomic paths, and a commit that expires
  on its validator is answered at expiry.
- Costs: a new crate and ABI method, a new public code, `sha2`, `proptest`, and a scheduled
  `cargo fuzz` job (all approved for this stage), a WASM call per effect outcome, and durable
  writes at `committing` in addition to the terminal write.

## Implementation notes

Recorded by pull request 4 (ABI 6), which adds the machine for `kind: interactive` on an
owner (`crates/policysql-transaction/src/machine/`) and `step_json`; no production path calls
it yet.

- **ABI.** `step_json(durable, volatile, event, host)` returns `durable` and `volatile` as JSON
  *texts* (`{"durable": string|null, "volatile": string|null, "effects": [...]}`), which the
  engine keeps and stores verbatim, so a recorded response keeps its exact bytes (a
  JavaScript round trip would round integers beyond 2^53). `Open` carries the pinned binding
  the engine connects to. `Execute.trace` is `null` until pull request 6.
- **Forwarded input.** An owner event is `{"type":"forwarded","input":{"kind",...}}`.
  `statement`, `commit`, and `rollback` carry `auth` (the canonical session) and `command`, the
  verified body text: compile builds its envelope from the text's raw members and the digest
  is computed from the text (#70). Core computes the auth fingerprint and the replay identity
  itself (`sha256(canonical({replay:"v1", principal, subject, role, session, database}))`, the
  binding without `snapshot`); `begin` takes `startFingerprint` from the engine until the
  `request` kind (pull request 7). `atomic` is answered with `POLICYSQL_INTERNAL`, without
  effects, until pull request 6. (`callbackQuery` was answered unavailable until pull
  request 5; see its notes below.)
- **Commit checks.** `Compiler::triggered_checks` recomputes the checks from the recorded
  mutations. (In pull request 4 any triggered check rejected the commit; pull request 5 runs
  them.) `validating` records are read and handled by the successor rules (commands
  unavailable, the timer expires them).
- **Order of checks for a command.** Shape, then the record and the replay identity, then an
  exact retry (replayed from `last`), then `committing`/`commit_unknown` (a commit at the
  committing sequence is outcome-unknown, any other command unavailable), then the snapshot,
  liveness and expiry, the sequence, and only then `CheckBinding` before work. A commit has one
  binding check, before `Persist(committing)`; `TransactionOwnerCore` checks twice.
- **Effect ids** of a new volatile part start from host entropy, so an outcome addressed to an
  effect of an earlier incarnation (after `Reset`) cannot match a new one.
- **Fail closed.** A fault inside a transition, an outcome that is not pending, or invalid
  volatile state replies `POLICYSQL_INTERNAL` (or `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` for a
  commit after `Persist(committing)`), persists `failed`/`commit_unknown`, then `Reset`. The
  handles of an invalid volatile part are released when its `handles` member still reads.
  `Abandon` does not reply; the engine answers the waiting request itself.
- **Bounds.** Runtime construction rejects limits for which `durable_bound_holds` fails (the
  last reply, one mutation per statement of the longest resource name, and the deployment
  strings must fit 96 KiB; `docs/configuration.md`). A transition that would still exceed a
  bound closes the transaction with `POLICYSQL_TRANSACTION_LIMIT_EXCEEDED`.
- **`RollbackFailed`** of a rollback command keeps `rolled_back` (the decided phase), as the
  failure table says; `TransactionOwnerCore` reports `failed`. `rolled_back` (and `expired` or
  `failed` after a failed rollback) means that the transaction will never be committed, not
  that the server confirmed the rollback: the server transaction and its locks may persist
  until the database deadline ends it.
- **A statement whose completion cannot be stored** moves to `failed` from the record before
  the statement (the task keeps that record), so a retry of the statement gets
  `POLICYSQL_TRANSACTION_UNAVAILABLE` from this owner and a successor alike, never the
  statement's reply for a transaction that failed.
- **ADR 0007's retry rules** are amended for the machine (ADR 0007, "Retry rules of the step
  machine"): exact retries of every command are answered before the snapshot and liveness
  checks, matched by the replay identity (principal, subject, role, session, and the binding
  without its snapshot, so another caller or database is still rejected), and there is no
  in-memory re-recording of a terminal record whose put failed (`Reset`, then outcome-unknown,
  as a successor answers).
- **Obligation for the production executor (pull request 7).** `Reset` and the fail-closed
  path emit no `Rollback` effect: the engine must close the database connection it holds when
  it runs `Reset` (and on `Abandon`), and drop every reference to it. The test executor
  (`test/helpers/step-owner.mjs`) does this; `TransactionOwnerCore`'s successor inherits it at
  the switch-over.
- **Tests.** Property tests (`tests/properties.rs`, proptest), transcripts of inconsistencies
  3, 4, and 6, the deadline after `committing`, #70, and old-format records
  (`tests/fixtures/transactions/`, replayed byte for byte by `tests/transcripts.rs`), and the
  differential harness (`deploy/cloudflare/test/step-differential.test.mjs`) with its
  allowlist. The `cargo fuzz` targets are not part of this pull request; a property test feeds
  arbitrary strings for all four inputs in the meantime.
- **Not yet in the engine's codec.** The test executor passes integers beyond 2^53 − 1 from
  the step output as `BigInt`; `TursoHttpTransport` does not encode `BigInt` yet, which the
  switch-over (pull request 7) adds.

Recorded by pull request 5 (ABI 7), which adds commit checks and callbacks to the machine
(`crates/policysql-transaction/src/machine/step/checks.rs`); no production path calls it yet.

- **Flow.** A commit whose recorded mutations trigger checks (`Compiler::triggered_checks`, by
  ascending id, with each check's callback role and `hook.timeout_ms`; the machine sorts and
  deduplicates them itself, so the order does not rest on the compiler) checks the binding,
  then requires every triggered id in `HostFacts.configuredChecks` (the ids with an endpoint,
  empty without `publicBaseUrl`); a missing one logs `commit_check_unconfigured` and rejects
  with `POLICYSQL_COMMIT_CHECK_REJECTED` before any capability or validator call (ADR 0021). It
  then persists `validating` and, for each check in turn, issues a capability and emits
  `CallValidator`. After the last allow it checks the binding again (the property "a
  `BindingChecked { allowed: true }` after the last validator") and continues to `committing`
  with `meta.commitChecks: "passed"`. `TransactionOwnerCore` persists `active` between checks;
  the machine stays `validating` until `committing`, which no successor rule distinguishes.
- **Effect and events.** `callValidator { id, check, payload, capability: { token, expiresAtMs },
  timeoutMs }`; `payload` is the hook body without `query`, in the wire order of today
  (`version`, `validationId`, `check`, `requestId` of the commit, `policyVersion`,
  `schemaVersion`, `role`, `session`, `statements`). `statements` lists every recorded mutation
  with its position as `index` (the synthetic `affectedRows: 1` rule), as today. The hook
  adapter adds `query` and signs, so the HMAC inputs are unchanged. The outcome is
  `validatorReplied { id, ok, decision }` (`ok`: 2xx; `decision`: the JSON body or `null`) or
  `validatorFailed { id, class }`. Only an exact decision (`commit-checks.ts` `exactDecision`)
  with `allowed: true` and `ok` allows; anything else rejects before COMMIT.
- **Capability.** The token is the base64url form of all 32 entropy bytes of the step that
  issues it; that step never seeds a volatile part (a commit has an open connection), so no
  bytes are reused. Only its SHA-256 is kept, in volatile state (`capability.tokenHash`); the
  token appears only in the `callValidator` effect. It expires at
  `min(now + timeout, expiresAtMs)`; a check whose capability would already be expired rejects.
  It is revoked at the verdict, at an expiry, and by any close; a callback query in progress
  continues only while the capability that authorized it (by token hash) is the live one. The
  TypeScript `sha256` in `commit-checks.ts` stays for `TransactionOwnerCore` until pull
  request 9 deletes that path.
- **Callback queries.** The forwarded input is `{kind: "callbackQuery", validationId,
  capability, command}`, where `command` is the verified body text (#70): compile builds the
  envelope from its raw members and the digest is `sha256(canonical(command))` of the text.
  Order: the validation id must name this owner; with no live capability (no validation
  running, a successor, after the verdict) the reply is `POLICYSQL_TRANSACTION_UNAVAILABLE` and
  nothing changes. Otherwise the token (syntax, expiry, constant-time hash comparison), the
  command shape (exactly `sequence`, `sql`, `params`), the snapshot, and the deadline are
  checked; an exact retry is replayed; then the sequence (the next one, at most
  `max_transaction_statements`), the compile under the callback session (the commit's session
  with the check's role, that role added to `roles`, `access: ["execute"]`), one read-only
  statement, `CheckBinding` (deadline `min(expiresAtMs, capability expiry)`), `Execute`, result
  validation, and the cumulative `max_callback_rows` and `max_transaction_result_bytes`. Any
  failure after the capability is found ends the open transaction (rollback, `failed`) and
  answers the waiting commit `POLICYSQL_COMMIT_CHECK_REJECTED` at once, not when the validator
  returns; its late verdict is logged and ignored (`revokedValidator`).
- **Lanes.** Volatile state gains the callback lane (`callback`: its pending effect, request id,
  token hash, and task), `capability`, `deferred`, and `revokedValidator`, all omitted when
  empty, so the volatile texts of pull request 4's transcripts are unchanged. The client lane
  awaits `CallValidator` (not on the connection) while the callback lane may hold the
  connection with `Execute`; a verdict that arrives meanwhile is kept as `deferred` and runs
  when that `Execute` returns (whose rows are then not returned: the capability was revoked).
- **Expiry while validating.** `TimerFired` answers the waiting commit
  `POLICYSQL_COMMIT_CHECK_REJECTED` in its own step, sets `expired` in memory (so commands are
  unavailable and the late verdict is ignored), and rolls back, after a callback query's
  `Execute` if one holds the connection, then persists `expired`. A timer during the `validating`
  persist or the binding check after the last verdict is deferred as for statements.
- **Differential harness.** The `commit-checks` allowlist entry is removed. New entries:
  `expiry-during-validator` (inconsistency 5) and `callback-without-validation` (a callback that
  reaches an owner with no live capability changes nothing; `TransactionOwnerCore` fails that
  owner's open transaction, so anyone holding the validation id of an active transaction
  could end it; ADR 0007 "Callback rules of the step machine" scopes its rollback rule to a
  running validation accordingly, and `docs/commit-checks.md` says the same; while a capability
  is live, a malformed or wrong token still rolls back, as today. The fix for #73 aligned the
  TypeScript owner and removed that entry; the harness now asserts that both sides answer such a
  callback `POLICYSQL_TRANSACTION_UNAVAILABLE`, make no database call, and commit afterwards), and `loss-between-checks` (the machine writes nothing between checks, so an
  owner lost during one check still calls the next validator before its `Persist(committing)`
  fails; no COMMIT either way, and both answer `POLICYSQL_INTERNAL`). The harness compares validator calls (the signed hook body with the token
  masked, and the signature) and callback replies as well, and adds generated commit-check
  sequences with random validator scripts.
- **Obligations for the production executor (pull request 7).** Run `callValidator` through
  `callCommitCheckHook` with the endpoint and secret looked up by `check` in the validated
  configuration (re-checking the URL and secret at the exit, `rejected` when that fails), map
  a timeout to `timeout` and any other failure to `unavailable`, supply `configuredChecks` from
  the configuration, and serialize the callback lane as today. The payload may carry
  integers beyond 2^53 − 1 in `session`; the hook adapter must not round them (today's
  `JSON.parse` of the session rounds them already).
- **Tests.** `tests/commit_checks.rs` (scenarios), `tests/check_properties.rs` (proptest over
  one or two triggered checks: at most one COMMIT; validators called once each in ascending id
  order, the next only after the previous allowed; stale verdicts never advance; COMMIT only
  after every check was called and allowed and a binding check after the last allow; a
  callback executes only with the live capability before its verdict; callback rows within the
  limit; one effect on the connection at a time; determinism), transcripts of an
  allowed check with callbacks, a deny, a validator timeout and transport error, owner loss and
  expiry while validating, a late verdict after expiry, a callback after revocation, callback
  limit exhaustion, and capability tampering, and `step_tests.rs` in `policysql-wasm` with the
  real compiler.

Recorded by pull request 6 (ABI 8), which adds atomic execution to the machine
(`crates/policysql-transaction/src/machine/step/atomic.rs`) and `cost_estimate_json`
(`crates/policysql-transaction/src/cost.rs`); no production path calls either yet (pull request 8
switches atomic execution).

- **The `request` kind of `execute`.** The engine-side entry point is
  `{"type":"request","operation":{"kind":"execute", auth, databaseBinding, snapshot, bodyText,
  idempotencyKey?, trace}}` with `owner: null` in the host facts (the engine holds no durable
  state; a durable text with no owner is `{"error":…}`). `auth` is the canonical session the engine
  authorized, `bodyText` the verified body text (#70: compile and the idempotency fingerprint
  use it, never a re-serialization), `trace` whether the deployment records execution traces.
  The step checks the binding (`CheckBinding`), compiles, computes the idempotency identity of a
  write envelope (a read ignores the key, as today; a malformed key is
  `POLICYSQL_IDEMPOTENCY_KEY_REQUIRED`), and, when a mutated resource could trigger a commit check
  (`Compiler::triggered_checks`), releases the plan and emits `Forward { owner: tx_<hex>, lane:
  "client", input }`, where `hex` is the key hash's first 32 digits or entropy bytes 16..32 (the
  bytes that seed effect ids are 0..6). `OwnerReplied` is relayed after a shape check (an
  unexpected shape is `POLICYSQL_INTERNAL` and logs `owner_reply_rejected`); `ForwardFailed` is
  `POLICYSQL_INTERNAL`. Every other envelope runs in the engine with placement `direct`. The
  `request` kind of interactive commands remains pull request 7.
- **The owner's input** is `{kind: "atomic", validationId, auth, request, databaseBinding,
  snapshot, idempotency?}` (`request` is the verified text, as `OwnerAtomicInput` today). The
  validation id must name the owner and a key hash must start with the owner's hex; the snapshot
  must be the runtime's (`POLICYSQL_TRANSACTION_CONFLICT`, as `checkContext`); the owner placement
  runs write envelopes only (`POLICYSQL_INVALID_REQUEST`). Whatever the owner's record says, the
  input starts a fresh execution: an unreadable record is logged (`tx_state_discarded`) and
  replaced when the execution persists its own, a busy owner or one holding an interactive record
  answers `POLICYSQL_INTERNAL` (names never collide).
- **Order.** Direct: `CheckBinding`, `Open` (timeout and deadline from the strictest statement
  `timeoutMs`), the lookup (keyed writes), `Execute` of the envelope, the row (`INSERT`), `Commit`.
  Owner: `CheckBinding`, compile, `Open` (deadline `now + transaction_ms`, BEGIN timeout the
  strictest statement timeout), `Persist(active)`, `SetTimer`, the lookup, `Execute`, the commit
  checks of the statements that changed rows (reusing pull request 5's capability, validator,
  and callback rules; the hook payload lists them by envelope index, as `triggeredCommitChecks`
  does), `CheckBinding` again (with the snapshot, as `checkCurrent`), the row, `Commit`,
  `Persist(committed)`. The lookup's three outcomes are those of the failure table: one row with
  this fingerprint replays (rolled back; nothing executes; the owner records `committed`), one
  with another fingerprint is `POLICYSQL_IDEMPOTENCY_CONFLICT` on both placements, more than one
  row is `POLICYSQL_INTERNAL` on both (inconsistencies 1 and 2).
- **Atomic durable state** is `kind: atomic` with `atomic: {transactionId, keyHash?}` and only
  `active`, `committed`, `failed`, or `expired`: no reply, sequence, mutation, `validating`, or
  `committing`. The capability of a commit check is live while the record is `active` and the
  validator is awaited (an interactive commit requires `validating`). `TransactionOwnerCore`
  persists `validating` and `active` around each check; nothing reads either.
- **The stored record** (`response_json`) has one shape on both placements: the owner path's,
  `{version: 1, transactionId, status: "committed", results, usage, originalRequestId, replayed:
  false, commitChecks}`. It is read strictly (version 1, an array of results, an `atomic_`
  transaction id, a string request id, a usage object, `status` `committed`, `commitChecks`
  `passed` or `not_triggered`), except that `status` and `commitChecks` may be absent, which the
  rows of today's direct path are (they omit both); they read as `committed` and
  `not_triggered`, so a keyed retry across pull request 8 still replays. Transaction ids are
  today's: `atomic_<keyHash[0..24]>` keyed, `atomic_<requestId>` direct and
  `atomic_<validation hex>` on an owner unkeyed.
- **The reply** is the public `execute` response (`engine.ts` 352-370 and 392-409 move to core):
  `{transactionId, status: "committed", results, meta: {requestId, policyVersion, schemaVersion,
  role, commitChecks}, debug?}`; the owner replies it and the engine relays it. A replay names the
  stored request id and `commitChecks`. `debug.executionTrace` is present when tracing is enabled
  and the session has `debug` access, on the direct placement only (the owner path records no
  trace today, and still does not); the trace (`turso.ts` `executionTrace`, parameters sorted by an
  ASCII approximation of `localeCompare`) rides on the envelope's `Execute`, and the engine
  publishes it to the sink before running the statements.
- **Limits.** The envelope's results are validated statement by statement (a failed expectation
  or a schema mismatch rolls back), then the strictest statement `maxRows` and `maxResultBytes`
  apply to the whole envelope (`POLICYSQL_LIMIT_EXCEEDED`), counting `JSON.stringify` of the rows
  as objects with core's canonical numbers (an exponent spelling such as `1e21` can count one byte
  less than `1e+21`), and the strictest `timeoutMs` to `now_ms` minus the step that emitted `Open`
  (`POLICYSQL_TIMEOUT`; the transport's deadline usually ends a slow envelope first). Volatile
  state may hold the validated results until COMMIT, so its bound is 256 KiB plus four times the
  largest event.
- **COMMIT.** At most one `Commit` per execution, emitted only by the step that has every
  triggered check allowed and the binding checked after the last one, and on an owner only before
  its deadline (after it, or after a `TimerFired` that arrived during a database effect, the
  execution rolls back with `POLICYSQL_TRANSACTION_UNAVAILABLE`, as `checkCurrent` answers, and
  records `expired`; a `TimerFired` during a validator call answers `POLICYSQL_COMMIT_CHECK_REJECTED`
  at once, as for an interactive commit; a `TimerFired` while `Commit` is in flight is ignored).
  `Committed` replies the committed response, also when the owner's terminal record cannot be
  stored. `CommitFailed` rolls the connection back (as both TypeScript paths do) and answers by
  class: `timeout` `POLICYSQL_DATABASE_TIMEOUT`, `unavailable` `POLICYSQL_DATABASE_UNAVAILABLE`,
  anything else `POLICYSQL_INTERNAL`: none is a rejection in the client, so an unkeyed request is
  reported with the error of the failure as today and a keyed one resolves through its row.
- **Cost** stays observation ("Cost" above): nothing is admitted or rejected by it. `Observe`
  carries the cost statements of the non-insert statements and `context: {requestId, binding,
  statements: [{operation, resource?, explainResource}]}`, one entry per envelope statement (an
  interactive statement has one); the binding is the pinned one the cost connection uses (ADR
  0014). It is emitted after COMMIT, and for a direct replay, as `engine.ts` observes today.
  `TransactionOwnerCore` observes the owner path after the envelope, before its checks, so the
  harness does not compare owner-path observations. `cost_estimate_json({catalog, statements,
  results})` is `cost.ts` `evaluate`: bounds from the catalog only, plan rows counted (each must
  have a string `detail`), `POLICYSQL_COST_UNKNOWN`, `POLICYSQL_USAGE_BUDGET_EXCEEDED`, or
  `POLICYSQL_COST_ADMISSION_UNAVAILABLE` (more results than planned statements, or another
  shape); fewer results leave the remaining statements at their defaults, as `evaluate` does.
  `cost.ts` keeps its `evaluate` until pull request 9; the harness compares the two over the
  cases of `cost.test.mjs`.
- **Differential harness.** `deploy/cloudflare/test/step-atomic-differential.test.mjs` runs
  `execute` through `createEngine` (direct path and `TransactionOwnerCore` behind the in-memory
  port) and through `StepEngine` (`test/helpers/step-engine.mjs`) with `StepOwnerCore` owners,
  and compares results, database calls (the stored `response_json` as JSON), validator calls,
  callback replies, trace-sink calls, cost observations, and final rows. Allowlist:
  `idempotency-conflict-code` (inconsistency 1), `duplicate-idempotency-rows` (inconsistency 2),
  and `stored-record-shape` (core's direct-path record also carries `status` and `commitChecks`;
  normalized after asserting their values). Not exercised: `TransactionOwnerCore` answers a
  previous record of another binding or snapshot with `POLICYSQL_TRANSACTION_CONFLICT`, which core
  ignores (a keyed retry then gets `POLICYSQL_IDEMPOTENCY_CONFLICT` from its row, inconsistency 1),
  and owner timers during an atomic execution.
- **Tests.** `tests/atomic.rs` (scenarios on both placements), `tests/atomic_properties.rs`
  (proptest over effect outcomes, verdicts, timers, `Abandon`, and duplicated and stale outcomes:
  at most one COMMIT per execution; a keyed retry never executes twice; no definite rejection after
  COMMIT; a failed expectation never commits and stores nothing; every handle released;
  determinism), transcripts `atomic-direct-keyed-replay`, `atomic-expectation-rollback`,
  `atomic-commit-failure`, and `atomic-owner-commit-check`, and `step_tests.rs` in
  `policysql-wasm` with the real compiler (#70 digits, the trace). The one transcript of pull
  request 4 with an `observe` effect (`owner-loss-and-expiry`) was regenerated for its new
  context.
- **Obligations for the production executor (pull request 8).** Classify driver failures as
  `turso.ts` `remoteFailure` does on the direct placement (a query timeout is `timeout`, anything
  else `unavailable`); publish `execute.trace` to the sink before the statements; run `observe`
  in the background on a read connection named `${requestId}-cost` with the runtime's
  `costTimeoutMs` and log `cost_estimate_json`'s answer as `cost_observation` or
  `cost_observation_failed`; relay `forward` through the owner port's `atomic`.

## Decided during review

- **One place for limits.** `publicConfig.limits` is removed. Today `presenters.ts` (81) merges
  it over `LIMITS` for the capabilities response only, so an override changes what is
  advertised but not what is enforced. Limits are configured in exactly one place,
  `RuntimeLimits`, which the wrapper still sets, so they remain configurable. The
  interactive-transaction limits now hard-coded in `transaction-owner.ts` (4 s duration, 8
  statements, 64,000 result bytes, 100 callback rows) become `RuntimeLimits` fields, and
  Capabilities advertises exactly the enforced values. Pull request 3 implements this.
- The new code `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` (503), added by #48.
- #48 fixes the ADR 0007 violation of inconsistency 3 now, ahead of stage 4.
- A replay identity without the snapshot.
- The `sha2`, `proptest`, and `cargo fuzz` dependencies.
- Old-format records are discarded instead of read.

No questions remain open.
