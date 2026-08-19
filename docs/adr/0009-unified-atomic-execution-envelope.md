# ADR 0009: Unified atomic execution envelope

- Status: accepted

## Decision

`POST /v1/transactions:execute` is the only stateless SQL execution endpoint. Its request contains `statements`, a non-empty ordered array. Each item contains exactly one SQL statement, its named parameters, and an optional cardinality expectation.

The response always contains an ordered `results` array, including for a one-item request. Request and response items correspond by zero-based array index; clients do not supply statement IDs. PolicySQL infers a read transaction when all bound items are `SELECT` and a write transaction when any item mutates data. `Idempotency-Key` is required exactly for the latter case.

`POST /v1/transactions:explain` accepts the same request envelope and explains every item without execution. Interactive transactions retain scalar, sequenced statement requests because later SQL may depend on earlier results.

## Rationale

A single atomic envelope removes the separate scalar SQL and batch contracts, their duplicate metadata layouts, and client branching by statement count. Array order already provides stable correlation within one request. Mode inference avoids trusting redundant client input and is possible because every item is compiled before execution starts.

## Consequences

- The service validates and authorizes all items, infers mode, and checks idempotency requirements before opening the database transaction.
- Any item, expectation, operation check, commit check, limit, or commit failure rolls back the request and suppresses partial results.
- Limits for statements, parameters, result rows, result bytes, time, and transaction duration are cumulative across the envelope.
- Scalar client APIs may unwrap `results[0]`, but complete transaction responses remain available.
- A semicolon-separated sequence inside one `sql` field remains invalid.
