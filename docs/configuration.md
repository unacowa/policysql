# Engine configuration (`PolicySqlConfig`)

This is the complete list of deployment settings the library takes. The type and its
validation live in `deploy/cloudflare/src/engine-config.ts` and are exported from
`@unacowa/policysql/cloudflare`. The decision is
[ADR 0021](adr/0021-explicit-engine-config.md).

The library reads no platform `env` object for these values. The wrapper builds the object
from whatever it owns and passes it in; env names are the wrapper's convention.

| Setting | Required | Meaning |
| --- | --- | --- |
| `environment` | yes | Deployment name reported by `/healthz` as `environment`. 1-64 of `[A-Za-z0-9_.:-]`. |
| `publicBaseUrl` | when `commitChecks` has an entry | `https:` origin (no path, query, fragment, or credentials) that validators call back at `/v1/commit-checks/<id>/query`. |
| `costCatalog` | no | `{ maxEstimatedRowsRead, maxEstimatedRowsWritten, resources: { "<resource id>": { upperRows } } }`, positive integers. Without it, cost observations are logged as `POLICYSQL_COST_UNKNOWN` and open no database work. |
| `commitChecks` | no | `{ "<policy check id>": { url, hmacSecret } }`. `url` is `https:` without credentials; `hmacSecret` has at least 16 characters. A triggered check without an entry rejects the commit with 409 `POLICYSQL_COMMIT_CHECK_REJECTED` and calls no validator. |

Any other key is rejected, so a misspelled or legacy setting cannot silently fall back.

## Where it goes

```ts
// Engine operations without HTTP (ADR 0023): in-process calls or a service binding.
const engine = createEngine({ getRuntime, database, config, transactionOwners });
const result = await engine.execute({ bodyText, idempotencyKey, role }, { database: binding, session, requestId });

// The engine with the canonical HTTP mapping; `app.engine` is the same engine.
const app = createApp({ getRuntime, database, config, transactionOwners });
// Or put the HTTP mapping over an engine you built: createHttpAdapter(engine).
const owner = new TransactionOwnerCore(facilities, { getRuntime, database, config });
const owner = new TransactionOwnerCore(facilities, { getRuntime, database, config });

// Workers: env arrives per request and in the Durable Object constructor, so the
// wrapper supplies a function. The Worker and every Durable Object call it with their env.
const worker = createPolicySqlWorker({
  catalog, policy, physicalSchema, schemaVersion, policyVersion, limits,
  deployment: (env) => ({
    database: registry.provider(env),
    config: configFromEnv(env),
    transactionOwners: durableObjectTransactionOwners(env.TRANSACTION_OWNER),
  }),
});
export const TransactionOwner = durableObjectTransactionOwnerClass(worker.ownerDependencies);
// A service binding or other non-HTTP entry point on Workers: the same engine as worker.app.
const engineForEnv = worker.engine(env);
```

The transaction owner port is not configuration but a port next to `database`
([ADR 0022](adr/0022-transaction-owner-port.md)); `deployment(env)` returns it because on
Workers it is built from a binding. `TRANSACTION_OWNER` is the reference wrapper's binding
name, not the library's: the library reads no property of `env`. `createApp`'s
`app.fetch(request, { database, session, requestId? }, background?)` takes no `env`;
`createPolicySqlWorker().app.fetch(request, env, executionContext, context)` passes `env` only
to `deployment(env)`. `DatabaseProvider.check(binding)` and `connect(binding, requestId)`
receive no `env`.

## Runtime limits (`RuntimeLimits`)

