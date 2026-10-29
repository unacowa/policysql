# ADR 0021: Explicit engine configuration and per-check validator endpoints

- Status: accepted
- Issue: #32 (stage 2 of [ADR 0019](0019-library-layers-and-the-wrapper-boundary.md))
- Related: [ADR 0007](0007-transaction-retry-and-commit-check-protocol.md),
  [ADR 0014](0014-wrapper-provided-database-bindings.md),
  [ADR 0018](0018-wrapper-owned-rate-limiting.md),
  [ADR 0020](0020-trusted-session-input-and-jwt-identity-adapter.md)

## Context

The engine read its settings from the Workers `env` object that `app.fetch` and the
Durable Object constructor received: `POLICYSQL_ENVIRONMENT` (`/healthz`),
`POLICYSQL_PUBLIC_BASE_URL` (commit-check callback URL), `POLICYSQL_COST_CATALOG_JSON`
(cost observation), and, for each commit check, the validator URL and HMAC secret from
the env names the policy gave in `hook.url_env` and `hook.hmac_secret_env`. `WorkerBindings`
also declared `POLICYSQL_IDEMPOTENCY_SECRET`, which no code read. `DatabaseProvider.check`
and `connect` received the same `env`.

So the engine knew the shape of a platform object, setting names were spread over several
modules, and a policy (portable, versioned data) named deployment secrets. ADR 0019 lists
`Config` as an engine port: the engine reads no `env` object.

## Decision

### `PolicySqlConfig`

One type, in `deploy/cloudflare/src/engine-config.ts`, is the whole configuration contract:

```ts
type PolicySqlConfig = {
  environment: string;            // reported by /healthz
  publicBaseUrl?: string;         // https origin validators call back
  costCatalog?: CostCatalog;      // cost observation bounds (an object, not JSON text)
  commitChecks?: Record<string, { url: string; hmacSecret: string }>; // by policy check id
};
```

- The wrapper builds it from whatever it owns (Workers `env`, a secret store, a file) and
  passes it to `createApp({ getRuntime, database, config })` and
  `new TransactionOwnerCore(state, { getRuntime, database, config, fetchImpl? })`.
- `validateConfig` runs once, at construction, before any database, Durable Object, or
  validator call. It rejects unknown keys, a malformed `environment`, a non-`https:` URL or
  one with credentials, a `publicBaseUrl` that is not a bare origin, a malformed cost
  catalog, a commit-check id that is not a policy identifier, an entry that is not exactly
  `{ url, hmacSecret }`, a secret shorter than 16 characters, and `commitChecks` entries
  without `publicBaseUrl`. Failures are `ConfigError` (a `TypeError`) whose message and
  `setting` name the setting, never its value. The validated value is frozen and copied;
  secrets are reachable only through a lookup function, so serializing or logging the
  configuration prints none.
- `costCatalog` stays optional: without it every cost observation is logged as
  `cost_observation_failed` with `POLICYSQL_COST_UNKNOWN` and opens no database work, as an
  absent env value did before. `POLICYSQL_IDEMPOTENCY_SECRET` is dropped, not moved.

### Commit-check endpoints: a per-check-id map

The wrapper supplies `commitChecks[checkId] = { url, hmacSecret }`. The policy hook keeps
only `timeout_ms`; `url_env` and `hmac_secret_env` are removed from the policy format,
the policy schema, and the compiled output (WASM ABI version 4). When a commit triggers
checks, the engine resolves every triggered id before granting any capability or calling
any validator. A missing entry (or a missing `publicBaseUrl`) rejects the commit with 409
`POLICYSQL_COMMIT_CHECK_REJECTED`, logs `commit_check_unconfigured` with the check id, and
contacts no validator, the same fail-closed result a missing env value had.

A resolver function in the configuration was rejected: it would run deployment code on the
commit path, could return a different endpoint per call, and could not be validated at
construction. A map is data, validated once, and identical in the Worker and the Durable
Object. Entries for ids the policy does not define are never used, so one configuration can
serve policy versions that add or remove checks.

### Construction on Workers

Workers delivers `env` per request and to the Durable Object constructor, not at module
load. `createPolicySqlWorker` therefore takes a wrapper-owned
`deployment: (env) => ({ database, config })` instead of a static `database`. The library
calls it with the `env` it was handed, once per `env` object for the Worker (memoized; the
first request builds and validates) and once per Durable Object instance, so both use the
same provider and configuration. A function that throws, or a configuration that fails
validation, makes every request 500 `POLICYSQL_INTERNAL` with a
`deployment_config_rejected` log carrying only the setting name or the error class, before
any runtime, database, owner, or validator work. The engine reads no property of `env`.

### Platform bindings that remain

`app.fetch(request, env, executionContext, context)` and `app.fetchCallback` keep their
`env` argument, typed `PlatformBindings = { TRANSACTION_OWNER: DurableObjectNamespace }`.
`TRANSACTION_OWNER` is the only platform read, in one place (`src/app.ts`), until the
`TransactionOwner` port replaces the Durable Object namespace (#31). A wrapper may pass its
whole `env`; nothing else in it is read. `ExecutionContext` is unchanged.

`DatabaseProvider.check(binding)` and `connect(binding, requestId)` no longer receive
`env`. The wrapper builds its provider from its own env (for example inside
`deployment(env)`), so the engine never hands a platform object to a port.

### Wrapper convention

The reference wrapper (`deploy/cloudflare/wrapper/config.ts`) and
`examples/database-routing/config.ts` keep the existing env names
(`POLICYSQL_ENVIRONMENT`, `POLICYSQL_PUBLIC_BASE_URL`, `POLICYSQL_COST_CATALOG_JSON`, and,
in the example, `VALIDATOR_URL` / `VALIDATOR_SECRET` for its `consistency` check), so
deployments keep working. These names are now the wrappers' convention, not the library's.

## Consequences

- Breaking change (beta, no compatibility layer): `createApp` and `TransactionOwnerCore`
  require `config`; `TransactionOwnerCore` takes `(state, dependencies)`; `DatabaseProvider`
  methods lose `env`; `createPolicySqlWorker` takes `deployment(env)` instead of `database`;
  `WorkerBindings` is replaced by `PlatformBindings`; policies with `hook.url_env` or
  `hook.hmac_secret_env` no longer load; the WASM ABI is version 4, which changes the runtime
  snapshot, so open transactions and idempotency records from before the change do not match.
- A deployment with an invalid setting now fails every request at the first use of the
  configuration instead of failing only the request that read the setting.
- A test parses library source with the TypeScript compiler and fails on any `env.` /
  `deployment.` member read, destructuring from such an object, `process.env`, a Hono
  binding the library does not build itself, or an import from `cloudflare:workers`, except
  the one `env.TRANSACTION_OWNER` read.
