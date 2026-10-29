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
// Lower level: build the app and give each transaction owner its facilities yourself.
const app = createApp({ getRuntime, database, config, transactionOwners });
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
```

The transaction owner port is not configuration but a port next to `database`
([ADR 0022](adr/0022-transaction-owner-port.md)); `deployment(env)` returns it because on
Workers it is built from a binding. `TRANSACTION_OWNER` is the reference wrapper's binding
name, not the library's: the library reads no property of `env`. `createApp`'s
`app.fetch(request, { database, session }, background?)` takes no `env`;
`createPolicySqlWorker().app.fetch(request, env, executionContext, context)` passes `env` only
to `deployment(env)`. `DatabaseProvider.check(binding)` and `connect(binding, requestId)`
receive no `env`.

## Validation and failures

- Validated once, at construction (`createApp`, `TransactionOwnerCore`), or with
  `createPolicySqlWorker` at most once per `env` object, on the first request that carries
  it (a different `env` object is built and validated again), before any runtime, database,
  Durable Object, or validator call. `deployment(env)` should be a pure function of the
  bindings so the Worker and each Durable Object get the same configuration.
- `createApp` and `TransactionOwnerCore` throw `ConfigError` (a `TypeError`).
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
