# Security Policy

PolicySQL is not production ready.

Please report suspected authorization bypasses, parser differentials, unsafe SQL emission, session-parameter confusion, validation-hook bypasses, or transaction/check inconsistencies privately to the project maintainers.

Until a dedicated security address is configured, do not deploy this repository as a security boundary.

## Security-sensitive areas

- SQL parsing and statement splitting
- identifier and alias binding
- column provenance
- row-policy composition
- mutation pre-filter and post-check semantics
- parameter namespace separation
- SQL emission and re-parsing
- validation-hook request/response validation
- transaction handling
- result and resource limits
