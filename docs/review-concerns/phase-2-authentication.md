# Phase 2 concerns: authentication

## Decisions

- Public endpoints use asymmetric JWT verification with fixed issuer, audience, algorithm allowlist, and JWKS configuration.
- Canonical PolicySQL claims use the `policysql` namespace by default but may be sourced from one configured JSON Pointer or explicit mapping.
- Roles and session keys use lowercase snake_case. `subject_id` and `role` are reserved.
- Session values remain strings and are not implicitly coerced. Policy activation checks compatibility with target logical descriptors.
- Interactive transaction requests are re-authenticated and matched to an immutable session fingerprint.
- JWT `access` separates Catalog, Explain, and execution endpoints; build credentials receive only `catalog` and `explain`.

## Residual risks

- JWT revocation is only as current as the deployment's verifier and key/revocation strategy. Short token lifetimes remain necessary.
- String-only session values cannot directly represent number-represented logical columns. This is intentional; a future typed-session format requires a new versioned contract.
- JWKS fetching is outbound network access and can become SSRF or availability risk if operators allow arbitrary URLs or unrestricted redirects.
- A valid bearer token can be replayed until expiry unless the deployment adds sender-constrained tokens or an external replay-control layer.

## Implementation checks

- Reject duplicate `Authorization` and `PolicySQL-Role` headers before framework normalization loses multiplicity.
- Validate `default_role` membership after JSON Schema validation.
- Bound JWKS response bytes, cache entries, refresh frequency, redirects, and fetch time.
- Compare transaction session fingerprints in constant-time where secret-derived hashes are used.
- Never include raw JWTs or full session values in logs, traces, errors, or commit-check requests beyond explicitly documented fields.
- Reject every endpoint before SQL parsing when the required JWT access value is absent.
