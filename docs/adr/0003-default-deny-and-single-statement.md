# ADR 0003: Default deny and one statement per SQL item

- Status: accepted

## Decision

Every public field that carries SQL accepts exactly one supported statement. An atomic request may carry multiple SQL items, but each item is parsed, bound, authorized, emitted, and verified independently. Any unknown, unsupported, ambiguous, or unprovable construct is rejected.

## Rationale

Security policy cannot be safely preserved by partially understanding a statement. Requiring one statement per SQL item prevents statement smuggling and gives errors, parameters, expectations, resource accounting, and explanations an unambiguous statement index. Transaction-level orchestration is specified separately in ADR 0009.
