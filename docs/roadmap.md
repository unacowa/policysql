# Roadmap

## Phase 0 — scaffold

- architecture and security docs;
- crate boundaries;
- example policy and fixtures;
- CI skeleton.

## Phase 1 — protected single-table SELECT

- parser selection;
- statement-count enforcement;
- logical catalog;
- binder;
- select column enforcement;
- policy predicate composition;
- policy limit;
- SQLite emission;
- emitted-SQL verification;
- explain output;
- adversarial tests.

## Phase 2 — joins and nested reads

- inner joins;
- outer joins with semantics-preserving policy placement;
- subqueries;
- CTEs;
- ordering;
- provenance and inference protections.

## Phase 3 — mutations

- insert values;
- delete;
- update literal/parameter assignments;
- presets;
- returning;
- external validation;
- atomic post-state checks.

## Phase 4 — Turso/libSQL adapter

- raw execution adapter;
- transaction/pipeline support;
- error normalization;
- time/row/byte limits;
- compatibility suite across reference SQLite and supported Turso engines.

## Phase 5 — gateway hardening

- authentication adapters;
- policy hot reload/versioning;
- catalog refresh/versioning;
- audit events;
- metrics and tracing;
- rate limiting;
- fuzzing and parser differential tests.

## Phase 6 — Cloudflare/Turso operational deployment

- versioned Rust/Wasm deployment ABI;
- Cloudflare HTTP listener and JWKS/JWT adapter;
- concrete sealed-plan-only remote Turso transport;
- Turso usage estimation, admission, and actual rows read/write reconciliation;
- Durable Object transaction ownership and owner-loss handling;
- staging and production configuration separation;
- observability, rate limits, runbooks, staged rollout, and rollback;
- persistent deployment and real-environment curl acceptance suite.

This phase follows
[`operational-deployment-implementation-plan.md`](operational-deployment-implementation-plan.md).
It is not complete when only traits, local mocks, or disposable spikes exist.

## Phase 7 — ecosystem

- TypeScript client;
- role-specific generated types;
- CLI for explain and policy validation;
- policy editor/schema tooling;
- optional MCP tools for constrained AI access.
