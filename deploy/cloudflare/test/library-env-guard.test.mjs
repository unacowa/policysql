import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanEnvReads } from "./helpers/env-read-scan.mjs";

// Regression guard (#32, ADR 0021): library code takes deployment settings only from the
// explicit `PolicySqlConfig`. It reads nothing from the platform env object, except
// `TRANSACTION_OWNER` in src/app.ts until the TransactionOwner port replaces it (#31).
// The identity adapter (src/adapters/) is wrapper-side and outside the engine.
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const library = "deploy/cloudflare/src";
const excluded = ["deploy/cloudflare/src/adapters/"];
const EXCEPTION = { kind: "env-read", file: "deploy/cloudflare/src/app.ts", text: "env.TRANSACTION_OWNER" };

const sources = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return sources(path);
  return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
});

const files = sources(join(repository, library))
  .map((path) => relative(repository, path))
  .filter((file) => !excluded.some((prefix) => file.startsWith(prefix)));

test("library code reads no platform env property except the documented TRANSACTION_OWNER", () => {
  for (const required of ["app.ts", "routes/system.ts", "routes/execute.ts", "commit-checks.ts", "cost.ts",
    "transaction-owner.ts", "worker.ts", "package.ts", "engine-config.ts"]) {
    assert.ok(files.includes(`${library}/${required}`), `the scan covers ${required}`);
  }
  const findings = files.flatMap((file) => scanEnvReads(file, readFileSync(join(repository, file), "utf8")));
  const unexpected = findings.filter((finding) =>
    !(finding.kind === EXCEPTION.kind && finding.file === EXCEPTION.file && finding.text === EXCEPTION.text));
  assert.deepEqual(unexpected, [], "take deployment settings from PolicySqlConfig (src/engine-config.ts)");
  assert.equal(findings.length - unexpected.length, 1, "TRANSACTION_OWNER is read in exactly one place");
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

test("the scan catches every spelling of an env read", () => {
  const caught = [
    ["env-read", "const a = env.POLICYSQL_PUBLIC_BASE_URL;"],
    ["env-read", 'const a = env["VALIDATOR_SECRET"];'],
    ["env-read", "const a = env[check.hmacSecretEnv];"],
    ["env-read", "const a = (env).X;"],
    ["env-read", "const { POLICYSQL_ENVIRONMENT } = env;"],
    ["env-read", "const a = deployment.POLICYSQL_ENVIRONMENT;"],
    ["env-read", "const a = context.env.deployment.POLICYSQL_ENVIRONMENT;"],
    ["env-read", "class A { f() { return this.env.X; } }"],
    ["env-read", "class A { constructor(env) { this.env = env; } }"],
    ["env-read", "const a = process.env.SECRET;"],
    ["hono-binding", "const a = context.env.POLICYSQL_ENVIRONMENT;"],
    ["hono-binding", 'const a = c.env["VALIDATOR_URL"];'],
    ["env-read", "const { VALIDATOR_URL } = context.env;"],
    ["platform-import", 'import { env } from "cloudflare:workers";'],
  ];
  for (const [kind, text] of caught) {
    const findings = scanEnvReads("sample.ts", text);
    assert.ok(findings.some((finding) => finding.kind === kind), `${kind}: ${text}`);
  }
  const allowed = [
    "// env.POLICYSQL_PUBLIC_BASE_URL is not read here",
    'const name = "env.POLICYSQL_ENVIRONMENT";',
    "const a = context.env.requestId ?? context.env.session;",
    "const a = context.env.callback === true && context.env.databaseBinding;",
    "const a = context.env.transactionOwner;",
    "const a = config.environment; const b = dependencies.config.publicBaseUrl;",
    "const built = deployment(env);",
    "app.fetch(request, env, context);",
    "const environment = 1; const x = { env: 1 }.env;",
  ];
  for (const text of allowed) assert.deepEqual(scanEnvReads("sample.ts", text), [], text);
});
