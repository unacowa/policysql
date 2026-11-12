# ADR 0030: `error.detail` and database constraint violations

- Status: accepted
- Issues: #145, #144, #146
- Amends: [ADR 0007](0007-transaction-retry-and-commit-check-protocol.md) (what a COMMIT error is,
  and what a definite refusal may rest on),
  [ADR 0023](0023-operations-api-and-http-adapter.md) (the error shape),
  [ADR 0024](0024-transaction-step-machine.md) (outcome classes),
  [ADR 0027](0027-byte-and-cpu-budgets.md) (database error classification)
- Related: [ADR 0022](0022-transaction-owner-port.md) (owner wire version)

## Context

A statement the database refuses for a constraint (a duplicate in a UNIQUE column or primary
key, NOT NULL, FOREIGN KEY, CHECK, or a trigger's `RAISE`) is a definite refusal by the data,
not a fault of the service. PolicySQL answered it 503 `POLICYSQL_DATABASE_UNAVAILABLE`, which a
client treats as "outcome unknown" and retries, and which an operator reads as an outage. A
retry of the same request does not succeed unless the data changes (a parent row appears for a
foreign key, a duplicate row is deleted).

What real Turso sends (observed for #145): every kind of violation has the code
`SQLITE_CONSTRAINT`; the message is `SQLite error: ` followed by SQLite's text; a trigger's
`RAISE` also has the code `SQLITE_CONSTRAINT` and its message is the trigger's own string; no
extended code arrives. SQLite closes the transaction by itself for `ON CONFLICT ROLLBACK` and
`RAISE(ROLLBACK)`, and then Turso ends the stream (`baton: null`); for the default ABORT the
transaction stays open and the reply keeps its baton.

Since #144 the transport sends an envelope as one conditional batch: each step runs only if the
step before it succeeded, and the reply is checked to show that nothing after the first error
ran. A refusal in such a reply that kept its baton is a refusal of the last statement that ran,
inside a transaction that is still open.

## Decision

### 1. `error.detail`

An error may carry `detail`, placed between `path` and `requestId`. Its content is defined per
code in one table, and a value is an enumeration or a number fixed by that table. A string the
database, the parser, or a validator made, and an identifier, never go in it. The table has one
row today: `POLICYSQL_CONSTRAINT_VIOLATION` requires `{ "constraint": <kind> }`.

Each boundary that reads an error from another party checks `detail` against the table: core's
`owner_replied` (a forwarded owner reply), the engine's `checkedOwnerReply`, and the official
client, which only checks that it is a plain object so that it can carry the details of later
codes. A code outside the table with a `detail`, a code in the table without one, a key outside
the row, and a value outside its enumeration make the reply invalid (500 and `owner_reply_rejected`
for an owner reply, a protocol error for the client). The owner wire version is `"2"` for the
changed message shape.

### 2. No logic to produce an error

A code and its detail are values the failing place already knows, or a lookup in a table. Core
gets no new condition to decide whether a refusal is definite (a write after the failed
statement, whether a ROLLBACK succeeded). The conditional batch of #144 guarantees that nothing
runs after the first error, and the baton shows the transaction is open.

### 3. Classifying a database error

A 4xx is chosen by the exact code `SQLITE_CONSTRAINT` alone. An extended code
(`SQLITE_CONSTRAINT_UNIQUE`) is not classified. The kind is read from the text after the wrapper
`SQLite error: `: `UNIQUE constraint failed` (a PRIMARY KEY has the same text) is `unique`,
`NOT NULL constraint failed` is `not_null`, `FOREIGN KEY constraint failed` is `foreign_key`,
`CHECK constraint failed` is `check`. Anything else (a trigger's `RAISE`, a STRICT table's type
error, a missing wrapper, a message that is not a string) is `other`; the code and the status do
not change. The message is read only to classify. It is never logged, returned, or stored: SQLite's
text names tables, columns, and constraints, and a trigger's text is any string its author wrote.

### 4. Which replies may be a definite refusal

Only a statement batch step error of a reply that kept its baton and that `readBatch` checked
(steps before it executed, one error, nothing after it executed). Then the transport throws
`SqlConstraintError`. A reply that ended the stream stays `DatabaseStatementError` (503), as in
#144: it is no evidence that the statements ran inside a transaction. The difference is carried
by which exception the transport throws, and core sees only the class. The class `constraint` is
defined as the adapter's obligation: it may report it only when the transaction is open and
nothing after the failed statement ran. `SqlConstraintError` is not exported from the package: a
custom transport that threw it would take on that obligation, and documenting it is left for
later.

### 5. Where it is classified and where it is not

- A statement's execution, atomic or interactive: 409 `POLICYSQL_CONSTRAINT_VIOLATION`,
  `path` `/statements/<i>`.
- The idempotency lookup and insert: 500 `POLICYSQL_INTERNAL`.
- A commit-check callback query: 500 (a callback runs a SELECT only).
- COMMIT, BEGIN, ROLLBACK, and every event other than `executeFailed`: not classified.
- A deferred foreign key that fails at COMMIT: the outcome stays unknown (ADR 0007: an error
  result for COMMIT does not prove that it did not apply).

### 6. Interactive transactions

The transaction closes as `failed` and is rolled back. The next command is 409
`POLICYSQL_TRANSACTION_UNAVAILABLE`. A transaction cannot continue after a violation.

### 7. With an `Idempotency-Key`

The 409 means that this attempt committed nothing, and nothing was recorded for the key. A
resend after the record of an earlier, committed attempt expired (ADR 0028) can be refused as a
duplicate of the rows that attempt wrote; this has the same nature as `EXPECTATION_FAILED`, and
the key's retention period is the window in which a resend replays.

### 8. What is returned, what is only logged, what is never emitted

Returned: the index of the statement (in `path`) and the kind (one of five fixed values), with a
fixed message per kind. Only logged: the database's code. Never returned and never logged: the
database's text, a table, column, or constraint name, a trigger's text, the colliding values,
SQL, parameters.

### 9. Log

`database_constraint_violation` with `requestId`, `statementIndex`, `constraint`, `databaseCode`
(`[A-Z0-9_]{1,64}`, else `UNKNOWN`, or `null`), `schemaVersion`, `policyVersion`. It is written
only when the reply is a `POLICYSQL_CONSTRAINT_VIOLATION`. A constraint violation of the
idempotency lookup or insert, or of a callback query (500), is logged as
`database_error_unclassified` with the database's code only, as such a failure was before this
change, so an operator can trace a mismatched idempotency table; no new event and no new decision.

### 10. When Turso changes

If the text changes, a kind falls to `other`; the code and the status do not change, and the
release smoke (`smoke-constraint.mjs`) fails and stops the release. If Turso starts to send an
extended code, the refusal returns to 503 (the exact match of the code), and the smoke fails too.

## Consequences

- `Obs` (the security model) includes the kind of a constraint, one fixed value per refused
  statement.
- A schema with `ON CONFLICT ROLLBACK`, or a trigger with `RAISE(ROLLBACK)`, still answers 503: the
  stream ends, and nothing proves the transaction was open. Telling them apart needs the
  `is_autocommit` of Hrana 3 (#146).
- "A baton means the transaction is open" is an observation of real Turso, not a guarantee of
  the Hrana specification. This is a residual risk.
- A refusal now tells a client, in one request and reliably, that a row exists, and tells a
  constraint violation apart from a failure (503). Before, whether a statement failed was already
  visible from whether the write happened. The inference of residual risk 2 of the
  security model gets cheaper. The measures are in the schema and the policy: put the tenant
  column in every UNIQUE key, put no UNIQUE constraint across tenants on a value that must stay
  private, fix the scoping column (the tenant) with `presets` and do not leave it to a `check`
  alone, and rate-limit the endpoint. A `check` is evaluated on the row after the write, so a row
  it would reject can still reach the database's constraint first: with an insert policy of
  `columns: [id, tenant_id, code]`, `check: tenant_id = session` (no preset) and
  `UNIQUE (tenant_id, code)`, a client of tenant `a` that inserts `tenant_id = 'another_tenant'`
  gets 409 `unique` when another tenant has that `code` and 403 `POLICYSQL_CHECK_FAILED` when it
  does not.
- The ABI is 19, so the snapshot (`…:abi-19`) changes with this deployment. An interactive
  transaction that is still active under the earlier snapshot is closed with 409
  `POLICYSQL_TRANSACTION_UNAVAILABLE` on its next command, including its first COMMIT, and is
  rolled back. A COMMIT that was already sent, and an exact retry of the last completed command,
  are still answered (ADR 0007). A keyed atomic retry replays when only the snapshot differs
  (ADR 0007).

## Rejected alternatives

- 422 as the status: 409 is the status of a conflict with the current state of the data.
- One code per kind: a single code and `detail.constraint` keep the status table small, and a
  later kind does not need a new code in every client.
- A setting to hide the kind: an option that changes what a client can observe is a second
  contract to test; the schema measures above address the cause.
- Deciding by the writes after the failed statement or by the success of ROLLBACK: it needs logic
  in core, and the conditional batch already makes it unnecessary.
- Accepting extended codes: real Turso does not send them, and a code that is classified without
  a smoke that produces it is not verified.

## Implementation

One pull request: ABI 19, owner wire `"2"`, the log event `database_constraint_violation`, the
release smoke `smoke-constraint.mjs`, and the table of the error codes in the public documentation.

## Amendment (#145 pull request B)

### Table rows

The `detail` table of section 1 has a second row, and the rule that a value is an enumeration
or a number gains one form, a pointer of a fixed shape into the request:

| Code | `detail` |
| --- | --- |
| `POLICYSQL_CONSTRAINT_VIOLATION` | `{ "constraint": <kind> }` (unchanged; no other key) |
| `POLICYSQL_OUTCOME_UNKNOWN` | `{ "cause": { "code": <code>, "path": <path or null> } }`, both keys always present |

`cause.code` is one of 22 codes, in `OUTCOME_CAUSE_CODES` (core) and `OUTCOME_CAUSES` (Worker):
every code a compile returns, plus the session gate's and the body limits' (`POLICYSQL_JSON_TOO_DEEP`).
A code that depends on the database's state (`CONSTRAINT_VIOLATION`, `CHECK_FAILED`,
`SCHEMA_MISMATCH`, `DATABASE_TIMEOUT`, `COMMIT_*`, `TRANSACTION_*`, `IDEMPOTENCY_CONFLICT`) is not
in the list. `cause.path` is `null`, `/statements/<n>`, or `/statements/<n>/sql`, with `<n>` a
canonical decimal of at most 10 digits. A test over every `RuntimeError` variant in core checks
that a compile can only produce a listed code and path. Core's `owner_replied` and the Worker's
`checkedOwnerReply` check a forwarded reply against the row, and a `cause` on any other code is
invalid; the official client still only checks that `detail` is a plain object.

### `POLICYSQL_CHECK_FAILED` (403)

A changed row whose post-state `check` is FALSE or UNKNOWN is 403 `POLICYSQL_CHECK_FAILED` at
`/statements/<i>`, with no `detail` and a fixed message; it was 422 `POLICYSQL_SCHEMA_MISMATCH`,
which now means only a value the catalog's type cannot hold. The value conversion still runs
first, so a row with both is `SCHEMA_MISMATCH`. The refusal is definite on every path: it is
decided after the statements ran inside the open transaction and before COMMIT, the idempotency
row, and any validator call. The step machine closes as failed and rolls back (an interactive
transaction's COMMIT is only the client's command). With a key it means that this attempt
committed nothing and recorded nothing under the key; a retry after the key's record passed its
retention, under a deployment whose check changed, can be this refusal too, as for
`POLICYSQL_EXPECTATION_FAILED`. The official client lists it as a rejection of `execute` and
`statement` only. The example of Consequences above is now this code.

### `POLICYSQL_OUTCOME_UNKNOWN` (500)

The four places that answered a keyed refusal with `POLICYSQL_INTERNAL` (the session gate, the
body limits, and the two compiles of core, direct and owner) answer 500
`POLICYSQL_OUTCOME_UNKNOWN`, with the fixed message "This request was not executed. The outcome of
an earlier request with the same Idempotency-Key is unknown.", a top-level `path` of `null`, and the
code and path the unkeyed answer has as `cause`. All four run before the database is read, so the
cause cannot depend on it. The status is 500, not 503: the official client reads both as unknown,
500 is the status those answers already had, 503 reads as temporary and a deployment change is
not, and the instruction to retry a keyed 500 with the same key and body still holds. The log
event `request_rejected` carries `cause` (`{code, path}` or `null`).

### Versions

The ABI is 20 (the snapshot is `…:abi-20`) and the owner wire version is `"3"`. The consequences
are those of section Consequences: an active interactive transaction is closed with 409
`POLICYSQL_TRANSACTION_UNAVAILABLE` on its next command, and a keyed atomic retry replays. The
`"2"` and ABI 19 above are the record of pull request A.