Limits are configured in exactly one place: the `limits` object the wrapper passes to
`createPolicySqlWorker` (or `createRuntimeFactory`), typed `RuntimeLimits`
(`deploy/cloudflare/src/limits.ts`). The runtime validates them when it is constructed,
fills the defaults, and reports the effective values (`PolicySqlRuntime.limits_json()`). The
engine enforces exactly those values, and Capabilities advertises exactly them; there is no
separate public override ([ADR 0024](adr/0024-transaction-step-machine.md), "One place for
limits").

| `RuntimeLimits` key | Constructor field | Default | Range | Enforced where |
| --- | --- | --- | --- | --- |
| `maxRows` | `max_rows` | required | 1 to 2^53 - 1 | core, per statement (policy `limit` may lower it) |
| `maxResultBytes` | `max_result_bytes` | required | 1 to 2^53 - 1 | core, per statement; the engine, cumulatively per atomic envelope |
| `timeoutMs` | `timeout_ms` | required | 1 to 2^53 - 1 | the engine's database deadline per statement |
| `maxStatements` | `max_statements` | required | 1 to 2^32 - 1 | core, statements per atomic envelope |
| `transactionMs` | `transaction_ms` | 4,000 | 1 to 60,000 | owner: interactive deadline from begin (and its expiry timer); atomic owner execution deadline |
| `maxTransactionStatements` | `max_transaction_statements` | 8 | 1 to 256 | owner: statements per interactive transaction; callback query sequence per commit check |
| `maxTransactionResultBytes` | `max_transaction_result_bytes` | 64,000 | 1 to 65,536 | owner: cumulative result bytes per interactive transaction and per commit check's callbacks |
| `maxCallbackRows` | `max_callback_rows` | 100 | 1 to 10,000 | owner: cumulative callback rows per commit check |
| `beginTimeoutMs` | `begin_timeout_ms` | 1,000 | 1 to 60,000 | owner: BEGIN of an interactive transaction |
| `costTimeoutMs` | `cost_timeout_ms` | 1,000 | 1 to 10,000 | engine and owner: connection deadline and BEGIN of the after-response cost observation |

The `maxTransactionResultBytes` ceiling keeps an owner record, which stores the last
response, inside a Durable Object value. Ranges keep every value an exact JavaScript integer.

Fixed protocol constants are enforced by core and not configurable; the runtime reports them
with the limits so Capabilities reads them from the same place: `maxRequestBytes` (1,048,576;
the HTTP adapter's body bound `MAX_BODY_BYTES` must equal it), `maxSqlBytes` (65,536),
`maxJoins` (8), `maxCommitChecks` (4), `maxHookDurationMs` (1,500), and `maxBytesPerValue`
(262,144, from `max_bytes_per_value`). The provider timeout of 1,000 ms in `database.ts` is an
adapter bound, not a limit, and stays there.

Failures, all at construction and before any request is served:

- `createRuntimeFactory` (and so `createPolicySqlWorker`) throws a `TypeError` naming the key
  for a non-object, an unknown key (`limits.<key> is not a runtime limit`), or a value that is
  not a positive safe integer (`limits.<key> must be a positive integer`). A misspelled key
  never falls back to a default.
- Runtime construction, on the first request, rejects a missing required field or an
  out-of-range value with an error that starts `runtime limits are invalid:` and names the
  constructor field. The Worker answers 500 `POLICYSQL_INTERNAL`; the message is never sent to a client.
- Changing a limit does not change the deployment snapshot, as before: limits are not part
  of it.

## Validation and failures

- Validated once, at construction (`createEngine`, `createApp`, `TransactionOwnerCore`), or with
  `createPolicySqlWorker` at most once per `env` object, on the first request that carries
  it (a different `env` object is built and validated again), before any runtime, database,
  Durable Object, or validator call. `deployment(env)` should be a pure function of the
  bindings so the Worker and each Durable Object get the same configuration.
- `createEngine`, `createApp`, and `TransactionOwnerCore` throw `ConfigError` (a `TypeError`).
  `worker.engine(env)` throws it too, since there is no HTTP response to report it in.
  `createPolicySqlWorker` answers every request with 500 `POLICYSQL_INTERNAL` and logs
  `deployment_config_rejected` with the setting name, or with only the error class when the
  wrapper's own `deployment(env)` threw.
- Messages, the `setting` field, and logs never contain a configured value. The validated
  object is frozen, and its secrets are reachable only through a lookup, so serializing it
  prints none.

## Reference env conventions

The reference wrapper (`deploy/cloudflare/wrapper/config.ts`) and
`examples/database-routing/config.ts` read:

| Env name | Setting |
| --- | --- |
| `POLICYSQL_ENVIRONMENT` | `environment` |
| `POLICYSQL_PUBLIC_BASE_URL` | `publicBaseUrl` |
| `POLICYSQL_COST_CATALOG_JSON` | `costCatalog` (parsed JSON) |
| `VALIDATOR_URL`, `VALIDATOR_SECRET` (example only) | `commitChecks.consistency` |

The reference wrapper maps further checks in `COMMIT_CHECK_ENV` (check id to its two env
names); the development policy defines none.
