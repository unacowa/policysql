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
| `maxBytesPerValue` | `max_bytes_per_value` | 262,144 | 1 to 1,048,576 | decoded bytes of one bytes value: core (client parameters, policy presets at activation, result cells of `SELECT` and `RETURNING`), the engine and the Turso transport (driver values, before decoding); over it is 413 `POLICYSQL_LIMIT_EXCEEDED` (malformed input stays 400 `POLICYSQL_INVALID_PARAMETER`); the smallest applicable limit governs, see "Per-value bytes" |
| `maxParameters` | `max_parameters` | 1,024 (was 128) | 1 to 16,384 | binder: distinct client parameter names in one statement; over it is 413 `POLICYSQL_LIMIT_EXCEEDED` |
| `maxExpressionDepth` | `max_expression_depth` | 32 | 1 to 64 | binder: expression depth of the client's SQL (an n-term `OR` chain has depth n); over it is 413 `POLICYSQL_LIMIT_EXCEEDED` |
| `maxProjections` | `max_projections` | 128 | 1 to 2,000 | binder: result columns of one `SELECT` or `RETURNING` in the client's SQL; over it is 413 `POLICYSQL_LIMIT_EXCEEDED` |
| `maxJoins` | `max_joins` | 8 | 1 to 63 | binder: joins in one `FROM` of the client's SQL; over it is 413 `POLICYSQL_LIMIT_EXCEEDED` |

#### Per-value bytes

`maxBytesPerValue` bounds the decoded bytes of one **bytes** value, nothing else: a bytes client
parameter, a bytes preset in the policy (checked when the policy is activated, so a deployment cannot
configure a preset it would refuse to read or write; the 1 MiB configuration input bounds a preset
too, so a preset of the hard maximum is not reachable), a bytes cell of a result (`SELECT`,
`RETURNING`, a commit check's callback query), and the BLOB values the database driver returns (the
adapter and the Turso transport classify a BLOB over the limit before they decode it). Text, JSON,
and numeric values are not bytes values: a text or JSON parameter longer than `maxBytesPerValue` is
bounded by the request limits only. Its hard maximum, 1,048,576, is the largest value whose base64
form (1,398,104 bytes) can fit the largest request. A value over the limit is 413
`POLICYSQL_LIMIT_EXCEEDED`; an input that is not canonical padded base64 is 400
`POLICYSQL_INVALID_PARAMETER` however long it is. Capabilities advertises the configured value as
`limits.maxBytesPerValue`.

It is an upper bound, not a promise. On every path **the smallest applicable limit governs**, and a
value within `maxBytesPerValue` can still be refused by another limit, with that limit's own code:

