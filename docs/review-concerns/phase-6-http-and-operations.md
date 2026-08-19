# Phase 6 concerns: HTTP and operations

## Decisions

- API major version is encoded in `/v1`; incompatible changes require a new path version.
- Unknown JSON fields, duplicate keys, invalid Unicode, ambiguous security headers, and oversized bodies are rejected.
- Generated clients send schema/policy snapshot preconditions through `expected`.
- Catalog and Capabilities use authenticated private caching with ETag revalidation.
- Capabilities distinguish compile-time structural limits from runtime-enforced time/result limits.
- OpenAPI 3.1 and JSON Schemas ship with the documentation and must agree within a release.

## Residual risks

- Error status normalization can hide useful diagnostics from clients. Detailed causes must remain available only in access-controlled logs keyed by request ID.
- Request IDs, traces, and metrics can become side channels if resource names, SQL, claims, parameters, or policy predicates are attached without filtering.
- A static documentation preview server is not a production publishing stack. The current VitePress dependency audit reports development-server advisories without a compatible fix.
- The generated static artifact has no production npm dependencies, but this does not make `vitepress dev` or `vitepress preview` suitable for public hosting.
- Capabilities cannot promise exact scanned-row or query-cost limits on engines that do not expose enforceable counters. Timeout and result limits are fallback controls, not cost isolation.
- Catalog and generated-type cache invalidation depends on deterministic version hashing and correct ETag variation by role and authentication context.

## Implementation checks

- Parse raw HTTP headers and JSON before framework normalization hides duplicates.
- Apply request-size and rate limits before expensive JWT, SQL, or YAML processing where possible.
- Emit `Vary: Authorization, PolicySQL-Role` where an HTTP cache can observe authenticated responses, and never use shared caching for Catalog.
- Validate OpenAPI and every JSON Schema in CI; parse every documentation JSON/YAML example.
- Use CSP, immutable hashed assets, HTTPS, and a static host for published documentation; keep preview servers inside a trusted development network.
- Audit dependency advisories regularly and replace the preview toolchain when a compatible patched release exists.
