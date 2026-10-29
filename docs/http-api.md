# HTTP API

This document summarizes the public HTTP contract. `spec/openapi.yaml` and the referenced JSON Schemas are canonical. Backward-incompatible changes require a new API version.

The public contract is independent of the gateway hosting platform. Cloudflare ownership
and transport details below describe that deployment's implementation; Clients use the
same endpoints, JSON representations and transaction protocol with any conforming host.
SQL dialect, supported features and limits remain governed by the endpoint's backend
profile and published Capabilities.

## The HTTP mapping

This protocol is one mapping of the engine's operations (`execute`, `explain`, `begin`,
`statement`, `commit`, `rollback`, `catalog`, `capabilities`, and the validator's
`callbackQuery`); a non-HTTP caller invokes the same operations directly
([ADR 0023](adr/0023-operations-api-and-http-adapter.md)). The library's HTTP adapter is the
canonical implementation. A deployment that maps HTTP itself must pass the conformance suite
exported as `@unacowa/policysql/cloudflare/http-conformance` (`runHttpConformance`).

Every JSON response has `Cache-Control: no-store` (Catalog and Capabilities:
`private, max-age=0, must-revalidate` with an `ETag`), `Content-Type: application/json;
charset=utf-8`, and `X-Content-Type-Options: nosniff`. The `requestId` in bodies is the
wrapper's correlation id or one the adapter generates; the library reads no platform header
for it.

A request body may start with one UTF-8 byte order mark, which is removed; its 3 bytes count
toward the 1 MiB limit, and a second one makes the body invalid JSON. The same rule applies
to every transport, because the engine applies it to the decoded text.

## Authentication

