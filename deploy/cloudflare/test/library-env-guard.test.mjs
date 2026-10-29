import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanEnvReads } from "./helpers/env-read-scan.mjs";

// Regression guard (#32, ADR 0021, #31, ADR 0022): library code takes deployment settings
// only from the explicit `PolicySqlConfig` and transaction owners only from the
// TransactionOwner port. It reads nothing from the platform env object, with no exception:
// the wrapper reads its Durable Object binding and hands the port to the library. The
// Durable Objects adapter is scanned too; it only passes an object's env to the wrapper's
// deployment function. The JWT identity adapter is wrapper-side and outside the engine.
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const library = "deploy/cloudflare/src";
const excluded = ["deploy/cloudflare/src/adapters/jwt.ts"];

const sources = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return sources(path);
  return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
});

const files = sources(join(repository, library))
  .map((path) => relative(repository, path))
  .filter((file) => !excluded.some((prefix) => file.startsWith(prefix)));

test("library code reads no platform env property, TRANSACTION_OWNER included", () => {
  for (const required of ["app.ts", "routes/system.ts", "routes/execute.ts", "commit-checks.ts", "cost.ts",
    "transaction-owner.ts", "transaction-owner-port.ts", "worker.ts", "package.ts", "engine-config.ts",
    "adapters/durable-objects.ts"]) {
    assert.ok(files.includes(`${library}/${required}`), `the scan covers ${required}`);
  }
  const findings = files.flatMap((file) => scanEnvReads(file, readFileSync(join(repository, file), "utf8")));
  assert.deepEqual(findings, [],
    "take deployment settings from PolicySqlConfig (src/engine-config.ts) and owners from the TransactionOwner port");
  for (const file of files) {
    assert.equal(readFileSync(join(repository, file), "utf8").includes("TRANSACTION_OWNER"), false,
      `${file} names the wrapper's Durable Object binding`);
  }
});

test("library source names none of the wrapper's env settings", () => {
  for (const file of files) {
    const text = readFileSync(join(repository, file), "utf8");
    for (const name of ["POLICYSQL_ENVIRONMENT", "POLICYSQL_PUBLIC_BASE_URL", "POLICYSQL_COST_CATALOG_JSON",
      "POLICYSQL_IDEMPOTENCY_SECRET", "POLICYSQL_JWT", "POLICYSQL_JWKS", "urlEnv", "hmacSecretEnv"]) {
      assert.equal(text.includes(name), false, `${file} names ${name}`);
    }
  }
});

// The guard is an allowlist: any reference to `env` / `deployment` that is not a parameter,
// a known sink argument, or a presence check is a finding,
// however the read is spelled. These samples pin the evasions found in review (PR #43).
test("the scan rejects every env use outside the allowlist", () => {
  const caught = [
    "const a = env.POLICYSQL_PUBLIC_BASE_URL;",
    'const a = env["VALIDATOR_SECRET"];',
    "const a = env[check.hmacSecretEnv];",
    "const a = (env).X;",
    "const a = (env as any).POLICYSQL_ENVIRONMENT;",
    "const a = (<any>env).POLICYSQL_ENVIRONMENT;",
    "const a = env!.X;",
    "const { POLICYSQL_ENVIRONMENT } = env;",
    "const e = env; e.POLICYSQL_PUBLIC_BASE_URL;",
    "const bindings = env; bindings['VALIDATOR_SECRET'];",
    "let e; e = env;",
    "const copy = { ...env };",
    "const holder = { env };",
    "const holder = { bindings: env };",
    "const list = [env];",
    "Reflect.get(env, 'VALIDATOR_SECRET');",
    "Object.entries(env);",
    "Object.keys(env);",
    "JSON.stringify(env);",
    "structuredClone(env);",
    "const read = (bindings) => bindings.POLICYSQL_ENVIRONMENT; read(env);",
    "resolve(env);",
    "new Resolver(env);",
    "owner.fetch(env);",
    "app.fetch(request, context, env);",
    "for (const key in env) {}",
    "const env = globalThis.bindings;",
    "const a = deployment.POLICYSQL_ENVIRONMENT;",
    "const d = deployment; d(env);",
    "const a = context.env.deployment.POLICYSQL_ENVIRONMENT;",
    "class A { f() { return this.env.X; } }",
    "class A { constructor(env) { this.env = env; } }",
    "const a = process.env.SECRET;",
    "const a = context.env.POLICYSQL_ENVIRONMENT;",
    'const a = c.env["VALIDATOR_URL"];',
    "const { VALIDATOR_URL } = context.env;",
    "const { env: platform } = context;",
    "const bindings = context.env;",
    'import { env } from "cloudflare:workers";',
    'import { env as platform } from "cloudflare:workers";',
  ];
  for (const text of caught) {
    assert.notDeepEqual(scanEnvReads("sample.ts", text), [], text);
  }
  // The former TRANSACTION_OWNER exception (#32) is an ordinary finding now (#31), however
  // it is reached.
  for (const text of [
    "const owner = (env) => env.TRANSACTION_OWNER;",
    "const owner = (env) => env['TRANSACTION_OWNER'];",
    "const { TRANSACTION_OWNER } = env;",
    "const a = context.env.transactionOwner;",
  ]) assert.notDeepEqual(scanEnvReads("sample.ts", text), [], text);
  const allowed = [
    "// env.POLICYSQL_PUBLIC_BASE_URL is not read here",
    'const name = "env.POLICYSQL_ENVIRONMENT";',
    "const a = context.env.requestId ?? context.env.session;",
    "const a = context.env.callback === true && context.env.databaseBinding;",
    "const a = context.env.background;",
    "const C = (deployment) => class { constructor(state, env) { this.core = make(state, deployment(env)); } };",
    "const a = config.environment; const b = dependencies.config.publicBaseUrl;",
    "const f = (env, { deployment }) => deployment(env);",
    "const f = (request, env, context) => app.fetch(request, env, context);",
    "const f = (request, env) => built.fetchCallback(request, env, undefined);",
    "const f = (env) => (env === null || typeof env !== 'object' ? undefined : build(env));",
    "const f = (env) => apps.get(env) ?? apps.set(env, appFor(env));",
    "type T = { deployment: (env: Env) => void }; const x = configuration.deployment;",
    "const environment = 1; const x = { env: 1 };",
  ];
  for (const text of allowed) assert.deepEqual(scanEnvReads("sample.ts", text), [], text);
});
