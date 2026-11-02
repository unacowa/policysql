import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expectBoundary, lintTree } from "./helpers/boundary-lint.mjs";

// The layer boundaries, as lint rules (eslint.config.js, issue #59; the rules were hand-written
// syntax-tree scanners before, and every review found another spelling they missed):
//
// - ADR 0019: HTTP — its types, its header names, its statuses, its routes — lives in
//   `src/http/`. The engine and its outbound adapters name none of it.
// - ADR 0022: Durable Objects, their storage and alarm, `waitUntil`, and `cloudflare:workers`
//   appear only in `src/adapters/durable-objects.ts`.
// - ADR 0021: the library reads no deployment setting from an environment object. An `env` or
//   `deployment` value may be passed to the documented sinks, never read, aliased, or stored.
// - #36: only `src/redirects.ts` sets a redirect mode or calls the host fetch.

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const ENGINE = "src/engine.ts";
const DO_ADAPTER = "src/adapters/durable-objects.ts";
const HONO_ADAPTER = "src/http/adapter.ts";
const WRAPPER = "wrapper/index.ts";

test("the tree has no boundary violation", async () => {
  assert.deepEqual(await lintTree(), []);
});

test("the scans still cover the modules they are about", async () => {
  const library = "deploy/cloudflare/src";
  const files = readdirSync(join(repository, library), { recursive: true })
    .map((name) => String(name).split("\\").join("/"))
    .filter((name) => name.endsWith(".ts"));
  for (const required of ["engine.ts", "app.ts", "http/adapter.ts", "http/responses.ts", "request-step.ts",
    "step-effects.ts", "transaction-owner.ts", "transaction-owner-port.ts", "worker.ts", "package.ts",
    "engine-config.ts", "adapters/durable-objects.ts", "turso-http.ts", "redirects.ts", "types.ts"]) {
    assert.ok(files.includes(required), `the scan covers ${required}`);
  }
});

test("HTTP types, headers, statuses and routes are findings in the engine, not in src/http/", async () => {
  await expectBoundary(assert, {
    caught: [
      [ENGINE, "const a: Request = x;"],
      [ENGINE, "const r: Response = y;"],
      [ENGINE, "const h = new Headers();"],
      [ENGINE, "const f = (r: Request) => r;"],
      [ENGINE, "type T = Request;"],
      [ENGINE, 'import { Hono } from "hono";'],
      [ENGINE, 'import { createMiddleware } from "hono/factory";'],
      [ENGINE, "const r = Response.json({});"],
      [ENGINE, "const reply = { status: 201, body: {} };"],
      [ENGINE, 'const name = "Content-Type";'],
      [ENGINE, 'const url = "/v1/catalog";'],
      [ENGINE, 'const path = "/healthz";'],
      [ENGINE, "await fetch(url);"],
      [ENGINE, "await globalThis.fetch(url);"],
      [ENGINE, 'await self["fetch"](url);'],
      [ENGINE, "const name = 'content-type';"],
      [ENGINE, "const p = '/v1/transactions:execute';"],
    ],
    allowed: [
      [HONO_ADAPTER, "const f = (r: Request): Response => new Response(null);"],
      [HONO_ADAPTER, 'import { Hono } from "hono";'],
      [HONO_ADAPTER, "const reply = { status: 409 };"],
      [HONO_ADAPTER, 'const name = "Content-Type";'],
      [HONO_ADAPTER, 'const url = "/v1/catalog";'],
      [DO_ADAPTER, "const f = (r: Request): Promise<Response> => handler(r);"],
      [HONO_ADAPTER, "const name = 'content-type';"],
      ["src/worker.ts", "export const f = (r: Request): Promise<Response> => handler(r);"],
      ["src/package.ts", "export const f = (c: ExecutionContext) => c;"],
      [ENGINE, "const state = { status: \"active\" };"],
      [ENGINE, "if (rowsReturned > 100) {}"],
      [ENGINE, "const timeoutMs = 1_000; const depth = 64;"],
      [ENGINE, "const event = \"request_rejected\";"],
      [ENGINE, "const id = setTimeout(run, 500);"],
    ],
  });
});

test("Durable Object names are findings everywhere but their adapter", async () => {
  await expectBoundary(assert, {
    caught: [
      [ENGINE, "const f = (namespace: DurableObjectNamespace) => namespace;"],
      [ENGINE, "const id = namespace.idFromName(name);"],
      [ENGINE, "const stub = namespace.getByName(name);"],
      [ENGINE, "state.storage.get('transaction');"],
      [ENGINE, "const { storage } = state;"],
      [ENGINE, "await this.state.storage.setAlarm(1);"],
      [ENGINE, "context.executionCtx.waitUntil(task);"],
      [ENGINE, "type S = DurableObjectState;"],
    ],
    allowed: [
      [DO_ADAPTER, "const f = (namespace: DurableObjectNamespace) => namespace.idFromName(name);"],
      [DO_ADAPTER, "state.storage.setAlarm(1);"],
      [DO_ADAPTER, "const id = (state as unknown as { id?: { name?: unknown } }).id;"],
      [ENGINE, "await this.facilities.timer.schedule(atMs);"],
      [ENGINE, "runInBackground(background, task, requestId);"],
      [ENGINE, "const message = \"Durable Object\";"],
    ],
  });
});

