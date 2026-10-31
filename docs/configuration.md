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
| `maxRequestBytes` | `max_request_bytes` | 1,048,576 | 65,536 to 2,097,152 | HTTP adapter (streamed, a declared `Content-Length` over it is refused unread), engine (UTF-8 bytes of the text as received, a byte order mark counted), core (derived bounds); over it is 413 `POLICYSQL_REQUEST_TOO_LARGE` |
| `maxJsonValues` | `max_json_values` | 65,536 | 1,024 to 131,072 | engine: JSON values plus object member names in one request body, counted by the scan that checks duplicate keys, which stops at the first value over the limit, before `JSON.parse` and before WASM; over it is 413 `POLICYSQL_REQUEST_TOO_LARGE`. (Its result-side meaning, cells, companion cells, and column descriptors of a raw database response, arrives with ADR 0027 pull request 6.) |
| `maxSqlBytes` | `max_sql_bytes` | 65,536 | 1,024 to 1,048,576, and at most `maxRequestBytes` | core, UTF-8 bytes of one statement's `sql`, checked before any statement is parsed; over it is 413 `POLICYSQL_REQUEST_TOO_LARGE` with path `/statements/<i>/sql` (it was 400 `POLICYSQL_INVALID_REQUEST`) |

The `maxTransactionResultBytes` ceiling keeps an owner record, which stores the last
response, inside a Durable Object value. Ranges keep every value an exact JavaScript integer.
Construction also rejects a combination that could make the step machine's durable
transaction record exceed its 96 KiB bound (ADR 0024 "Bounds"): the last reply, bounded by
`maxTransactionResultBytes`, plus one recorded mutation per statement
(`maxTransactionStatements` times the longest Catalog resource name), plus the snapshot and
version strings. With the defaults every Catalog fits (resource names up to 1,024 bytes); at
both maxima (256 statements, 65,536 bytes) resource names of up to about 50 bytes fit. The
error names both fields.

The request limits are explicit in the reference wrapper (`wrapper/limits.ts`); the engine
reads them from the runtime, so the HTTP adapter has no body limit of its own (the exported
`MAX_BODY_BYTES` is gone: the engine hands its reader `maxRequestBytes`). A construction error
names the field: below the minimum, above the hard maximum, or `max_sql_bytes` above
`max_request_bytes`.

The runtime reports more limits than it lets a wrapper configure yet. They are fixed today and
become configurable in the following pull requests of
[ADR 0027](adr/0027-byte-and-cpu-budgets.md), so `limits_json` (and the ABI) changes once:
`maxBytesPerValue` (262,144; it was the `max_bytes_per_value` getter, which is removed, so every
reader takes it from `limits_json`), the binder's input-side limits `maxParameters` (128),
`maxExpressionDepth` (32), `maxProjections` (128), and `maxJoins` (8), and `maxResponseBytes`
(`maxResultBytes` + 65,536, reported but not enforced or advertised before pull request 6). Fixed
protocol constants stay reported too: `maxCommitChecks` (4) and `maxHookDurationMs` (1,500). Capabilities
advertises exactly the enforced ones: `maxRows`, `maxResultBytes`, `timeoutMs`, `maxStatements`,
`maxRequestBytes`, `maxJsonValues`, `maxSqlBytes`, `maxBytesPerValue`, `maxParameters`,
`maxExpressionDepth`, `maxProjections`, and `maxJoins`. The provider timeout of 1,000 ms in
`database.ts` is an adapter bound, not a limit, and stays there.

### Bounds the library computes

Three bounds on the request path are not limits: they are memory guards computed by core from
`maxRequestBytes` (ADR 0027 "Derived internal bounds"), never configured and never advertised,
and never smaller than the largest input the configured limits admit. With `A` = 65,536 (the
session JSON the wrapper supplies; a larger one is a wrapper fault, 500 `POLICYSQL_INTERNAL`) and
`R` = `maxRequestBytes`:

| Bound | Formula | At the default `R` |
| --- | --- | --- |
| WASM compile input (verified auth + request) | `(A + 1,024) + R + 1,024` | 1,116,160 |
| `identity_json` and `cost_estimate_json` input | `(A + 1,024) + 2,048 + 128 + 2 R + 1,024` | 2,166,912 |
| Step event | `2 R + (A + 1,024) + 2,048 + max_statements x 1 MiB + 4,096` | 10,558,464 with 8 statements |

The factor 2 is the JSON escaping of the body text embedded in a hash input or an event (every
`"` and `\` doubles). The `max_statements x 1 MiB` term is the result side, which ADR 0027 pull
request 6 replaces with the compiled raw bound. Exceeding a derived bound is reported as the limit
it derives from (413 `POLICYSQL_REQUEST_TOO_LARGE`), never as 400. Two replies PolicySQL reads from
outside have fixed 65,536-byte bounds, read as a byte stream and cancelled at the first chunk over
them: a database control reply (BEGIN, COMMIT, ROLLBACK, close), where over the bound is 503
`POLICYSQL_DATABASE_UNAVAILABLE`, or for COMMIT an unknown outcome (500 or 503, or
`POLICYSQL_COMMIT_OUTCOME_UNKNOWN` for an interactive COMMIT), never a rejection and never a
limit (ADR 0007); and a validator (commit-check) reply, where over the bound denies the commit as
a failed validator.

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
| `V_req`, `V_res` | JSON values in the request body (values plus object member names) and in the raw result (cells including companions, column descriptors, values inside JSON cells). `maxJsonValues` bounds the request side since ADR 0027 pull request 3; the result side is enforced from pull request 6, and the formula already counts it | 65,536 each |
| `C0` | fixed cost of a request | 5 ms |
| `a_b` | cost per MiB of request bytes (SQL text included) and of result text | 80 ms per MiB |
| `a_v` | cost per JSON value | 1.3 microseconds |
| `F` | Workers CPU time over reference-machine time | 2.0 (the maintainers' value; the first measurement on the dev deployment found 1.2 to 7.7, see ADR 0027 "Pull request 1 results") |
| `S` | safety margin: isolates tolerate occasional overruns, not sustained ones | 1.25 |

Since pull request 3 the formula's request side is a bound a client cannot exceed: a body past `maxJsonValues` is 413 before it is parsed. (Before it, a body of about 1 MB of nested arrays was accepted with about 500,000 values, which the formula prices at 731 ms of reference time.) The measurement script and the release smoke size their densest request shapes by that limit (`REQUEST_VALUE_BUDGET`, 65,536 minus 64 values for the envelope), so a 1 MB body of nested arrays is now about 130 KB.

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
