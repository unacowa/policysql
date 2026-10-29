# ADR 0022: The TransactionOwner port and the Durable Objects adapter

- Status: accepted
- Issue: #31 (stage 2 of [ADR 0019](0019-library-layers-and-the-wrapper-boundary.md))
- Related: [ADR 0007](0007-transaction-retry-and-commit-check-protocol.md),
  [ADR 0014](0014-wrapper-provided-database-bindings.md),
  [ADR 0021](0021-explicit-engine-config.md)

## Context

Routes called `env.TRANSACTION_OWNER.idFromName(...)` and `owner.fetch("https://owner/...")`,
and `TransactionOwnerCore` used `state.storage`, `setAlarm`, and `waitUntil` directly. ADR 0019
names `TransactionOwner` as an engine port with Durable Objects as one outbound adapter, and
ADR 0021 left `env.TRANSACTION_OWNER` as the last platform read until this port existed.

## Decision

### The port (`src/transaction-owner-port.ts`)

Two sides, both plain interfaces:

- **Routing.** `TransactionOwnerPort.route(name)` returns a `TransactionOwnerHandle` for the
  owner of `name` (`tx_` + 32 hex, from the transaction or validation id). The handle is typed:
  `begin`, `atomic`, `command(kind)`, and `callbackQuery`, each taking JSON data and a request
  id and returning `{ status, body }`, which the route sends to the client unchanged. (Since
  [ADR 0023](0023-operations-api-and-http-adapter.md) the reply is `{ ok, value }` or
  `{ ok, error }`, without a status.)
- **Owner-side facilities.** An adapter creates one `TransactionOwnerCore(facilities,
  dependencies)` per live owner. `facilities` are `store` (`get` / `put`, durable, values
  copied), `timer` (`schedule(atMs)`, one per owner, a later call replaces the earlier; on
  firing the adapter calls `core.onTimer()`), and `background` (`BackgroundTasks.run(task)`).
  `dependencies` are the ports of ADR 0021.

Contract every adapter keeps (the conformance suite checks it):

- At most one live owner per name, and every call for that name reaches it, in the order it
  arrived (see below).
- An owner may be lost. Its successor sees the same store and timer but none of the lost
  owner's memory, and the lost owner never writes again. The open database transaction lives
  only in memory, so the core fails it closed exactly as before (ADR 0007): no reconnection,
  no resumed transaction, no commit reported. A command that was in flight fails (500); later
  commands get 409 `POLICYSQL_TRANSACTION_UNAVAILABLE`. The record becomes `failed`, or, when
  the loss happened while a commit waited on its validator, stays `validating` until the timer
  expires it.
- Inputs and replies cross a data boundary; the owner validates every input as untrusted.
- The store is private to its owner: only the live owner of a name reads or writes that name's
  store, through the adapter. No conformance test can observe this, so it is stated as an
  obligation; [ADR 0024](0024-transaction-step-machine.md) relies on it instead of
  authenticating the stored state.

Serialization stays in the core: client commands run one at a time in the order they reach
the owner, callback queries likewise on a second lane (they arrive while a commit on the first
lane waits for its validator), and `onTimer` is not queued, so expiry also ends a commit
blocked on a validator. "Reach the owner" is the call on `TransactionOwnerCore`, which queues
synchronously. An adapter that carries calls as messages must also queue each message on its
lane when it arrives, before reading its body, so a late body never lets a later message
overtake an earlier one; the Durable Objects class does this per lane, as the old
`fetch` did. Calls still in transit are not ordered: two concurrent client requests may reach
the owner in either order, and ADR 0007 fails a conflicting one.

The engine's own post-response work also uses `BackgroundTasks`: `app.fetch(request, context,
background?)` takes it per request because Workers scopes `waitUntil` to one request. Without
it, cost observation runs detached; a malformed one is 500 before any work. A `run` that throws
is logged and never turns a completed operation into an error.

### Typed handle, internal HTTP kept as the adapter's wire

The handle is typed rather than a `fetch`-shaped interface: routes, tests, and a future
non-HTTP entry point (#34) call operations, not URLs, and the in-memory adapter needs no HTTP.
The Durable Objects adapter still sends each call as the same internal message as before
(`POST https://owner/<command>`, JSON body, `x-policysql-request-id`, and `authorization` for
callbacks). That wire form is an adapter detail. It lets a Worker and an object of adjacent
versions talk during a rollout, and it needs no `cloudflare:workers` RPC base class, so the
production adapter runs in the Node test harness. Moving to Durable Object RPC later changes
only the adapter.

### The Durable Objects adapter (`src/adapters/durable-objects.ts`)

The only library module that names `DurableObjectNamespace`, `DurableObjectState`,
`idFromName`, `storage`, `setAlarm`, or `waitUntil`. It exports
`durableObjectTransactionOwners(namespace)` (routing; it rejects a non-namespace at
construction), `durableObjectTransactionOwnerClass(deployment)` (the object class: storage,
alarm, and `waitUntil` as facilities, `fetch` decodes messages, `alarm` calls `onTimer`),
`durableObjectFacilities(state)`, and `executionContextTasks(executionContext)`. It makes no
decision; the platform gives the one-instance-per-id guarantee.

The wrapper assembles it. `createPolicySqlWorker`'s `deployment(env)` returns
`{ database, config, transactionOwners: durableObjectTransactionOwners(env.TRANSACTION_OWNER) }`,
and the wrapper exports `durableObjectTransactionOwnerClass(worker.ownerDependencies)` under
the class name its `wrangler.jsonc` binds. The binding name is the wrapper's choice, like every
env name since ADR 0021. The class name `TransactionOwner` and its storage layout are
unchanged, so no Durable Object migration is needed and existing objects keep their state.

### The in-memory adapter stays a test helper

`test/helpers/memory-owner.mjs` keeps one owner per name in one process, with simulated loss
and timer firing. In one process that is the full contract; on a platform with several
isolates each would hold its own map and two owners could serve one transaction. It is not
shipped, so no deployment can pick it by mistake.

## Consequences

- Breaking change (beta, no compatibility layer): `createApp` requires `transactionOwners`;
  `app.fetch(request, context, background?)` and `app.fetchCallback(request)` take no platform
  env or `ExecutionContext`; `TransactionOwnerCore(facilities, dependencies)` has typed
  methods and `onTimer()` instead of `fetch` and `alarm`; `PolicySqlDeployment` requires
  `transactionOwners`; `createPolicySqlWorker` returns `ownerDependencies` instead of a
  `TransactionOwner` class; `PlatformBindings` is removed. `createPolicySqlWorker().app` keeps
  its `(request, env, executionContext, context)` shape, and a missing namespace now fails every
  request with `deployment_config_rejected`, as any invalid deployment does.
- The library reads no property of `env`. The env guard has no exception, and a structural
  guard confines the Durable Object names, `waitUntil`, and `cloudflare:workers` to the adapter.
- `test/transaction-owner-port.test.mjs` runs one conformance suite (serialization, order of
  arrival with a late body, single owner per name, owner loss, timer expiry, timer expiry and
  owner loss while a commit waits on its validator, exact retry, callback routing, binding
  pinning) against both adapters, and `npm run test:memory-owner` runs the whole suite on the in-memory adapter.
- ADR 0007 and ADR 0014 guarantees are unchanged; they are now stated as port obligations.
