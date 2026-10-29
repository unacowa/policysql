# ADR 0005: JWT and trusted-session contract

- Status: accepted; JWT verification moved to the identity adapter by
  [ADR 0020](0020-trusted-session-input-and-jwt-identity-adapter.md)

## Context

Policy selection and server-owned predicate values depend on authentication data. Claim names, role syntax, value types, and transaction binding must therefore be deterministic across identity providers and must not be inferred from arbitrary headers.

## Decision

### Trusted-session contract (library, validated in core)

The wrapper authenticates the caller and passes a trusted session (`principal`, `subject`, `roles`, `defaultRole`, `access`, `session`) to the library per request. The library validates it once, in Rust core ([ADR 0020](0020-trusted-session-input-and-jwt-identity-adapter.md)).

Role and session-key identifiers match `^[a-z][a-z0-9_]*$`. `defaultRole` must be a member of `roles`. `subject_id` and `role` are reserved session keys. `subject` becomes `subject_id`; the selected role becomes `role`. `principal` is an opaque, wrapper-namespaced identity; it is not a session value.

Session values are strings. PolicySQL performs no implicit string-to-number, string-to-boolean, JSON, date, or timezone coercion. A session reference is valid only where its string representation is compatible with the target logical descriptor. Identifiers represented as strings, including UUID and `int64` string formats, remain usable. A deployment needing numeric session values must model them as string-represented logical identifiers or adopt a future versioned typed-session contract.

The optional `PolicySQL-Role` header may select only a role in the trusted session. A repeated role header is rejected. Other client headers cannot add or override trusted-session values.

`access` is a non-empty set containing only `catalog`, `explain`, `execute`, and `debug`. It is checked before SQL parsing and is independent of role selection. Code-generation credentials use `catalog` and `explain` without `execute`. `debug` never grants execution by itself; a deployment must also explicitly enable developer execution traces before a response can expose the exact protected SQL sent at the database egress boundary.

An interactive transaction stores a fingerprint of principal, subject, selected role, trusted session, and database binding, and is pinned to the policy/schema snapshot. Every subsequent request must carry a trusted session that matches that fingerprint. The wrapper authenticates every request, so token expiry or revocation known to its verifier prevents further operations and commit.

### JWT profile (identity adapter, superseded in place by ADR 0020)

The JWT profile is now implemented by the optional identity adapter that wrappers call, not by the library: a signed JWT access token verified against one configured issuer, audience, algorithm allowlist, and JWKS source, with the canonical claims object `policysql` containing `roles`, `default_role`, `access`, and optional `session`. Standard JWT `sub` becomes `subject`, and `principal` is `JSON.stringify([iss, sub])`. A deployment may locate the claims object with one JSON Pointer or construct it with an explicit claim map in its own wrapper; it never merges multiple claim objects.

## Consequences

- Policy keys, session roles, Catalog roles, and role headers share one syntax.
- Hasura concepts remain a design reference; no Hasura claim name is part of this contract.
- Session-value comparisons are predictable and do not depend on SQLite affinity coercion.
- Credential verification remains independent from commit-check callback capabilities.
