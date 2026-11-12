# ADR 0031: Server time presets (`now`)

- Status: accepted
- Issues: #162
- Amends: [ADR 0006](0006-closed-policy-predicate-language.md) (a preset value may be `now: {}`),
  [ADR 0024](0024-transaction-step-machine.md) (`Compiler::compile` and `compile_json` take a
  per-request context; core still reads no clock)
- Related: [ADR 0007](0007-transaction-retry-and-commit-check-protocol.md),
  [ADR 0008](0008-catalog-and-client-type-contract.md),
  [ADR 0021](0021-explicit-engine-config.md), #163 (generated IDs), #167 (`now` in predicates)

## Context

A policy can set `created_by` from the trusted session but not `created_at` or `updated_at`. The
client could write them, which lets it forge the time, or the schema could default them in the
database, which `RETURNING` does not see for an UPDATE and which the policy cannot constrain.

Three workarounds are rejected:

- **A wrapper puts the time into the trusted session** and the policy writes `session: now`. The
  idempotency identity (ADR 0007) and the interactive replay identity (ADR 0024) include the
  session, so a value that changes with every request turns a retry into another request, and
  makes the next command of an interactive transaction fail the identity check. `session:` is also
  limited to `string` columns.
- **The database's `CURRENT_TIMESTAMP` or `strftime` in the emitted SQL.** The emitter writes
  parameters, never functions of the database's state, and the verifier compares the re-parsed
  statement with the emitted one; a time function in a protected statement would be a second way
  to produce a value the policy did not fix. The database's clock is also not the engine's.
- **A database trigger.** A trigger runs after the statement; `RETURNING` shows the pre-trigger
  row, so the client would see a different time from the stored one.

## Decision

| # | Decision |
|---|---|
| 1 | A preset value may be `now: {}`, in INSERT and UPDATE `presets`. In `filter`, `check`, `visible_if`, and `exists.where` activation rejects it (`UnsupportedCapability`); #167 may allow it there. |
| 2 | The time is the host fact `now_ms`: the `Date.now()` of the engine for a direct atomic execution, an explain, and a compile that decides whether to forward; of the transaction owner for what the owner compiles. Core reads no clock. |
| 3 | A compile takes a per-request context as a separate argument: `policysql_core::CompileContext` (`now_ms`, at most 9999-12-31T23:59:59.999Z), `policysql_transaction::machine::CompileFacts` for the machine, and the JSON object `{"nowMs": <integer>}` as the fourth argument of `compile_json` (#163 adds `entropy`). Any other member, a malformed value, or a time out of range is a 500 `POLICYSQL_INTERNAL` without detail: the value is the engine's, not the client's. `ABI_VERSION` is 25. The owner wire version stays `"6"`. |
| 4 | The shape comes from the column's Catalog type and format, fixed at activation: `instant`/`rfc3339` is `YYYY-MM-DDTHH:MM:SS.mmmZ`, `datetime`/`sqlite-datetime` is `YYYY-MM-DD HH:MM:SS` (milliseconds truncated, the form of `CURRENT_TIMESTAMP`), `int64` and `integer` are epoch milliseconds. Every other type or format is rejected with `IncompatibleOperand`: `string` is never guessed, and `date` would need a choice of time zone. A column with `constraints` is rejected too, because whether a constraint accepts a time depends on the time, and a compile that fails by the clock would let the clock into a keyed retry's "compile failure is an unknown outcome" rule (ADR 0007). The value of `now` is an empty mapping; there is no `now: { format: ... }`, because the Catalog already owns the format and the runtime Catalog cannot give a `string` column an `rfc3339` format. |
| 5 | Each shape has its own server parameter: `__policysql_now_rfc3339`, `__policysql_now_sqlite_datetime`, `__policysql_now_epoch_ms`. One name would make a `String` and an `Int64` fight over one key when a statement writes both an `instant` and an `int64` column. The namespace is disjoint from `__policysql_session_*` and `__policysql_literal_*`; a session key named `now` is `__policysql_session_now`. |
| 6 | One compile has one time. The gateway passes the same context to every statement of an envelope, and every row of a multi-row INSERT shares the parameter. An interactive transaction compiles each statement in its own request, so each statement has the time of its own request: the owner's record has no start time and is unchanged. Aligning the statements to the begin time is a follow-up. |
| 7 | Explain compiles with the real time and returns the parameter names, never the values. |
| 8 | After the policy crate, `compile_verified_insert` and `compile_verified_update` check, independently of it, that every assignment whose whole value is a `__policysql_now_*` parameter carries a value of the column's logical type that satisfies the Catalog contract (`emit.InvariantViolation` otherwise). The emitted SQL contains no time, so the re-parse comparison and the server parameter name set need no change. |

### Why the executed value and the returned value cannot differ

The client receives the `RETURNING` row the database wrote, so the returned time is the written
time. The two places where a different time could be compiled are these.

1. **A write that may trigger a commit check is compiled twice.** The engine compiles to decide
   where to run it, releases that handle before forwarding, and the forwarded input carries neither
   the plan nor the time. The owner compiles again with its own `Date.now()` and executes only its
   own handle.
2. **A keyed retry.** If the first attempt committed, the stored response (written in the same
   database transaction, ADR 0007) is returned and the retry's plan is never executed. The time is
   not part of the request fingerprint, so the same body never conflicts. If the first attempt did
   not commit, it left nothing, and the retry runs with a new time and returns that.

A compile cannot fail because of `now`: the shape and the absence of constraints are fixed at
activation, and a time out of range is refused as a host fact before any compile. An interactive
retry (same sequence, same digest) returns the recorded reply; the digest does not contain the
time.

## Consequences

- **Security model.** P2: a preset value is a session value, a policy literal, or the compile's
  time. P3: the time is visible through `RETURNING` when the policy returns the column, a function
  of a host fact the client cannot supply, so it adds no inference about rows. P5: the value is
  determined by the policy, the trusted session, and the compile's time.
- **Bypasses considered** (each tested): the client names `:__policysql_now_*` in its SQL
  (`POLICYSQL_RESERVED_PARAMETER`), passes it as a parameter (`POLICYSQL_INVALID_PARAMETER`),
  assigns a `now` column (`POLICYSQL_FORBIDDEN_COLUMN`), writes `nowMs` into the request body
  (`POLICYSQL_INVALID_REQUEST`), or forges the time through a header or a session claim (neither is
  read).
- **ABI 25.** `compile_json` has a fourth argument; the snapshot is `...:abi-25`. A Worker and an
  owner of different ABIs refuse each other with the skew rule of ADR 0024, before anything runs.
  The request fingerprint contains no snapshot, so a keyed write committed under ABI 24 still
  replays under 25.
- **Clocks.** The engine's and the owner's clocks are not synchronized and not monotonic: a row
  updated twice can go back in time. The documentation says so.
- **Resource bounds.** At most three more server parameters per statement, each at most 24 bytes;
  the existing host parameter bound applies.

## Rejected alternatives

- The database's `CURRENT_TIMESTAMP` or `strftime` in the emitted SQL.
- A trigger.
- A time in the trusted session.
- One parameter name `__policysql_now` for every shape.
- `now: { format: ... }`.
- The time in the request envelope's JSON: the envelope is the client's body, and `nowMs` there
  must stay an invalid request.
