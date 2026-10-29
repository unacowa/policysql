# In-process example (no HTTP)

PolicySQL's engine exposes operations, not HTTP ([ADR 0023](../../docs/adr/0023-operations-api-and-http-adapter.md)).
`policysql.ts` assembles an engine in one Node process and calls the operations directly:
no route, no header, no HTTP status. A result is `{ ok: true, value, requestId }` or
`{ ok: false, error: { code, message, path }, requestId }`.

```ts
import { createInProcessPolicySql, loadRuntime } from "./policysql.ts";

const policysql = createInProcessPolicySql(loadRuntime());
const context = {
  database: policysql.binding, // the wrapper selects the database
  session: {                   // the wrapper authenticated the caller
    principal: "app:user_1", subject: "user_1", roles: ["member"], defaultRole: "member",
    access: ["execute", "explain", "catalog"], session: { tenant_id: "tenant_a" },
  },
};
const result = await policysql.engine.execute({
  bodyText: JSON.stringify({ statements: [{ sql: "SELECT id, name FROM projects", params: {} }] }),
}, context);
if (!result.ok) console.error(result.error.code);
```

What the example supplies, and why it is only an example:

- **Database:** Node's built-in SQLite (`node:sqlite`) in memory, as a `DatabaseProvider`.
- **Transaction owners:** one `TransactionOwnerCore` per name in a `Map`. With one process
  that is the whole `TransactionOwner` contract; with several processes or isolates it is
  not, which is why the library does not ship it ([ADR 0022](../../docs/adr/0022-transaction-owner-port.md)).
- **Policy:** the `database-routing` example's catalog and policy without commit checks.

The body is still checked by the engine exactly as for HTTP: well-formed Unicode, duplicate
JSON keys, and the 1 MiB limit. On Cloudflare, a service binding can reach the same
operations through `createPolicySqlWorker(...).engine(env)`.

`deploy/cloudflare/test/in-process-example.test.mjs` runs this example
(`cd deploy/cloudflare && npm test`).
