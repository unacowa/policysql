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
Construction also rejects a combination that could make the step machine's durable
transaction record exceed its 96 KiB bound (ADR 0024 "Bounds"): the last reply, bounded by
`maxTransactionResultBytes`, plus one recorded mutation per statement
(`maxTransactionStatements` times the longest Catalog resource name), plus the snapshot and
version strings. With the defaults every Catalog fits (resource names up to 1,024 bytes); at
both maxima (256 statements, 65,536 bytes) resource names of up to about 50 bytes fit. The
error names both fields.

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

## CPU model

The library does not refuse a limit for CPU reasons: the CPU limit, the platform and its speed are
deployment knowledge ([ADR 0027](adr/0027-byte-and-cpu-budgets.md), "The library does not refuse a
combination"). A wrapper sets its CPU limit from the limits it configures with

```
cpu_ms >= S x F x (C0 + a_b x (R + B) + a_v x (V_req + V_res))
```

| Symbol | Meaning | Value |
| --- | --- | --- |
| `R` | request bytes the limits allow, MiB (`maxRequestBytes`) | 1 |
| `B` | raw result bytes not attributable to values, MiB: the larger of `2 x maxResultBytes + 512 x maxStatements + 1,048,576` and the idempotency lookup bound 1,183,744 | 1.13 at the reference wrapper's limits |
| `V_req`, `V_res` | JSON values in the request body (values plus object member names) and in the raw result (cells including companions, column descriptors, values inside JSON cells). `maxJsonValues` is 65,536 by ADR 0027 but the runtime neither enforces nor reports it before the request-budget pull request (ADR 0027 pull request 3), so the wrapper test uses that default | 65,536 each |
| `C0` | fixed cost of a request | 5 ms |
| `a_b` | cost per MiB of request bytes (SQL text included) and of result text | 80 ms per MiB |
| `a_v` | cost per JSON value | 1.3 microseconds |
| `F` | Workers CPU time over reference-machine time | 2.0 (the maintainers' value; the first measurement on the dev deployment found 1.2 to 7.7, see ADR 0027 "Pull request 1 results") |
| `S` | safety margin: isolates tolerate occasional overruns, not sustained ones | 1.25 |

Until then the formula does not bound a request's value count: a body of about 1 MB of nested arrays is accepted today with about 500,000 values, which the formula prices at 731 ms of reference time (1,828 ms of `cpu_ms` at F = 2.0), although it measures about 200 ms. Re-measure after pull request 3.

The coefficients are for the reference machine (i7-7700K 4.2 GHz, Node, the release WASM): the worst
measured shape per term. At the reference wrapper's limits the formula gives about 346 ms on the
reference machine and 864 ms for `cpu_ms` (`wrangler.jsonc` rounds up to 1,000). The code is
`deploy/cloudflare/scripts/lib/cpu-model.mjs`; `test/cpu-budget.test.mjs` checks the reference
wrapper's `limits.cpu_ms` against it. A wrapper that raises a limit raises `cpu_ms` by the formula
or lowers the limit; re-measure on its own shapes with `npm run measure:cpu` and read the real
Workers CPU from the release smoke (`deploy/cloudflare/README.md`, "Measuring CPU").

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
