import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConfigError, validateConfig } from "../src/engine-config.ts";
import { createApp } from "../src/app.ts";
import { TransactionOwnerCore } from "../src/transaction-owner.ts";
import { createWorkerEntrypoints } from "../src/worker.ts";
import { durableObjectTransactionOwnerClass } from "../src/adapters/durable-objects.ts";
import { configFromEnv as referenceConfig } from "../wrapper/config.ts";
import { configFromEnv as exampleConfig } from "../../../examples/database-routing/config.ts";
import { testBinding, testProvider } from "./helpers/database.mjs";
import { limitsJson } from "./helpers/limits.mjs";

// ADR 0021: deployment settings are an explicit, typed `PolicySqlConfig`, validated once
// before any database, Durable Object, or validator call. Errors and logs name the
// setting, never its value.
const SECRET = "sentinel-secret-value-0123456789";
const SECRET_URL = "https://sentinel-validator.test/private-path";
const valid = () => ({
  environment: "test",
  publicBaseUrl: "https://worker.test",
  costCatalog: { maxEstimatedRowsRead: 10, maxEstimatedRowsWritten: 10, resources: { 1: { upperRows: 5 } } },
  commitChecks: { consistency: { url: SECRET_URL, hmacSecret: SECRET } },
});

const runtime = {
  abi_version: 5, profile: "sqlite-turso-v1", snapshot: "test-snapshot", commit_checks_enabled: true,
  limits_json: limitsJson({ maxBytesPerValue: 1_024 }),
};

const leaks = (text) => text.includes(SECRET) || text.includes("sentinel-validator");

test("a valid configuration is frozen, copied, and never serializes a secret", () => {
  const input = valid();
  const config = validateConfig(input);
  assert.equal(config.environment, "test");
  assert.equal(config.publicBaseUrl, "https://worker.test");
  assert.deepEqual(config.commitCheck("consistency"), { url: SECRET_URL, hmacSecret: SECRET });
  assert.equal(config.commitCheck("other"), undefined);
  assert.equal(config.commitCheck("__proto__"), undefined);
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.costCatalog) && Object.isFrozen(config.costCatalog.resources[1]));
  input.costCatalog.resources[1].upperRows = 999;
  input.commitChecks.consistency.url = "https://other.test";
  assert.equal(config.costCatalog.resources[1].upperRows, 5);
  assert.equal(config.commitCheck("consistency").url, SECRET_URL);
  assert.equal(leaks(JSON.stringify(config)), false);
  assert.equal(validateConfig(config), config, "an already validated config is accepted unchanged");
  assert.deepEqual(validateConfig({ environment: "x" }).costCatalog, undefined);
});