| Path | Largest bytes value | A larger value is |
| --- | --- | --- |
| Written as a parameter | its base64 form and the rest of the body must fit `maxRequestBytes`: at most about `3/4 x maxRequestBytes` (786,432 bytes at the default; a value of 1,048,576 bytes needs `maxRequestBytes` of at least 1,398,104 plus the envelope, for example 2,097,152) | 413 `POLICYSQL_REQUEST_TOO_LARGE` before parsing |
| Read in a result (`SELECT`, `RETURNING`) | `maxResultBytes` counts the public encoding of the rows (base64 of a BLOB, the row object included): at most about `3/4 x maxResultBytes`, so about 47,990 bytes at the reference wrapper's 64,000 | 413 `POLICYSQL_LIMIT_EXCEEDED`, rolled back |
| Read in a result, raw database response | the raw result bound that exists today is 1 MiB per statement (core's `EVENT_RESULT_BYTES`; pull request 6 of ADR 0027 replaces it with a bound compiled from `maxResultBytes`): the base64 form of the value and the Hrana frame of the row must fit it, so at most about 786,000 bytes whatever `maxResultBytes` is | 413 `POLICYSQL_LIMIT_EXCEEDED`, rolled back |
| Read in an interactive transaction | the same, and `maxTransactionResultBytes` (at most 65,536) counts the result cumulatively | 413 `POLICYSQL_TRANSACTION_LIMIT_EXCEEDED` |
| `maxSqlBytes` | does not apply: a parameter is not SQL text | |

So a value can be written but not returned: ADR 0016 accepts a value that fits as a parameter but is
too large to `RETURNING`, and a value another system wrote can be too large to read. At the hard
maximum a value of 1,048,576 bytes can be written (with a large enough `maxRequestBytes`) and read
only by a deployment whose result bounds admit it; at the defaults it can be neither. The reference
wrapper sets `maxBytesPerValue` to 262,144 explicitly, and with `maxResultBytes` 64,000 it reads
values only up to about 47,990 bytes.

The computed internal bounds (above) never reject a value `maxBytesPerValue` accepts: a value is part
of the body, which is bounded by `maxRequestBytes`, and the compile input, the hash input, and the
step event are computed from that, with the factor 2 for the JSON escaping of the body text (base64
has no character that escapes, so a BLOB never reaches it). `deploy/cloudflare/test/value-limit.test.mjs`
and `crates/policysql-wasm/src/value_limit_tests.rs` pin each path above at the limit and one over, at
the default and at the hard maximum.

#### Input-side limits promise nothing about the emitted statement

`maxParameters`, `maxExpressionDepth`, `maxProjections`, `maxJoins` (and `maxSqlBytes`) bound what
PolicySQL itself spends parsing and binding the client's SQL. They do not promise that a request
within them compiles: the statement PolicySQL emits is the client's SQL composed with the policy's
row filters, companion columns, and server parameters, and the downstream (the pinned `turso_parser`,
SQLite) has limits of its own. No construction check relates the two. PolicySQL measures the actual
emitted statement instead (ADR 0027, "Emitted statement complexity") and answers one fixed error,
`POLICYSQL_SQL_TOO_COMPLEX` (400, path `/statements/<i>`), when it reaches one of:

| Cause (log `cause`) | Limit | Counted |
| --- | --- | --- |
| `height` | the parser's expression height, 100 | exactly, on the AST about to be printed (a parenthesis adds 1, a binary node 1 plus the taller operand, the count restarts inside a subquery) |
| `recursion` | the parser's expression recursion depth, 100 | exactly, on the same AST (it accumulates across `EXISTS` and other subqueries) |
| `columns` | 2,000 result columns | exact count of the emitted columns, visibility companions and the check column included |
| `parameters` | 32,766 host parameters | exact count of the emitted parameters, client and server |
| `like_pattern` | 50,000 bytes | exact byte length of a `LIKE`/`GLOB` pattern that is a bound value, when parameters are bound |
| `column_metadata` | 1,048,576 bytes per envelope | exact `Σ (2·|alias| + 2·|declared type| + 32)` over every emitted column of the envelope |
| `columns`, `parameters`, `like_pattern`, `database_expression_depth`, `function_arguments`, `compound_terms`, `join_tables` | the database's own refusal | a statement request whose Hrana error has `code` `SQLITE_ERROR` and a message that starts with an entry of the allowlist in `deploy/cloudflare/src/database-complexity.ts` |

The error is detected before COMMIT, so nothing is committed. In an interactive transaction the
transaction closes as `failed` and is rolled back, and later commands answer 409
`POLICYSQL_TRANSACTION_UNAVAILABLE`. A database error that no allowlist entry names stays 503
`POLICYSQL_DATABASE_UNAVAILABLE` and is logged as `database_error_unclassified` with the Hrana
`code` only. The log events `sql_too_complex` (statement index, schema and policy versions, ABI
version, fixed cause), `emitted_sql_reparse_failed`, and `database_error_unclassified` never
carry SQL text, parameters, policy or column names, or the parser's or the database's message. Any
other failure to parse the emitted SQL again is an emitter fault, 500 `POLICYSQL_INTERNAL`; client
SQL the parser itself refuses is still 400 `POLICYSQL_INVALID_SQL`.

Two consequences for choosing the limits. A deployment that raises depth or joins accepts that
more statements end in `POLICYSQL_SQL_TOO_COMPLEX`. And because each filtered inner join adds 2 to
the emitted expression height (the row filters compose as a left-deep `AND`), the upper part of the
`maxJoins` range (up to 63) is reachable only without row filters: with a filter per joined
resource, a statement of more than about 45 joins is `POLICYSQL_SQL_TOO_COMPLEX` however simple its
predicate is.

The database allowlist is verified against the real Turso database by the release smoke
(`deploy/cloudflare/scripts/provision-dev.mjs`): the entries marked `smokeVerified` in
`database-complexity.ts` (`too many columns in`, `too many arguments on function`, `too many terms in
compound SELECT`, `LIKE or GLOB pattern too complex`, `Expression tree is too large`) are sent as
real statements and the smoke fails if one stops matching; `too many SQL variables` and `at most 64
tables in a join` are derived from SQLite's source and covered by unit tests only, because a real
statement that produces them is not reachable cheaply.

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

The runtime reports one limit more than it lets a wrapper configure yet. It is fixed today and
becomes configurable in a following pull request of
[ADR 0027](adr/0027-byte-and-cpu-budgets.md): `maxResponseBytes` (`maxResultBytes` + 65,536,
reported but not enforced or advertised before pull request 6). The binder's input-side limits became
configurable in pull request 4 and `maxBytesPerValue` in pull request 5 (above; the latter was the
`max_bytes_per_value` getter, which is removed, so every reader takes it from `limits_json`). Fixed
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
| WASM compile input (verified auth + request) | `(2 A + 1,024) + R + 1,024` | 1,181,696 |
| `identity_json` and `cost_estimate_json` input | `(2 A + 1,024) + 2,048 + 128 + 2 R + 1,024` | 2,232,448 |
| Step event | `2 R + (2 A + 1,024) + 2,048 + max_statements x 1 MiB + 4,096` | 10,624,000 with 8 statements |

The auth is at most `2 A + 1,024`, not `A + 1,024`: it carries the role the client selected with
`PolicySQL-Role`, which is one of the session's `roles`, so a long role name appears twice (as `role`
and inside `roles`). Role names have no length limit of their own, so the bound is `2 A`; the
auth bound is a check on our own value, and one over it is 500 `POLICYSQL_INTERNAL`, not a client
error. The factor 2 on `R` is the JSON escaping of the body text embedded in a hash input or an event (every
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