Authentication is deployment-defined. The deployment's wrapper authenticates every client
request, including every interactive command and commit, and passes the resulting trusted
session to PolicySQL as data; PolicySQL never sees the credential and never returns 401.
A wrapper returns 401 itself: `POLICYSQL_UNAUTHENTICATED` for a missing or invalid
credential (the reference wrapper's only code), or the reserved
`POLICYSQL_AUTHENTICATION_FAILED` that a custom wrapper may use when a present credential
failed verification. Clients treat both as not executed. PolicySQL checks the endpoint's required access and the optional `PolicySQL-Role`
header against the trusted session (403 `POLICYSQL_FORBIDDEN_ACCESS`; a repeated role
header is 400 `POLICYSQL_INVALID_REQUEST`). A malformed session from the wrapper is a
deployment fault (500 `POLICYSQL_INTERNAL`). Stopping an interactive transaction after
token expiry or revocation is the wrapper's obligation. The reference wrapper uses a bearer
JWT (`Authorization: Bearer <token>`); see
[ADR 0020](adr/0020-trusted-session-input-and-jwt-identity-adapter.md). The examples below
show that header.

For `bytes / string / base64`, parameters and result cells use base64 JSON strings on
every conforming host. Empty bytes use `""`; SQL NULL in a nullable result cell uses
JSON `null`. JSON `null` for a bytes parameter follows the NULL parameter rule below,
as for other logical types. Only a compiler-proven bytes parameter is decoded as bytes. Ordinary
string and JSON parameters retain their own meanings. Server adapters preserve the
physical result type through validation before encoding a public result; internal WASM
values and database protocol objects are not public parameter or result formats.
Base64 uses the standard `+/` alphabet, required padding, zero unused bits and no
whitespace. Invalid encodings or non-string bytes inputs return
`POLICYSQL_INVALID_PARAMETER` (400), however long the input is. `limits.maxBytesPerValue`
in Capabilities bounds decoded values (262,144 bytes in the initial profile); exceeding
it with well-formed input returns `POLICYSQL_LIMIT_EXCEEDED` (413) before execution. A
stored physical BLOB over this limit also returns 413 with either database transport
and rolls back the transaction. Request and encoded result limits also apply. See [ADR 0016](adr/0016-bytes-wire-contract.md) and the
[conformance ledger](user-document-conformance.md) for scope and evidence.

A named parameter of any logical type may be JSON `null`, which binds SQL NULL, only
when every use of that parameter in the statement is the whole value of a direct
`INSERT ... VALUES` or `UPDATE ... SET` assignment to a Catalog column with
`nullable: true`. Reuse in a non-nullable assignment, comparison, `IN`, `LIKE`,
function, `CASE`, `ORDER BY`, `LIMIT` or `OFFSET` denies NULL. Any other JSON `null`
parameter returns `POLICYSQL_INVALID_PARAMETER` (400) before database egress. For a
json column, `null` means SQL NULL, not the JSON text `null`. Column permissions,
presets, tenant filters, `RETURNING` permission and TRUE-only post-state checks
still apply to the row that receives NULL. SQL `NULL` literals remain unsupported;
query stored NULLs with `column IS NULL`. See
[ADR 0017](adr/0017-nullable-assignments.md).

## Atomic execute

All stateless SQL execution uses one endpoint:

```http
POST /v1/transactions:execute
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: <optional replay key>
```

`Idempotency-Key` is optional, including for mutations and interactive transaction start.
An explicitly supplied key must contain 16–128 ASCII letters, digits, `.`, `_`, `:`, or `-`;
empty or malformed keys are rejected on those entry points. With a key, atomic mutations
use `policysql_idempotency` in the selected database to look up and persist results in
the same transaction as the mutation. Without a key, no lookup, insert, existence check,
or automatic creation of that table occurs. Each unkeyed request is a new execution and
does not guarantee deduplication if resent. These rules also apply to the commit-check DO
path; policy checks, callbacks, and transaction rollback remain enforced.

Interactive start without a key creates a fresh transaction ID/owner for each request.
Keyed starts retain their existing DO replay behavior. Once started, interactive commands
retain sequence-based retries with or without a start key and do not use this DB table.

### Durable Object ownership without a key

| Request | Owner assignment |
| --- | --- |
| Atomic Execute without a potentially triggered commit check | Executes directly without a transaction-owner DO |
| Atomic Execute with a potentially triggered commit check | Creates a fresh random owner/validation ID for each unkeyed execution request |
| Interactive transaction start | Creates a fresh random transaction ID/owner for each unkeyed start request |
| Interactive statement, commit, or rollback | Routes by the returned transaction ID to the same DO assigned at start |

For both DO execution paths, commit checks and their callbacks stay with the owner holding
the same open database transaction. A new internal ID is not generated per statement or
callback. These routing IDs do not enable idempotency or require a table in the user's DB.
Resending an unkeyed atomic execution or start request creates a separate operation;
commands within an existing interactive transaction retain their sequence-based retry rules.

An authorized development deployment may add `debug.executionTrace` after execution. The trace is
present only when the deployment enables execution tracing and the trusted session has `debug` access.
It is captured from the statement objects handed to the Turso transport, not by running Explain a
second time. Parameter values are never returned:

```json
{
  "debug": {
    "executionTrace": {
      "source": "turso-egress",
      "requestId": "req_01",
      "disposition": "executed",
      "attempt": 1,
      "statements": [{
        "index": 0,
        "operation": "select",
        "resource": "posts",
        "inputSql": "SELECT id, title FROM posts",
        "executedSql": "SELECT ... WHERE author_id = :__policysql_session_subject_id",
        "parameters": [{
          "name": "__policysql_session_subject_id",
          "source": "server",
          "value": "[redacted]"
        }]
      }]
    }
  }
}
```

An idempotency replay reports `disposition: "idempotency_replay"` and an empty statement list,
because the protected business statement was not executed again. Production deployments should
leave execution tracing disabled.

```json
{
  "expected": {
    "schemaVersion": "schema_17",
    "policyVersion": "policy_42"
  },
  "statements": [
    {
      "sql": "SELECT id, title FROM posts WHERE status = :status LIMIT :limit",
      "params": { "status": "active", "limit": 20 }
    },
    {
      "sql": "SELECT id, name FROM authors WHERE id = :author_id",
      "params": { "author_id": "author_01" }
    }
  ]
}
```

`statements` contains one or more items. Every `sql` field must contain exactly one statement and has its own parameters and optional `expect`. Items execute in array order against one policy/Catalog snapshot and one database transaction. PolicySQL infers a read transaction when every item is `SELECT`; the presence of any mutation selects a write transaction. Clients do not send a mode or statement ID.

Results correspond to statements by zero-based array index:

```json
{
  "transactionId": "tx_01",
  "status": "committed",
  "results": [
    {
      "columns": ["id", "title"],
      "rows": [{ "id": "post_01", "title": "First post" }],
      "rowCount": 1,
      "meta": {
        "operation": "select",
        "result": {
          "columns": [
            { "name": "id", "type": "string", "representation": "string", "nullable": false },
            { "name": "title", "type": "string", "representation": "string", "nullable": false }
          ],
          "redactions": []
        }
      }
    },
    {
      "columns": ["id", "name"],
      "rows": [{ "id": "author_01", "name": "Alice" }],
      "rowCount": 1,
      "meta": {
        "operation": "select",
        "result": {
          "columns": [
            { "name": "id", "type": "string", "representation": "string", "nullable": false },
            { "name": "name", "type": "string", "representation": "string", "nullable": false }
          ],
          "redactions": []
        }
      }
    }
  ],
  "meta": {
    "requestId": "req_01",
    "policyVersion": "policy_42",
    "schemaVersion": "schema_17",
    "role": "author",
    "commitChecks": "not_triggered"
  }
}
```

Multiple statements are the standard envelope; one statement is represented by a one-item array, not a scalar variant. The response always contains `results`. A failure in compilation, execution, an expectation, or a commit check rolls back the entire request and returns no partial result. Error paths identify the item, for example `/statements/1/sql`.

`meta.result.columns` describes the final result schema after aliases, expressions, joins, aggregation, and policy projection. `meta.result.redactions` is always present and identifies cells set to `null` by policy. A visible database NULL is not listed. Mutation results add `affectedRows` and mutation metadata; without `RETURNING`, `columns`, `rows`, and redactions are empty arrays.

## Explain

```http
POST /v1/transactions:explain
```

Explain accepts the same atomic request envelope. It compiles every item without opening a database transaction and returns client parameter descriptors, final result-column descriptors, and explanations in statement order. `params: {}` allows build-time inference without runtime values. Each parameter descriptor's `nullable` is the compiler's statement-wide NULL proof and matches exactly what Execute accepts, for every type; it never depends on a supplied sample. Supplied samples are validated like Execute values: a `null` sample for a non-nullable parameter returns `POLICYSQL_INVALID_PARAMETER` rather than being ignored. The response metadata includes the inferred `transactionMode`. Production deployments may redact protected SQL and policy identifiers, but not the authorized type descriptors.

## Interactive transactions

Use interactive transactions only when application code must inspect one result before constructing the next statement:

```text
POST /v1/transactions
POST /v1/transactions/{transactionId}/statements
POST /v1/transactions/{transactionId}/commit
POST /v1/transactions/{transactionId}/rollback
```

Each interactive statement request is scalar and sequenced because it depends on prior results. Clients cannot send SQL transaction-control statements.

Repeating the identical commit command replays its recorded terminal response. The owner
persists a `committing` record (with the commit's sequence and payload digest) before it
sends COMMIT, and writes the terminal record (`committed`, the next sequence, and the reply)
in one put. When COMMIT may have been sent but its outcome is not recorded (the owner was
lost after COMMIT, the terminal put failed, or the database connection failed during COMMIT),
the commit and every repetition of it return 503 `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`
([ADR 0007](adr/0007-transaction-retry-and-commit-check-protocol.md), issue #48). That code
is never a rejection: clients treat it as an unknown outcome. A commit is rejected (409) only
when its COMMIT was never sent, for example after owner loss or expiry before the commit, or
when a commit check rejects it. This also holds across a deployment that changes the
snapshot: for a commit command only, the owner accepts a caller that differs from the
transaction in nothing but the snapshot (same principal, subject, role, session, and database
scope, id, and generation), and if that commit's COMMIT was sent it answers with the recorded
reply or the unknown outcome.
Another principal or database is rejected as before, and every other command requires the
current snapshot. The order of the checks is in ADR 0007.

## Catalog and capabilities

`GET /v1/catalog` returns the role-visible logical schema. `GET /v1/capabilities` advertises accepted SQL surface, transaction support, and enforced limits. Generated clients pin requests with the Catalog `schemaVersion` and `policyVersion`.

## Errors

```json
{
  "error": {
    "code": "POLICYSQL_FORBIDDEN_COLUMN",
    "message": "The statement references a column that is not available for this operation.",
    "path": "/statements/0/sql",
    "requestId": "req_01"
  }
}
```

Each code has exactly one HTTP status. The table of codes and statuses in
[`website/api/errors.md`](../website/api/errors.md) is canonical; the HTTP adapter
(`deploy/cloudflare/src/http/status.ts`) implements exactly that table, and a test checks that
every code the library can return is in it
([ADR 0023](adr/0023-operations-api-and-http-adapter.md)). A code outside the table is served as 500.

Errors do not reveal hidden columns, policies, credentials, protected SQL, or raw remote database errors.
The optional development trace is returned only after successful execution and never changes this
error contract.
