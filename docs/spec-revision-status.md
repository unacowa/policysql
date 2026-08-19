# External specification revision status

This ledger tracks the cross-document external-specification review. A phase is complete only when normative documents, user documentation, machine-readable contracts, fixtures, and cross-document validation agree.

| Phase | Scope | Status | Concern record |
| --- | --- | --- | --- |
| 1 | Policy-nullable columns and result identity | complete | `review-concerns/phase-1-policy-nullable.md` |
| 2 | JWT, role selection, and trusted session | complete | `review-concerns/phase-2-authentication.md` |
| 3 | SQL subset, policy DSL, aggregation, and mutations | complete | `review-concerns/phase-3-sql-and-policy.md` |
| 4 | Transaction and commit-check protocols | complete | `review-concerns/phase-4-transactions.md` |
| 5 | Logical types, Catalog, and client contracts | complete | `review-concerns/phase-5-types-and-clients.md` |
| 6 | HTTP-wide versioning, limits, errors, and operations | complete | `review-concerns/phase-6-http-and-operations.md` |
| 7 | Parser, emitter, advanced SQL binding, Turso transaction, MVCC, type, and Cloudflare failure feasibility spike | spike complete; revisions pending | `review-concerns/phase-7-implementation-feasibility-spike.md` |

The product implementation roadmap in `roadmap.md` is separate. Completing this ledger means the external contract is internally consistent and testable; it does not claim that every runtime component has been implemented.

## Validation snapshot

Validated on 2026-08-03:

- five JSON Schemas and ten OpenAPI operations;
- eleven policy, seven SQL, seven authentication, three Catalog, two Catalog-manifest, and five Atomic Execute fixtures;
- 48 JSON and 53 YAML documentation blocks, including Atomic Execute request schema checks;
- VitePress static build and route rendering;
- `cargo fmt`, strict workspace Clippy, workspace unit tests, and doc tests.

The static documentation artifact has no production npm dependency vulnerabilities (`npm audit --omit=dev`). The local VitePress preview toolchain has three unresolved development-server advisories; see the Phase 6 concern record. Preview is for the trusted development network, not production publication.