test("every invalid setting is a ConfigError that names the setting and never the value", () => {
  const cases = [
    [undefined, "config"],
    [null, "config"],
    ["environment=test", "config"],
    [[], "config"],
    [{ ...valid(), environment: undefined }, "config.environment"],
    [{ ...valid(), environment: "" }, "config.environment"],
    [{ ...valid(), environment: "has space" }, "config.environment"],
    [{ ...valid(), environment: "x".repeat(65) }, "config.environment"],
    [{ ...valid(), POLICYSQL_PUBLIC_BASE_URL: SECRET_URL }, "config.POLICYSQL_PUBLIC_BASE_URL"],
    [{ ...valid(), idempotencySecret: SECRET }, "config.idempotencySecret"],
    [{ ...valid(), publicBaseUrl: "http://worker.test" }, "config.publicBaseUrl"],
    [{ ...valid(), publicBaseUrl: `https://user:${SECRET}@worker.test` }, "config.publicBaseUrl"],
    [{ ...valid(), publicBaseUrl: "https://worker.test/base" }, "config.publicBaseUrl"],
    [{ ...valid(), publicBaseUrl: `https://worker.test/?t=${SECRET}` }, "config.publicBaseUrl"],
    [{ ...valid(), publicBaseUrl: SECRET }, "config.publicBaseUrl"],
    [{ ...valid(), publicBaseUrl: undefined }, "config.publicBaseUrl"],
    [{ ...valid(), costCatalog: "{}" }, "config.costCatalog"],
    [{ ...valid(), costCatalog: { maxEstimatedRowsRead: 0, maxEstimatedRowsWritten: 1, resources: {} } }, "config.costCatalog.maxEstimatedRowsRead"],
    [{ ...valid(), costCatalog: { maxEstimatedRowsRead: 1, maxEstimatedRowsWritten: 1.5, resources: {} } }, "config.costCatalog.maxEstimatedRowsWritten"],
    [{ ...valid(), costCatalog: { maxEstimatedRowsRead: 1, maxEstimatedRowsWritten: 1, resources: [] } }, "config.costCatalog.resources"],
    [{ ...valid(), costCatalog: { maxEstimatedRowsRead: 1, maxEstimatedRowsWritten: 1, resources: { projects: { upperRows: 1 } } } }, "config.costCatalog.resources"],
    [{ ...valid(), costCatalog: { maxEstimatedRowsRead: 1, maxEstimatedRowsWritten: 1, resources: { 1: { upperRows: -1 } } } }, "config.costCatalog.resources.1.upperRows"],
    [{ ...valid(), costCatalog: { maxEstimatedRowsRead: 1, maxEstimatedRowsWritten: 1, resources: { 1: { upperRows: 1, load: () => 1 } } } }, "config.costCatalog"],
    [{ ...valid(), commitChecks: [] }, "config.commitChecks"],
    [{ ...valid(), commitChecks: { "Bad-Id": { url: SECRET_URL, hmacSecret: SECRET } } }, "config.commitChecks"],
    [{ ...valid(), commitChecks: { consistency: { urlEnv: "VALIDATOR_URL", hmacSecretEnv: "VALIDATOR_SECRET" } } }, "config.commitChecks.consistency"],
    [{ ...valid(), commitChecks: { consistency: { url: SECRET_URL, hmacSecret: SECRET, extra: 1 } } }, "config.commitChecks.consistency"],
    [{ ...valid(), commitChecks: { consistency: { url: "http://sentinel-validator.test", hmacSecret: SECRET } } }, "config.commitChecks.consistency.url"],
    [{ ...valid(), commitChecks: { consistency: { url: `https://u:${SECRET}@sentinel-validator.test`, hmacSecret: SECRET } } }, "config.commitChecks.consistency.url"],
    [{ ...valid(), commitChecks: { consistency: { url: SECRET_URL, hmacSecret: "short-sentinel" } } }, "config.commitChecks.consistency.hmacSecret"],
    [{ ...valid(), commitChecks: { consistency: { url: SECRET_URL, hmacSecret: 1234567890123456 } } }, "config.commitChecks.consistency.hmacSecret"],
  ];
  for (const [input, setting] of cases) {
    assert.throws(() => validateConfig(input), (error) => {
      assert.ok(error instanceof ConfigError && error instanceof TypeError, setting);
      assert.equal(error.setting, setting);
      assert.equal(leaks(`${error.message} ${error.setting} ${error.stack}`), false, setting);
      assert.equal(error.message.includes("short-sentinel"), false, setting);
      return true;
    }, setting);
  }
});

test("createApp and the transaction owner reject bad configuration before any runtime, database, or storage work", () => {
  let calls = 0;
  const getRuntime = () => { calls++; return runtime; };
  const database = { streamedReadCap: true, check() { calls++; return true; }, connect() { calls++; throw new Error("no"); } };
  // Any read of the owner facilities counts: the store, timer, and background are untouched.
  const facilities = new Proxy({}, { get() { calls++; return () => undefined; } });
  const transactionOwners = { route() { calls++; } };
  for (const config of [undefined, { environment: "" }, { ...valid(), commitChecks: { consistency: { url: SECRET_URL, hmacSecret: "x" } } }]) {
    assert.throws(() => createApp({ getRuntime, database, config, transactionOwners }), TypeError);
    assert.throws(() => new TransactionOwnerCore(facilities, { getRuntime, database, config }), TypeError);
  }
  assert.equal(calls, 0);
  assert.throws(() => new TransactionOwnerCore(facilities, { database, config: valid() }), TypeError);
});

