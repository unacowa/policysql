# ADR 0005: JWT and trusted-session contract

- Status: accepted

## Context

Policy selection and server-owned predicate values depend on authentication data. Claim names, role syntax, value types, and transaction binding must therefore be deterministic across identity providers and must not be inferred from arbitrary headers.

## Decision

Public API authentication uses a signed JWT access token verified against one configured issuer, audience, algorithm allowlist, and JWKS source. The canonical PolicySQL claims object contains `roles`, `default_role`, `access`, and optional `session`. A deployment may locate that object with one JSON Pointer or construct it with an explicit claim map; it never merges multiple claim objects.

Role and session-key identifiers match `^[a-z][a-z0-9_]*$`. `default_role` must be a member of `roles`. `subject_id` and `role` are reserved session keys. Standard JWT `sub` becomes `subject_id`; the selected role becomes `role`.

Session values are strings. PolicySQL performs no implicit string-to-number, string-to-boolean, JSON, date, or timezone coercion. A session reference is valid only where its string representation is compatible with the target logical descriptor. Identifiers represented as strings, including UUID and `int64` string formats, remain usable. A deployment needing numeric session values must model them as string-represented logical identifiers or adopt a future versioned typed-session contract.

The optional `PolicySQL-Role` header may select only a role in the verified token. Duplicate role or authorization headers are rejected. Other client headers cannot add or override trusted-session values.

`access` is a non-empty set containing only `catalog`, `explain`, and `execute`. It is checked before SQL parsing and is independent of role selection. Code-generation credentials use `catalog` and `explain` without `execute`.

An interactive transaction stores a fingerprint of issuer, subject, selected role, trusted session, and policy/schema snapshots. Every subsequent request is re-authenticated and must match that fingerprint. Token expiry or revocation known to the verifier prevents further operations and commit.

## Consequences

- Policy keys, JWT roles, Catalog roles, and role headers share one syntax.
- Hasura concepts remain a design reference; no Hasura claim name is part of this contract.
- Session-value comparisons are predictable and do not depend on SQLite affinity coercion.
- JWT verification remains independent from commit-check callback capabilities.
