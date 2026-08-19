# ADR 0001: Use Rust for the policy compiler

- Status: accepted

## Context

PolicySQL is security-sensitive compiler infrastructure requiring precise AST handling, deterministic transformations, strong domain types, fuzzing, and low-overhead deployment.

## Decision

Use Rust for the initial compiler, gateway core, and Turso adapter.

## Consequences

- Strong type modeling and explicit error handling are available.
- The project can share code between a service and potential embedded/WASM deployments where supported.
- Parser/library selection must be evaluated carefully rather than assumed.
- Generated clients may use other languages; the public interface remains SQL over HTTP.
