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

## Amendment (#145 pull request C)

### Table rows

Five codes of a compile (and of the database's complexity refusal) gain a row, and a keyed
`POLICYSQL_OUTCOME_UNKNOWN`'s `cause` gains `detail`:

| Code | `detail` | Required |
| --- | --- | --- |
| `POLICYSQL_CONSTRAINT_VIOLATION` | `{ "constraint": <kind> }` (unchanged) | yes |
| `POLICYSQL_OUTCOME_UNKNOWN` | `{ "cause": { "code": <code>, "path": <path or null>, "detail": <object or null> } }`, all three keys always present | yes |
| `POLICYSQL_INVALID_SQL` | `{ "span": { "start": <int>, "end": <int> } }` | **no**: absent when the parser reports no position |
| `POLICYSQL_UNSUPPORTED_SQL` | `{ "feature": <feature> }` | yes |
| `POLICYSQL_INVALID_PARAMETER` | `{ "reason": <reason> }` | yes |
| `POLICYSQL_SQL_TOO_COMPLEX` | `{ "complexity": <complexity> }` | yes |
| `POLICYSQL_EXPECTATION_FAILED` | `{ "expectation": "affectedRows" \| "rowCount" }` | yes |
| every other code | none | a `detail` is invalid |

`INVALID_SQL` is the one exception to "a code in the table requires its detail" of section 1:
turso_parser reports a position for its lexical errors and for an unexpected token, and none for an
unexpected end of input, a limit, or a custom error, and a position that is not there is not
invented. `cause.detail` is checked with the row of `cause.code` (`null` where that code has no
detail or an optional one); `cause.code` is never `POLICYSQL_OUTCOME_UNKNOWN`, so the check does not
recurse. The enumerations are `UNSUPPORTED_FEATURES` (33), `PARAMETER_REASONS` (8),
`COMPLEXITY_DETAILS` (11), and `EXPECTATIONS` (2) in core, kept equal by test in the Worker, OpenAPI,
the parser and gateway, and the client's types. `tests/fixtures/error-detail-cases.json` is read by
both core's and the Worker's tests and decides the same way in both.

### What a value is

- `feature` names a construct by its SQL syntax (`star`, `cte`, `insert_select`, `window_function`,
  `protected_statement`: a statement the policy composed was refused at emit or verification). The
  binder's internal shape names (`JSON document provenance`, `same-resource correlation`) are logged
  only; several of them map to one feature.
- `reason` is why a parameter was refused: `positional`, `prefix`, `name`, `type`, `null`,
  `literal`, `value`, `names`. It never names the parameter. `names` is "the supplied names differ
  from the SQL's"; missing and unexpected are not told apart, which would take a set difference.
- `complexity` is the key's name, not `cause`: `OUTCOME_UNKNOWN`'s `detail.cause` is an object, and
  one key name with two types would make the client's type a union. It is the value of the log's
  `sql_too_complex.cause` (the 7 compile causes, the database's 4, and `database`).
- `expectation` is which of `expect.affectedRows` and `expect.rowCount` did not hold. The count is
  not returned.
- `span` is the UTF-8 byte range `[start, end)` of the token in `statements[i].sql`, as decoded from
  the JSON (neither the engine nor core rewrites it). `path` stays `/statements/<i>`. The AST of
  turso_parser carries no positions, so only `INVALID_SQL` has one; `FORBIDDEN_COLUMN` and the like
  do not. The SQL PolicySQL emits is never a source of a span: it is re-parsed without a position.
  A span past 1,048,576 (`MAX_SQL_BYTES_CEILING`) is invalid in the table and is left out by the
  producer.

### The `detail` and what it lets a client infer

The detail is a fixed enumeration or a position in the client's own bytes, never an identifier,
a parameter name or value, or a parser or database message. The judgement of what it adds, per
detail (the full argument is in the issue):

- A column that does not exist and one the role cannot see are answered alike. The binder walks a
  statement in a fixed order and stops at the first failure; up to the point where a column is
  resolved both walk the same way, and `FORBIDDEN_COLUMN` has no `detail`. A test
  (`detail_tests.rs`, "a missing name and a hidden one") compiles 47 column templates (20 of them
  also for a hidden column of integer, json, boolean and bytes type: CTEs, derived tables,
  `HAVING`, JSON collections included) and 12 resource templates against both and requires the same
  answer wherever the code is the same.
- That test also lists where the *code* already differs, which `detail` does not change:
  a resource without a policy for the role is `MISSING_POLICY` and one that does not exist is
  `FORBIDDEN_OPERATION` (the resource unification of pull request D closed this, see its amendment); a hidden column
  that reaches a policy refusal of its own (aggregation or windows off) before the column check is
  answered with that refusal (#154); a column used as an inserted or assigned value is `UNSUPPORTED_SQL`
  when it exists and `FORBIDDEN_COLUMN` when it does not; a literal or value of another type than
  the hidden column's is `INVALID_PARAMETER` (the type of a hidden column shows in the code, #154).
  One more difference is a refusal against an acceptance: a column that only a derived table or a CTE
  carries, and the outer statement does not use, is not checked, so a hidden one compiles and a missing
  one is refused (#141).
- One case differs in `detail` with the same code: a CTE named like a Catalog resource is refused
  by the binder before the role is looked at (`feature: cte`), and a CTE of any other name goes on
  to its next refusal. That told a client whether a resource exists before `feature` was added
  (a successful compile against a refusal), so the set of facts is the same and `feature` only makes
  it cheaper to combine with another refusal. It is listed in the test as the only known split of
  this kind, and pull request D closed it.
- The binder and the decoding of parameter values run before the policy, against the role's Binding Catalog (pull request D; before it, the whole Catalog):
  a forbidden column's existence and logical type are visible from the code (`WHERE tenant_id = 1` is
  `INVALID_PARAMETER`, `WHERE nope = 1` is `FORBIDDEN_COLUMN`). `reason: type` and `feature: cast`
  make a second type-dependent failure cheaper to read; they do not add a fact the first request
  already gives. The root fix (type checks only on columns the role sees, or the policy first) is
  #154.
- `complexity` depends on the policy (the emitted statement holds its predicate, companions and
  server parameters), and on rows for a database `like_pattern`. The code `SQL_TOO_COMPLEX`
  already said "too complex under the active policy"; `Obs` now says that the value is a function
  of the client's SQL, the policy, and the deployment.
- `expectation` follows the visible count, as the code does; with both expectations on a
  mutation, `affectedRows` passing and `rowCount` failing already told the count from the path
  of a two-statement envelope.

### Log: `rejection_reason`

A refusal's internal reason is logged, never returned. The event `rejection_reason` is written where
the compile or the result validation happened (the Worker's core, an owner's core, and for Explain
the engine), with `requestId`, `statementIndex` or `null`, `code`, `reason`, `shape`,
`schemaVersion`, `policyVersion`, `abiVersion`:

- `reason` is `<stage>.<variant name>`: `bind.UnknownColumn` (does not exist), `policy.ForbiddenColumn`
  (forbidden), `policy.MissingPolicy`, `policy.InvalidPredicate`, `policy.MissingSessionValue`,
  `compile.ClientParameterMismatch`, `emit.*`, `verify.*`, `gateway.*`, `request.*`, `parameter.*`,
  `result.*`, `auth.*`, `runtime.*`. Only variant names; the strings carried by
  `InvariantViolation`, `MissingServerParameter` and the like are not logged.
- `shape` is the binder's internal shape for `bind.Unsupported` (`CTE shadows protected resource`),
  a fixed string embedded in the binary, else `null`.
- `request_rejected` is written by the engine from the answer to the client and cannot carry the
  reason: it is not in the answer, and an owner compile does not pass through the owner wire back
  to the Worker. The two are joined by `requestId`. `sql_too_complex` and
  `emitted_sql_reparse_failed` keep their own events and get no `rejection_reason`; Explain's
  `compile_json` carries those two records in `log` as well, so they are logged there too.
- A keyed unknown outcome writes the original reason too: the log happens where the compile failed,
  before the answer is rewritten.
- Explain's `compile_json` returns the record as a sibling `log` of `error`, a private field of the
  ABI; the engine moves it to a non-public field of `EngineError` and writes it before
  `request_rejected`. It is never part of an `OperationError` or a response.

### Versions

The ABI is 21 (the snapshot is `…:abi-21`) and the owner wire version is `"4"`. The consequences
are those of section Consequences: an active interactive transaction is closed with 409
`POLICYSQL_TRANSACTION_UNAVAILABLE` on its next command, and a keyed atomic retry replays.

### Left to pull request E and later

`limit` of `LIMIT_EXCEEDED`, `REQUEST_TOO_LARGE` and `TRANSACTION_LIMIT_EXCEEDED`, a finer `path` of
`INVALID_REQUEST`, `DATABASE_ERROR` (proposal 6), and the `reason` of a commit check (proposal 8).
The resource distinction (proposal 7) was closed by pull request D. Positions of
`FORBIDDEN_COLUMN` and the like need a lexical rescan and are not planned.

## Amendment (#145 pull request D)

### Decision

The client's SQL is bound against the resources on which the role has a policy of any operation
(select, insert, update, delete), the Binding Catalog (`policysql_gateway::BindingCatalog`, made
only by `Gateway::binding_catalog(role)`). A resource outside it is, to the binder, a name that
does not exist. `BindError::UnknownResource` answers 403 `MISSING_POLICY` with the message "No
policy permits this operation, or the resource does not exist."; so a resource without a policy for
the role, a name that does not exist, and an operation without a policy on a resource the role
has a policy on, are one code, one message, one `path`, and no `detail`. `FORBIDDEN_OPERATION`
stays for a refusal by the policy of the statement's shape (aggregation or windows off, a session
without a value the policy needs, and the like); it is no longer given for a name that does not exist.
The `detail` table is unchanged.

### Why not only a new code

Renaming the code of `UnknownResource` does not close it: the binder resolves a name against the
whole Catalog, so a resource without a policy passes the binder and meets the next bind failure
(`SELECT nope FROM hidden` is `FORBIDDEN_COLUMN`, `SELECT * FROM hidden` is `UNSUPPORTED_SQL`, a
literal of the wrong type is `INVALID_PARAMETER`), while a name that does not exist stops at the
first lookup. A Catalog restricted to the role's resources makes both the same input to bind, to the
decoding of parameter values and to the deployment-surface check, so the answers are equal by
construction. The policy itself is not passed to the binder: a subset of the Catalog is enough, and
the parser's API is unchanged. The columns of a resource the role can see stay as in #154: their
visibility is per operation and per conditional column, which a Catalog subset cannot express.

### CTE names

The binder refuses a CTE named like a resource in the Catalog it is given, which is now the role's.
A CTE named like a resource the role cannot use is accepted, as a CTE of a name that is not a resource
is. This is safe: the emitter writes no client CTE (the binder flattens it onto the base resource's
scope), no client alias is emitted (table aliases are internal), and the parent resource of a
policy `exists` (ADR 0029) is resolved from the whole Catalog at activation and written by its
physical name. A test (`resource_tests.rs`) fixes this: with `projects` read only through a parent
`exists`, `WITH projects AS (SELECT id, project_id FROM tasks) SELECT id FROM projects` compiles
to the same protected SQL as `SELECT id FROM tasks`, `EXISTS` over the physical `projects` included.

### What stays observable

A resource on which the role has a policy of some operation is told from a name that does not
exist (`DELETE FROM tasks WHERE nope = :v` is `FORBIDDEN_COLUMN` when only select is granted on
`tasks`): the role's Explain compiles it, so its existence is information the policy gave. The
existence and type of a forbidden column of such a resource (#154, #141) are unchanged, and the
differential test's lists of those places (`POLICY_ORDER_CODE_SPLITS`, `TYPE_CODE_SPLITS`,
`VALUE_POSITION_CODE_SPLITS`, `ACCEPTED_HIDDEN_SPLITS`) are kept. `RESOURCE_CODE_SPLITS` and
`DETAIL_SPLITS` are deleted: every resource template is answered alike, and the two CTEs named like
the resource compile to the same statements (`BOTH_ACCEPTED`).

### Log

A resource outside the Binding Catalog is logged as `bind.UnknownResource`, as a name that does not
exist is. The binder is not told "exists but hidden", since that difference could reach the answer.
`policy.MissingPolicy` now means a resource the role has a policy on, without one for this operation.
An operator reads the role's policy with Explain and the Catalog endpoint.

### Versions

The ABI is 22 (the snapshot is `…:abi-22`); the owner wire version stays `"4"`, because the owner
reply and the `detail` table are unchanged (the difference is a snapshot skew). The consequences are
those of section Consequences: an active interactive transaction is closed with 409
`POLICYSQL_TRANSACTION_UNAVAILABLE` on its next command, and a keyed atomic retry replays.

### Left to later pull requests

Pull requests E and F are closed (the amendments below), and with them proposal 5 of #145 (`limit`;
the `path` of `INVALID_REQUEST` was considered and left as it is). What remains is the candidates
listed under "Left out" of the last amendment.

## Amendment (#145 pull request E)

Proposals 6 (`DATABASE_ERROR`) and 8 (the `reason` of a commit check) of #145.

### `POLICYSQL_DATABASE_ERROR` (500)

1. **The code.** `POLICYSQL_DATABASE_ERROR`, HTTP 500, the fixed message "The database refused the
   statement.", `path` always `null`, no `detail`. It means: the database answered, and refused the
   statement with an error that is neither a constraint violation nor a complexity refusal. It is
   not a definite refusal: the official client reads it as an unknown outcome, as it did the 503.
2. **Only the exception type changes; no new judgment is added.** `DatabaseStatementError` now
   carries `POLICYSQL_DATABASE_ERROR`. It is what a statement batch's step error becomes when it is
   neither complexity nor a constraint, and what a reply that ended the stream (#144) becomes: the
   place is the same (a step error of the batch), and the stream still gives no evidence for a 409.
   A pipeline request that failed as a whole (a Hrana `type: "error"` result, `readBatch`) is not
   a statement's refusal, so it is the new `DatabaseRequestError`, which stays 503
   `POLICYSQL_DATABASE_UNAVAILABLE`, with its code for the log. No allowlist of transient codes is
   made: a `SQLITE_BUSY` step error is a 500 too (BEGIN IMMEDIATE takes the write lock, so lock
   contention normally shows up as a failed BEGIN, a 503; this is a guess that the release smoke does
   not check, and the status does not depend on it).
3. **A new outcome class `refused`** (core's `Class::Refused`, TypeScript's `FailureClass`). The
   adapter reports an `EngineError` with this code as `refused`, looked up by code. Unlike
   `constraint` it carries no obligation: it is never a definite refusal, so reporting it where it
   does not belong changes nothing a client decides.
4. **The table.**

| Where | Before | After |
| --- | --- | --- |
| a statement step error that is neither complexity nor a constraint, atomic (direct or owner, keyed or not) | 503 + log | 500 `DATABASE_ERROR` + log |
| the same in an interactive statement | 503 + log, then `failed` | 500 + log, then `failed` (the next command is 409 `TRANSACTION_UNAVAILABLE`) |
| a refusal in a reply that ended the stream (#144) | 503 + log | 500 + log, never 409 |
| an extended constraint code (`SQLITE_CONSTRAINT_UNIQUE`, section 10) | 503 + log | 500 + log |
| the idempotency lookup or insert, a refusal that is neither complexity nor a constraint | 503 + log | 500 `DATABASE_ERROR` + log |
| the lookup or insert's constraint, complexity or `limit` (section 5) | 500 `INTERNAL` | unchanged |
| a callback query's step error | 503 to the validator, 409 `COMMIT_CHECK_REJECTED` to the client | 500 `DATABASE_ERROR` to the validator, 409 with `reason: callback` |
| COMMIT's error reply (a deferred foreign key included) | interactive 503 `COMMIT_OUTCOME_UNKNOWN`, atomic direct 503, atomic owner 500 `INTERNAL` | unchanged (ADR 0007): `commit_failure(Refused)` is `INTERNAL`, `directCommitFailureClass` reports `refused` as `unavailable` |
| a pipeline request that failed as a whole | 503 + log | unchanged |
| `RuntimeError::Busy` (the wasm plan table is full) | 503 | unchanged: the database refused nothing, and a retry may pass |

   Section 4's and section 10's "a reply that ended the stream stays 503" and "an extended code
   returns to 503" now read 500 `DATABASE_ERROR`; what is not classified is the same. `Code::for_class`
   maps `Refused` to `DatabaseError` on every event. `OUTCOME_CAUSE_CODES` is unchanged (22 codes):
   `DATABASE_ERROR` depends on the database's state.
5. **The log.** `database_error_unclassified` is written when the class is `refused`, with the
   database's code only (`{event, requestId, code}`), once per `DATABASE_ERROR` reply. "Unclassified"
   keeps its meaning: not classified as complexity or constraint. The 503 request error is still
   logged as before. `cost_observation_failed` carries `DATABASE_ERROR` as its `code` for a refused
   cost observation (log only).
6. **No `path`.** The failed statement's index is known to the transport, but a lookup or insert
   does not point at the client's statements, so a path would need a branch per task. A candidate for
   later.

### `detail.reason` of `POLICYSQL_COMMIT_CHECK_REJECTED`

1. **Five values** (`COMMIT_CHECK_REASONS`), each assigned by the branch that rejects, from what
   the branch already knows:

| Value | Meaning | Branches |
| --- | --- | --- |
| `denied` | the validator answered with a well-formed decision with `allowed: false` | the verdict |
| `unavailable` | no usable answer (not delivered, timeout, non-2xx, a malformed decision) or the validation deadline passed | expiry before or while validating, a connection that is not open, `ValidatorFailed` of any class but `rejected`, `ok: false`, a malformed decision |
| `limit` | the check's callback queries together read more rows (`max_callback_rows`) or result bytes than allowed | the cumulative callback row and byte limits (`checks.rs`, the one `fail_validation` after `validate`) |
| `unconfigured` | a check that started has no endpoint, or the hook adapter refused it at the exit | the configured-checks test (interactive and atomic), `ValidatorFailed { class: rejected }` |
| `callback` | a validator callback query failed for another reason | every other `fail_validation`: one query over a per-statement limit (`maxRows`, `maxResultBytes`, a BLOB's bytes, an adapter's `limit` class), the query-count limit, a failed compile or binding, a bad token or order |

   `limit` and `callback` are the only candidates the callback code can name: the proposal's four
   values had none for a failed callback query, so `callback` is the fifth.
2. **`decision_verdict`** replaces `allowed_decision`: `Allowed`, `Denied`, or malformed. The set
   of decisions that allow is unchanged. A decision without `allowed`, or with a non-boolean
   `allowed`, was a deny by the final comparison; it is now `unavailable`, since it is not a decision
   by the documented form. A non-2xx reply is `unavailable` whatever its body.
3. **`ValidatorFailed.class`** is read: `rejected` is `unconfigured`, anything else `unavailable`.
4. **The callback count limit** (`sequence > max_transaction_statements`) stays `callback`, and the
   validator keeps getting `TRANSACTION_CONFLICT` for it. Splitting it would raise the question of the
   validator-facing code too, so it is left to #158.
5. **The validator's `error.code` is neither returned nor logged.** It is an untrusted string, and
   logging it would need a check of its characters and length: logic. The validator keeps its own audit
   log. This narrows the plan's "log it only".
6. **The key is `reason`**, as `INVALID_PARAMETER`'s. The value sets are disjoint and the type is
   the same (a string from an enumeration), so a union of two lists does not break amendment C's
   reason for naming `complexity` apart (that avoided one key with an object and a string). The
   branch key stays `code`.
7. **The type prevents a missing reason.** `Code::CheckRejected(CheckReason)`: a
   `COMMIT_CHECK_REJECTED` without a reason does not compile, and `error_reply` puts the reason in
   `detail` through `Code::detail`. A test lists every `Code` through an exhaustive `match` and checks
   its reply against the table.
8. **Not changed**: every reason is a 409 `COMMIT_CHECK_REJECTED`, decided before COMMIT, a rejection
   for `execute` and `commit`. `reason` is information for a retry decision (`denied` and `limit`
   may repeat, `unavailable` may pass); PolicySQL does not promise it. `Task::Verdict` carries the
   verdict with its reason (a deny that waits for the connection keeps its reason).

### The detail table

| Code | `detail` |
| --- | --- |
| `POLICYSQL_COMMIT_CHECK_REJECTED` | required `{ "reason": <one of five> }` |
| `POLICYSQL_DATABASE_ERROR` | none (a `detail` is invalid) |

The shared fixture, core's `ErrorDetail::allowed`, the Worker's `checkedErrorDetail`, OpenAPI's
`ErrorDetail.reason` (the eight parameter reasons, then the five) and the client's
`PolicySqlCommitCheckReason` are the same lists. The official client's handling does not change:
`DATABASE_ERROR` is not in `REJECTIONS` (an unknown outcome), `COMMIT_CHECK_REJECTED` is a rejection.

### Observation (`Obs`)

A client now sees whether a failed statement was refused by the database (500) or got no answer
(503); that the statement failed was visible before, and the code adds only "not an outage". A
commit-check rejection gives a fixed reason that depends on the validator and on the rows the
callback session reads: a client can guess that `limit` against `denied` follows the rows it cannot
see, or that a heavy validator query that times out is `unavailable`. The verdict itself already
depended on what the validator read. Operators: a validator should deny rather than fail on a data
condition, and its callback limits should be well above its ordinary reads. See `docs/security-model.md`.

A database error that data the policy hides can cause (residual risk 3 of the security model, for a
client predicate evaluated on a hidden row) used to be a 503 that one request could not tell from an
outage; it is now a 500 `DATABASE_ERROR` that one request reads. The path is not new, and the
statement's failure was already visible; this is the same kind of change as the constraint violation's
409.

A refusal whose `executeFailed` carries no `databaseCode` (a custom transport that throws the
engine's `POLICYSQL_DATABASE_ERROR` without one) is a 500 without a `database_error_unclassified`
record; the shipped transport always sends the code.

### Rejected alternatives

- An allowlist of transient database codes: it needs real Turso observations and is a judgment.
- A `path` for `DATABASE_ERROR`: needs a branch per task.
- Returning or logging the validator's code: needs a check of an untrusted string.
- A separate key (`checkReason`): the string type is the same; the key adds no safety.
- Splitting the `||` of the callback count limit: changes the validator-facing code (#158).

### Versions

ABI 23 (the snapshot is `…:abi-23`) and owner wire `"5"`: the owner reply gains a `detail` row, and
an older Worker reads it as `owner_reply_rejected`; a reply of another version is not read (the
existing rule). The consequences are those of section Consequences.

### Left out

The difference between the callback count limit and the documented validator code (#158). A `path` of
`DATABASE_ERROR`. A statement number or the response's code in `database_error_unclassified`. A
`Busy` message equal to its code's text. Pull request F (`limit`, and the `path` of
`INVALID_REQUEST`, which it left out): see the amendment below.

## Amendment (#145 pull request F)

Proposal 5 of #145: the limit codes name the limit. This closes proposal 5; no part of #145 is left
to a later pull request except the candidates under "Left out".

### Table rows

| Code | `detail` |
| --- | --- |
| `POLICYSQL_LIMIT_EXCEEDED` | optional `{ "limit": <one of ten> }`: `maxRows`, `maxResultBytes`, `maxResponseBytes`, `maxStatements`, `maxJsonValues`, `maxBytesPerValue`, `maxParameters`, `maxExpressionDepth`, `maxProjections`, `maxJoins` |
| `POLICYSQL_REQUEST_TOO_LARGE` | optional `{ "limit": <one of three> }`: `maxRequestBytes`, `maxJsonValues`, `maxSqlBytes` |
| `POLICYSQL_TRANSACTION_LIMIT_EXCEEDED` | optional `{ "limit": <one of four> }`: `maxStatements`, `maxResultBytes`, `maxCallbackRowsPerCheck`, `maxCallbackBytesPerCheck` |

The rule is one: **the place that checked a limit names it, by its Capabilities key, and only that
place.** A place that checks a bound without a Capabilities key sends no `detail`, so the three rows
are optional, like `INVALID_SQL`'s `span`. A forged owner reply that drops the `detail` loses
information and nothing else. The places without a name:

| Place | Why it has none |
| --- | --- |
| The compile input bound (`REQUEST_TOO_LARGE`) | derived from `maxRequestBytes`, which the engine checked first; naming it would point a client at a limit it did not cross |
| The raw result bound (`LIMIT_EXCEEDED`) | a sum of several limits (`2 x maxResultBytes + 64 x cells + 512 x statements + metadata + 1,024`); naming one is a guess |
| The adapter class `limit` | a BLOB over `maxBytesPerValue` and the transport's derived read cap arrive as the same class; telling them apart needs a field on `executeFailed` and on the TypeScript transport, the core event and its check |
| The durable record bound (`TRANSACTION_LIMIT_EXCEEDED`) | a fixed constant, not in Capabilities |
| An invalid `LIMIT` clause (`LIMIT -1`) | not a limit; filed as a classification question |
| `TooManyPolicies` | activation only; it never reaches a client |

So the same BLOB limit is `maxBytesPerValue` where a value was counted in a reply (the driver
transport's marker, a parameter, a result cell the runtime validates) and has no name where the
HTTP transport met it while reading. Both are 413 and a client treats them alike.

### What a value is

The leaf of a Capabilities key: `limits.<name>` for `LIMIT_EXCEEDED` and `REQUEST_TOO_LARGE`,
`transactions.<name>` for `TRANSACTION_LIMIT_EXCEEDED`. `maxStatements` and `maxResultBytes` exist in
both groups; the code says which. The number is not returned: the place often holds a remainder, not
the configured value (an atomic envelope's later statement has what the earlier ones left); during a
deploy the Capabilities a client read and the deployment that answered can differ, while a name is
stable; and the table stays an enumeration. A client reads the number from Capabilities. When several
limits are crossed at once the first in the fixed order of checks wins (an atomic envelope's rows,
then its bytes), which is the order the former combined condition had.

### What it lets a client infer

`detail.limit` is a function of the client's request, the deployment's configuration (public in
Capabilities), and the policy-protected result, never of rows the role cannot see.

- Request side (body, SQL, parameters, statement count, binder limits): decided from the client's
  own bytes before the database is read. A binder limit and a column that does not resolve: the
  binder stops at its first failure, so where both answers have the same code they are the same
  answer. Where the codes differ, the cause is the order of the walk, which #154 describes: the bind
  and the decoding of the values come before the policy. A hidden column is reached and the walk
  goes on to a binder limit that lies after the column (the third parameter, an expression deeper
  than `maxExpressionDepth`, a second statement's `maxProjections`) or to a value over
  `maxBytesPerValue`; a missing column stops the walk first as `FORBIDDEN_COLUMN`. The code already
  told the two apart, and the limit adds nothing: where both answers have the same code they are the
  same answer, `limit` and `path` included (`a_limit_is_the_same_answer_for_a_hidden_column_and_a_missing_one`
  lists the splits by template, and `a_limit_after_the_column_is_a_code_split_and_nothing_more` the
  ones that need their own parameters or statements).
- Result side: the rows, bytes, values and cells counted are those of the statement the policy
  protected. For a `SELECT` the policy's filter is in the SQL and a hidden conditional cell must be
  NULL (so its size is not counted): the name is a function of the visible result, and the tests run
  two databases that differ only in rows of another tenant, and only in the hidden cell of a
  conditional column, and read the same name. A client could already learn the same from queries
  that stay inside the limits (`LIMIT`/`OFFSET`, fewer columns). For `INSERT`, `UPDATE` and `DELETE`
  the count is of the rows the statement changed: `RETURNING` rows, and one internal check cell per
  row, so `maxJsonValues` can be crossed by the number of changed rows even without `RETURNING`
  (and `maxRows` or `maxResultBytes` by the `RETURNING` rows, which an update or delete filter wider
  than the select filter can make rows the role cannot select). The number of changed rows is what
  the affected-row count already gives (P3), so the name adds no fact.
- A commit check's callback limits go to the validator, a trusted component that already received
  the rows; the client gets the check's `limit` reason as before (and the rows-or-bytes split is not
  shown to it).

### `INVALID_REQUEST` path

Left as it is. A serde error has no position, and getting one takes a dependency or a walk of the
JSON. Where a field is known, its pointer is not in the fixed forms (`/statements/<n>`,
`/statements/<n>/sql`) that the boundary tables allow for `cause.path`. `RuntimeError::EnvelopeAt`
(an empty SQL) cannot be reached from a client: the binder refuses a blank statement first, as
`INVALID_SQL`.

### Rejected alternatives

- Naming the limit a derived bound comes from (the compile input as `maxRequestBytes`; the raw bound
  as `maxResultBytes`): it points at a limit that was not crossed.
- A field on the adapter's `limit` class to tell the BLOB limit from the read cap: it widens the
  TypeScript transport, the core event and its check for a value the client can derive.
- The configured number next to the name (see What a value is).
- The qualified name (`limits.maxRows`): the code decides the group, and a client would have to
  strip the prefix.
- One list for all three codes: it would accept a forged `{ "code": "TRANSACTION_LIMIT_EXCEEDED",
  "detail": { "limit": "maxRows" } }`.

### Versions

ABI 24 (the snapshot is `...:abi-24`) and owner wire `"6"`: the owner reply gains a `detail` on three
codes, and an older Worker reads it as `owner_reply_rejected`; a reply of another version is not
read. Consequences are those of section Consequences (an interactive transaction answers 409
`TRANSACTION_UNAVAILABLE` to its next command; a keyed atomic retry replays).

### Left out

Naming the unnamed bounds. The `path` of `INVALID_REQUEST` and `/statements/<i>/expect/affectedRows`
for a `SELECT` with an `expect` (it needs a wider `cause.path` form). Moving `LIMIT -1` to another
code. `maxCallbackQueriesPerCheck` as a `TRANSACTION_LIMITS` value once the validator-facing code
for it is made the same (#158).
