# HTTP API

This document summarizes the public HTTP contract. `spec/openapi.yaml` and the referenced JSON Schemas are canonical. Backward-incompatible changes require a new API version.

## Atomic execute

All stateless SQL execution uses one endpoint:

```http
POST /v1/transactions:execute
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: <required when any statement mutates data>
```

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

Explain accepts the same atomic request envelope. It compiles every item without opening a database transaction and returns client parameter descriptors, final result-column descriptors, and explanations in statement order. `params: {}` allows build-time inference without runtime values. The response metadata includes the inferred `transactionMode`. Production deployments may redact protected SQL and policy identifiers, but not the authorized type descriptors.

## Interactive transactions

Use interactive transactions only when application code must inspect one result before constructing the next statement:

```text
POST /v1/transactions
POST /v1/transactions/{transactionId}/statements
POST /v1/transactions/{transactionId}/commit
POST /v1/transactions/{transactionId}/rollback
```

Each interactive statement request is scalar and sequenced because it depends on prior results. Clients cannot send SQL transaction-control statements.

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

Errors do not reveal hidden columns, policies, credentials, protected SQL, or raw remote database errors.