const workerHarness = (deployment) => {
  const counts = { runtime: 0, check: 0, connect: 0, owner: 0, deployment: 0 };
  const database = { streamedReadCap: true, check() { counts.check++; return true; }, connect() { counts.connect++; throw new Error("no"); } };
  const transactionOwners = { route() { counts.owner++; throw new Error("no owner"); } };
  const entry = createWorkerEntrypoints({
    getRuntime: () => { counts.runtime++; return runtime; },
    deployment: (env) => { counts.deployment++; return { transactionOwners, ...deployment(env, database) }; },
  });
  const env = { VALIDATOR_SECRET: SECRET };
  // The wrapper assembles the Durable Object class from the same deployment (ADR 0022).
  const OwnerObject = durableObjectTransactionOwnerClass(entry.ownerDependencies);
  return { entry, env, counts, OwnerObject };
};

const session = { principal: "p", subject: "s", roles: ["member"], defaultRole: "member", access: ["execute"], session: {} };

test("/healthz reports config.environment; env settings of the old contract are ignored", async () => {
  const { entry } = workerHarness((env, database) => ({ database, config: { environment: "from_config" } }));
  const env = { POLICYSQL_ENVIRONMENT: "from_env" };
  const body = await (await entry.app.fetch(new Request("https://worker.test/healthz"), env, undefined, { database: testBinding(runtime.snapshot) })).json();
  assert.equal(body.environment, "from_config");
});

test("a rejected deployment is 500 before runtime, database, owner, or validator work, and logs only the setting", async (t) => {
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(line));
  const wrapperError = new TypeError(`Missing deployment setting with ${SECRET}`);
  for (const [deployment, setting] of [
    [(env, database) => ({ database, config: { ...valid(), commitChecks: { consistency: { url: SECRET_URL, hmacSecret: "short" } } } }), "config.commitChecks.consistency.hmacSecret"],
    [(env, database) => ({ database, config: { environment: "test", commitChecks: { consistency: { url: SECRET_URL, hmacSecret: env.VALIDATOR_SECRET } } } }), "config.publicBaseUrl"],
    [(env, database) => ({ database }), "config"],
    [() => { throw wrapperError; }, null],
  ]) {
    logs.length = 0;
    const { entry, env, counts, OwnerObject } = workerHarness(deployment);
    const responses = [
      await entry.app.fetch(new Request("https://worker.test/v1/transactions:execute", { method: "POST", body: "{}" }), env, undefined,
        { database: testBinding(runtime.snapshot), session }),
      await entry.app.fetchCallback(new Request(`https://worker.test/v1/commit-checks/cval_${"0".repeat(32)}/query`, { method: "POST", body: "{}" }), env, undefined),
    ];
    for (const response of responses) {
      assert.equal(response.status, 500);
      const text = await response.text();
      assert.equal(JSON.parse(text).error.code, "POLICYSQL_INTERNAL");
      assert.equal(leaks(text), false);
    }
    // The Durable Object fails at construction, before it can serve a request. A wrapper
    // error passes through unchanged; a library ConfigError carries no value.
    assert.throws(() => new OwnerObject({ storage: {} }, env),
      (error) => error === wrapperError || (error instanceof ConfigError && !leaks(error.message)));
    assert.deepEqual({ ...counts, deployment: 0 }, { runtime: 0, check: 0, connect: 0, owner: 0, deployment: 0 });
    const events = logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === "deployment_config_rejected");
    assert.equal(events.length, 2);
    for (const event of events) assert.deepEqual(event, { event: "deployment_config_rejected", setting, errorClass: setting ? "ConfigError" : "TypeError" });
    assert.equal(leaks(logs.join("\n")), false);
  }
});