test("library code passes the environment object on; it never reads, aliases, or stores it", async () => {
  const caughtIn = (file) => [
    [file, "const a = env.POLICYSQL_PUBLIC_BASE_URL;"],
    [file, 'const a = env["VALIDATOR_SECRET"];'],
    [file, "const a = (env).X;"],
    [file, "const a = (env as any).POLICYSQL_ENVIRONMENT;"],
    [file, "const a = env!.X;"],
    [file, "const { POLICYSQL_ENVIRONMENT } = env;"],
    [file, "const e = env; e.POLICYSQL_PUBLIC_BASE_URL;"],
    [file, "let e; e = env;"],
    [file, "const copy = { ...env };"],
    [file, "const holder = { env };"],
    [file, "const list = [env];"],
    [file, "Reflect.get(env, 'VALIDATOR_SECRET');"],
    [file, "Object.entries(env);"],
    [file, "JSON.stringify(env);"],
    [file, "const read = (bindings) => bindings.X; read(env);"],
    [file, "resolve(env);"],
    [file, "new Resolver(env);"],
    [file, "owner.fetch(env);"],
    [file, "const env = globalThis.bindings;"],
    [file, "const a = deployment.POLICYSQL_ENVIRONMENT;"],
    [file, "const d = deployment; d(env);"],
    [file, "class A { f() { return this.env.X; } }"],
    [file, "const a = process.env.SECRET;"],
    [file, "const a = context.env.POLICYSQL_ENVIRONMENT;"],
    [file, 'const a = c.env["VALIDATOR_URL"];'],
    [file, "const { VALIDATOR_URL } = context.env;"],
    [file, "const bindings = context.env;"],
    [file, "const owner = (env) => env.TRANSACTION_OWNER;"],
    [file, "const { TRANSACTION_OWNER } = env;"],
  ];
  await expectBoundary(assert, {
    caught: [...caughtIn(ENGINE), ...caughtIn("src/adapters/commit-check-hook.ts"), ...caughtIn(HONO_ADAPTER).slice(0, 5)],
    allowed: [
      [ENGINE, "const f = (env, { deployment }) => deployment(env);"],
      [ENGINE, "const C = (deployment) => class { constructor(state, env) { this.core = make(state, deployment(env)); } };"],
      [ENGINE, "const f = (env) => (env === null || typeof env !== 'object' ? undefined : build(env));"],
      [ENGINE, "const f = (env) => apps.get(env) ?? apps.set(env, appFor(env));"],
      [ENGINE, "const environment = 1; const x = { env: 1 };"],
      [HONO_ADAPTER, "const a = c.env.context.requestId ?? c.env.context.session;"],
      [HONO_ADAPTER, "const a = c.env.background;"],
    ],
  });
});

test("only redirects.ts names a redirect mode or calls the host fetch", async () => {
  await expectBoundary(assert, {
    caught: [
      [WRAPPER, 'const MODE = "error"; fetch2(url, { redirect: MODE });'],
      [WRAPPER, 'const redirect = "error"; fetch2(url, { redirect });'],
      [WRAPPER, 'fetch2(url, { "redirect": "error" });'],
      [WRAPPER, "fetch2(url, { ['redirect']: 'error' });"],
      [WRAPPER, 'init.redirect = "error";'],
      [WRAPPER, "await fetch(url, init);"],
      [WRAPPER, "const impl = fetch; await impl(url);"],
      [WRAPPER, "await globalThis.fetch(url);"],
      [WRAPPER, 'await self["fetch"](url);'],
      [ENGINE, "await fetch(url, init);"],
    ],
    allowed: [
      [WRAPPER, 'const message = "redirect: error and fetch(url)";'],
      [WRAPPER, 'const kind = "opaqueredirect";'],
      [WRAPPER, 'await env.SERVICE.fetch(request);'],
      [WRAPPER, "export default { fetch: handler };"],
      [WRAPPER, "class Owner { fetch(request) { return request; } }"],
      [WRAPPER, "let impl: typeof fetch | undefined;"],
    ],
  });
});

test("library source names none of the wrapper's env settings", () => {
  const library = "deploy/cloudflare/src";
  const excluded = [`${library}/adapters/jwt.ts`];
  const sources = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
  const files = sources(join(repository, library))
    .map((path) => relative(repository, path).split("\\").join("/"))
    .filter((file) => !excluded.some((prefix) => file.startsWith(prefix)));
  for (const file of files) {
    const text = readFileSync(join(repository, file), "utf8");
    for (const name of ["POLICYSQL_ENVIRONMENT", "POLICYSQL_PUBLIC_BASE_URL", "POLICYSQL_COST_CATALOG_JSON",
      "POLICYSQL_IDEMPOTENCY_SECRET", "POLICYSQL_JWT", "POLICYSQL_JWKS", "urlEnv", "hmacSecretEnv", "TRANSACTION_OWNER"]) {
      assert.equal(text.includes(name), false, `${file} names ${name}`);
    }
  }
});