test("the Worker builds its deployment at most once per env object, and the Durable Object builds the same one", async () => {
  const seen = [];
  const { entry, env, counts, OwnerObject } = workerHarness((platform, database) => {
    const config = { ...valid(), environment: "built" };
    seen.push(config);
    return { database, config };
  });
  for (let index = 0; index < 3; index++) {
    const response = await entry.app.fetch(new Request("https://worker.test/healthz"), env, undefined, { database: testBinding(runtime.snapshot) });
    assert.equal((await response.json()).environment, "built");
  }
  assert.equal(counts.deployment, 1);
  // Memoization is per env object only: a different object is built and validated again.
  const other = { ...env };
  assert.equal((await entry.app.fetch(new Request("https://worker.test/healthz"), other, undefined, { database: testBinding(runtime.snapshot) })).status, 200);
  assert.equal(counts.deployment, 2);
  await entry.app.fetch(new Request("https://worker.test/healthz"), env, undefined, { database: testBinding(runtime.snapshot) });
  assert.equal(counts.deployment, 2, "the first env object keeps its build");
  const owner = new OwnerObject({ storage: {} }, env).core;
  assert.equal(counts.deployment, 3);
  assert.equal(owner.config.environment, "built");
  assert.deepEqual(owner.config.commitCheck("consistency"), seen[0].commitChecks.consistency);
});

const readJsonc = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")
  .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match, string) => string ?? "")
  .replace(/,(\s*[}\]])/g, "$1"));

test("the wrappers' env conventions build a valid configuration from their wrangler vars", () => {
  const referenceWrangler = readJsonc("../wrangler.jsonc");
  // The dev policy's `smoke_check` (#42): its URL is a var, its HMAC secret a required secret.
  assert.ok(referenceWrangler.secrets.required.includes("SMOKE_VALIDATOR_HMAC_SECRET"));
  const reference = { ...referenceWrangler.vars, SMOKE_VALIDATOR_HMAC_SECRET: SECRET };
  const fromReference = validateConfig(referenceConfig(reference));
  assert.equal(fromReference.environment, reference.POLICYSQL_ENVIRONMENT);
  assert.equal(fromReference.publicBaseUrl, reference.POLICYSQL_PUBLIC_BASE_URL);
  assert.deepEqual(fromReference.costCatalog, JSON.parse(reference.POLICYSQL_COST_CATALOG_JSON));
  assert.deepEqual(fromReference.commitCheck("smoke_check"), { url: reference.SMOKE_VALIDATOR_URL, hmacSecret: SECRET });
  // Without the secret the whole reference configuration is rejected, never a check without one.
  const { SMOKE_VALIDATOR_HMAC_SECRET: _omitted, ...unsigned } = reference;
  assert.throws(() => validateConfig(referenceConfig(unsigned)), (error) => error instanceof ConfigError && !leaks(error.message));
  // A check id the wrapper maps reads that check's own env names.
  const mapped = validateConfig(referenceConfig({ ...reference, A_URL: SECRET_URL, A_SECRET: SECRET }, { alpha: { url: "A_URL", hmacSecret: "A_SECRET" } }));
  assert.deepEqual(mapped.commitCheck("alpha"), { url: SECRET_URL, hmacSecret: SECRET });
  assert.throws(() => validateConfig(referenceConfig(reference, { alpha: { url: "A_URL", hmacSecret: "A_SECRET" } })), ConfigError);
  assert.throws(() => referenceConfig({ ...reference, POLICYSQL_COST_CATALOG_JSON: "{" }), (error) => error instanceof TypeError && !error.message.includes("{"));

  const example = readJsonc("../../../examples/database-routing/wrangler.jsonc").vars;
  const fromExample = validateConfig(exampleConfig({ ...example, VALIDATOR_URL: SECRET_URL, VALIDATOR_SECRET: SECRET }));
  assert.deepEqual(fromExample.commitCheck("consistency"), { url: SECRET_URL, hmacSecret: SECRET });
  // The example policy defines a commit check, so its endpoint secrets are required.
  for (const missing of ["VALIDATOR_URL", "VALIDATOR_SECRET"]) {
    const env = { ...example, VALIDATOR_URL: SECRET_URL, VALIDATOR_SECRET: SECRET };
    delete env[missing];
    assert.throws(() => validateConfig(exampleConfig(env)), (error) => error instanceof ConfigError && !leaks(error.message));
  }
});
