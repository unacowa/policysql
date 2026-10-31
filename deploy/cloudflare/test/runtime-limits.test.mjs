// Runtime limits are configured in exactly one place, `RuntimeLimits` (ADR 0024 pull request
// 3). The runtime validates them and reports the effective values; the engine enforces
// those values and Capabilities advertises exactly them. Every moved limit is set here to a
// non-default value and observed on both TransactionOwner adapters.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { initSync, PolicySqlRuntime } from "../pkg/policysql_wasm.js";
import { capabilities } from "../src/presenters.ts";
import { ENFORCED_LIMIT_KEYS, runtimeLimits, runtimeLimitsJson } from "../src/limits.ts";
import { RUNTIME_LIMITS } from "../wrapper/limits.ts";
import { createEngine } from "../src/engine.ts";
import { testConfig, testOwners, testProvider } from "./helpers/database.mjs";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";
import { PolicySqlClient, PolicySqlError, PolicySqlOutcomeUnknownError, createHttpTransport } from "../../../packages/client/index.js";
import { RUNTIME_DEFAULT_LIMITS, limitsJson } from "./helpers/limits.mjs";

initSync({ module: readFileSync(new URL("../pkg/policysql_wasm_bg.wasm", import.meta.url)) });
const example = (name) => readFileSync(new URL(`../../../examples/database-routing/${name}`, import.meta.url), "utf8");
const REQUIRED = { maxRows: 100, maxResultBytes: 64_000, timeoutMs: 1_000, maxStatements: 8 };
const construct = (limits) => PolicySqlRuntime.newWithPhysicalSchema(
  example("catalog.yaml"), example("policy.yaml"), "schema_limits_1", "policy_limits_1",
  runtimeLimitsJson(limits), example("physical-schema.json"),
);

const read = { sql: "SELECT id, name FROM projects ORDER BY id", params: {} };
const insert = (id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name: id } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Where each advertised number comes from: a key of the runtime's `limits_json` (the per-value
// limit included since ADR 0027). A number Capabilities advertises without an entry here, or
// with a value other than its source's, fails the test below.
const ADVERTISED_SOURCES = {
  "limits.maxRows": "maxRows",
  "limits.maxResultBytes": "maxResultBytes",
  "limits.maxResponseBytes": "maxResponseBytes",
  "limits.timeoutMs": "timeoutMs",
  "limits.maxStatements": "maxStatements",
  "limits.maxRequestBytes": "maxRequestBytes",
  "limits.maxJsonValues": "maxJsonValues",
  "limits.maxSqlBytes": "maxSqlBytes",
  "limits.maxBytesPerValue": "maxBytesPerValue",
  "limits.maxParameters": "maxParameters",
  "limits.maxExpressionDepth": "maxExpressionDepth",
  "limits.maxProjections": "maxProjections",
  "limits.maxJoins": "maxJoins",
  "transactions.maxStatements": "maxTransactionStatements",
  "transactions.maxResultBytes": "maxTransactionResultBytes",
  "transactions.maxCommitChecks": "maxCommitChecks",
  "transactions.maxCallbackQueriesPerCheck": "maxTransactionStatements",
  "transactions.maxCallbackRowsPerCheck": "maxCallbackRows",
  "transactions.maxCallbackBytesPerCheck": "maxTransactionResultBytes",
  "transactions.maxHookDurationMs": "maxHookDurationMs",
  "transactions.maxInteractiveDurationMs": "transactionMs",
};
// Numbers that are not limits.
const NOT_LIMITS = new Set(["abiVersion"]);

const numericLeaves = (value, prefix = "") => Object.entries(value).flatMap(([key, child]) => {
  const path = prefix ? `${prefix}.${key}` : key;
  if (typeof child === "number") return NOT_LIMITS.has(path) ? [] : [path];
  return child && typeof child === "object" && !Array.isArray(child) ? numericLeaves(child, path) : [];
});
const at = (value, path) => path.split(".").reduce((node, key) => node[key], value);

const assertAdvertisesExactly = (advertised, runtime) => {
  const enforced = runtimeLimits(runtime);
  assert.deepEqual(numericLeaves(advertised).sort(), Object.keys(ADVERTISED_SOURCES).sort(),
    "every advertised number has an enforcement source, and every source is advertised");
  for (const [path, key] of Object.entries(ADVERTISED_SOURCES)) {
    assert.ok(ENFORCED_LIMIT_KEYS.includes(key), key);
    assert.equal(at(advertised, path), enforced[key], path);
  }
};

test("Capabilities advertises exactly the runtime's limits, each from its own source", () => {
  // Distinct values, so an advertised number taken from the wrong source cannot match.
  const distinct = Object.fromEntries(ENFORCED_LIMIT_KEYS.map((key, index) => [key, 1_000 + index]));
  const runtime = {
    snapshot: "s", profile: "p", abi_version: 5, commit_checks_enabled: true,
    limits_json: limitsJson(distinct),
  };
  assertAdvertisesExactly(capabilities(runtime, { limits: { maxRows: 1 } }), runtime);
});

test("the real runtime reports configured limits, fills defaults, and Capabilities equals them", () => {
  const configured = {
    ...REQUIRED, maxRows: 42, transactionMs: 2_500, maxTransactionStatements: 3, maxTransactionResultBytes: 4_096,
    maxCallbackRows: 7, beginTimeoutMs: 600, costTimeoutMs: 700, maxBytesPerValue: 12_345,
  };
  const runtime = construct(configured);
  try {
    const enforced = runtimeLimits(runtime);
    for (const [key, value] of Object.entries(configured)) assert.equal(enforced[key], value, key);
    assertAdvertisesExactly(capabilities(runtime), runtime);
    const defaults = construct(REQUIRED);
    try {
      assert.deepEqual({ ...runtimeLimits(defaults) }, { ...RUNTIME_DEFAULT_LIMITS },
        "omitted fields take the constants they replace; fixed constants match the test doubles");
      assert.equal(defaults.snapshot, runtime.snapshot, "limits are not part of the snapshot");
      assert.equal("max_bytes_per_value" in defaults, false, "the per-value limit is a limits_json field, not a getter (ADR 0027)");
    } finally { defaults.free(); }
  } finally { runtime.free(); }
});

test("the reference wrapper's limits are what its runtime enforces and advertises", () => {
  const runtime = construct(RUNTIME_LIMITS);
  try {
    const enforced = runtimeLimits(runtime);
    for (const [key, value] of Object.entries(RUNTIME_LIMITS)) assert.equal(enforced[key], value, key);
    assertAdvertisesExactly(capabilities(runtime), runtime);
  } finally { runtime.free(); }
});

test("construction rejects every invalid limit and names the field", () => {
  const ranges = {
    // ADR 0027 pull request 6: hard maxima for the result side.
    maxRows: [1, 100_000], maxResultBytes: [1, 524_288],
    timeoutMs: [1, 9_007_199_254_740_991], maxStatements: [1, 64],
    transactionMs: [1, 60_000], maxTransactionStatements: [1, 256], maxTransactionResultBytes: [1, 65_536],
    maxCallbackRows: [1, 10_000], beginTimeoutMs: [1, 60_000], costTimeoutMs: [1, 10_000],
    // ADR 0027: the request-side limits have a minimum (the envelope must fit) and a hard maximum.
    maxRequestBytes: [65_536, 2_097_152], maxJsonValues: [1_024, 131_072], maxSqlBytes: [1_024, 1_048_576],
    // ADR 0027 pull request 5: decoded bytes of one bytes value, up to what a request can carry.
    maxBytesPerValue: [1, 1_048_576],
    // ADR 0027 pull request 4: the input-side limits of the binder, with their hard maxima.
    maxParameters: [1, 16_384], maxExpressionDepth: [1, 64], maxProjections: [1, 2_000], maxJoins: [1, 63],
  };
  const snake = (key) => key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
  for (const [key, [min, max]] of Object.entries(ranges)) {
    // Shape: rejected by the wrapper-facing mapping, naming the key, before the runtime.
    for (const bad of [0, -1, 1.5, "8", null, true, Number.POSITIVE_INFINITY]) {
      assert.throws(() => runtimeLimitsJson({ ...REQUIRED, [key]: bad }),
        (error) => error instanceof TypeError && error.message === `limits.${key} must be a positive integer`, `${key}=${bad}`);
    }
    // Range: rejected by the runtime, naming the field.
    if (max < Number.MAX_SAFE_INTEGER) {
      assert.throws(() => construct({ ...REQUIRED, [key]: max + 1 }),
        (error) => String(error).includes(`\`${snake(key)}\` must be an integer from ${min} to ${max}`), `${key}=${max + 1}`);
    }
    if (min > 1) {
      assert.throws(() => construct({ ...REQUIRED, [key]: min - 1 }),
        (error) => String(error).includes(`\`${snake(key)}\` must be an integer from ${min} to ${max}`), `${key}=${min - 1}`);
    }
    for (const good of [min, max]) construct({ ...REQUIRED, [key]: good }).free();
  }
  for (const key of Object.keys(REQUIRED)) {
    const { [key]: _omitted, ...missing } = REQUIRED;
    assert.throws(() => construct(missing), (error) => String(error).includes(`\`${snake(key)}\` is required`), key);
  }
  // A statement cannot be longer than the body that carries it (explicit, ADR 0021).
  assert.throws(() => construct({ ...REQUIRED, maxRequestBytes: 65_536, maxSqlBytes: 65_537 }),
    (error) => String(error).includes("`max_sql_bytes` must not exceed `max_request_bytes`"));
  construct({ ...REQUIRED, maxRequestBytes: 65_536, maxSqlBytes: 65_536 }).free();
  construct({ ...REQUIRED, maxRequestBytes: 2_097_152, maxSqlBytes: 1_048_576 }).free();
  for (const key of ["transactionMS", "maxInteractiveDurationMs", "max_rows"]) {
    assert.throws(() => runtimeLimitsJson({ ...REQUIRED, [key]: 1 }),
      (error) => error instanceof TypeError && error.message === `limits.${key} is not a runtime limit`, key);
  }
  for (const limits of [undefined, null, [], "limits"]) assert.throws(() => runtimeLimitsJson(limits), TypeError);
  // The runtime rejects unknown fields too, for a caller that builds the JSON itself.
  assert.throws(() => new PolicySqlRuntime(example("catalog.yaml"), example("policy.yaml"), "s", "p",
    JSON.stringify({ max_rows: 1, max_result_bytes: 1, timeout_ms: 1, max_statements: 1, transactionMs: 1 })),
  (error) => String(error).includes("unknown field `transactionMs`"));
});

test("createEngine rejects publicConfig.limits and any other unknown public setting", () => {
  const ports = { getRuntime: () => ({}), database: testProvider(), config: testConfig(), transactionOwners: testOwners() };
  const versions = { schemaVersion: "s", policyVersion: "p" };
  createEngine({ ...ports, publicConfig: versions });
  createEngine(ports);
  assert.throws(() => createEngine({ ...ports, publicConfig: { ...versions, limits: {} } }), /publicConfig\.limits was removed/u);
  assert.throws(() => createEngine({ ...ports, publicConfig: { ...versions, maxRows: 1 } }), /publicConfig\.maxRows is not a setting/u);
  assert.throws(() => createEngine({ ...ports, publicConfig: { schemaVersion: 1 } }), /must be a string/u);
  for (const publicConfig of [null, [], "x"]) assert.throws(() => createEngine({ ...ports, publicConfig }), TypeError);
});

test("the engine reads limits only from a well-formed runtime report", () => {
  const base = { snapshot: "s" };
  const reports = [
    undefined,
    () => "not json",
    () => "[]",
    () => JSON.stringify({ ...RUNTIME_DEFAULT_LIMITS, extra: 1 }),
    () => { const { maxCallbackRows: _omitted, ...rest } = RUNTIME_DEFAULT_LIMITS; return JSON.stringify(rest); },
    () => { const { maxBytesPerValue: _omitted, ...rest } = RUNTIME_DEFAULT_LIMITS; return JSON.stringify(rest); },
    () => { const { maxJsonValues: _omitted, ...rest } = RUNTIME_DEFAULT_LIMITS; return JSON.stringify(rest); },
    () => JSON.stringify({ ...RUNTIME_DEFAULT_LIMITS, maxBytesPerValue: 0 }),
    () => JSON.stringify({ ...RUNTIME_DEFAULT_LIMITS, maxRequestBytes: 1.5 }),
    () => JSON.stringify({ ...RUNTIME_DEFAULT_LIMITS, transactionMs: 0 }),
    () => JSON.stringify({ ...RUNTIME_DEFAULT_LIMITS, maxTransactionStatements: "8" }),
    () => JSON.stringify({ ...RUNTIME_DEFAULT_LIMITS, maxCallbackRows: 1.5 }),
  ];
  for (const [index, limits_json] of reports.entries()) {
    assert.throws(() => runtimeLimits({ ...base, limits_json }), TypeError, String(index));
    assert.throws(() => capabilities({ ...base, limits_json }), TypeError, String(index));
  }
  for (const runtime of [undefined, null, 1, "runtime"]) assert.throws(() => runtimeLimits(runtime), TypeError);
});

test("no limit the runtime reports is left as a literal in the engine", () => {
  const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
  const owner = source("transaction-owner.ts");
  for (const pattern of [/MAX_(TRANSACTION_MS|STATEMENTS|RESULT_BYTES)/u, /\b4_?000\b/u, /\b64_?000\b/u, /[<>]=? *100\b/u, /begin\([^)]*\b1_?000\)/u]) {
    assert.doesNotMatch(owner, pattern);
  }
  for (const name of ["step-effects.ts", "request-step.ts"]) assert.doesNotMatch(source(name), /\b1_?000\b/u, name);
  assert.doesNotMatch(source("presenters.ts"), /\bLIMITS\b|publicConfig\.limits|max\w+: \d/u);
  assert.doesNotMatch(source("config.ts"), /\bLIMITS\b|\d_\d{3}/u, "config.ts holds no limit");
});

// Records every database begin through the provider: its request id, mode, timeout, and the
// deadline it was given relative to when it was called.
const beginSpy = (begins) => (provider) => ({
  ...provider,
  async connect(binding, requestId) {
    const transport = await provider.connect(binding, requestId);
    const begin = (mode, timeoutMs, deadlineMs, options) => {
      begins.push({ requestId, mode, timeoutMs, deadlineInMs: deadlineMs - Date.now() });
      return transport.begin(mode, timeoutMs, deadlineMs, options);
    };
    return new Proxy(transport, {
      get(target, property) {
        if (property === "begin") return begin;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
});

for (const ownerAdapter of OWNER_ADAPTERS) {
  const setup = (t, limits, options = {}) => harness(t, { ownerAdapter, runtimeLimits: { ...REQUIRED, ...limits }, ...options });
  const start = async (h, mode) => {
    const started = await h.request("a", "/v1/transactions", { mode }, null);
    assert.equal(started.status, 201, JSON.stringify(started.body));
    return started.body.transactionId;
  };

  test(`${ownerAdapter}: deployed Capabilities shows the configured limits`, async (t) => {
    const h = await setup(t, { transactionMs: 2_000, maxTransactionStatements: 5, maxCallbackRows: 9, maxTransactionResultBytes: 9_000 }, { hooks: false });
    const response = await h.request("a", "/v1/capabilities");
    assert.equal(response.status, 200);
    assertAdvertisesExactly(response.body, h.runtime);
    assert.equal(response.body.transactions.maxInteractiveDurationMs, 2_000);
    assert.equal(response.body.transactions.maxCallbackQueriesPerCheck, 5);
    assert.equal(response.body.transactions.maxCallbackRowsPerCheck, 9);
    assert.equal(response.body.transactions.maxCallbackBytesPerCheck, 9_000);
  });

  test(`${ownerAdapter}: transactionMs sets the interactive deadline and expiry`, async (t) => {
    const h = await setup(t, { transactionMs: 1_500 }, { hooks: false });
    const before = Date.now();
    const id = await start(h, "read");
    const { expiresAtMs } = await h.ownerRecord(id);
    assert.ok(expiresAtMs >= before + 1_500 && expiresAtMs <= Date.now() + 1_500, `${expiresAtMs - before}`);
    assert.equal(await h.ownerTimerAt(id), expiresAtMs);
    // Enforced: a short duration expires a transaction the default would keep open.
    const short = await setup(t, { transactionMs: 40 }, { hooks: false });
    const expiring = await start(short, "read");
    await sleep(80);
    const late = await short.request("a", `/v1/transactions/${expiring}/statements`, { sequence: 1, ...read }, null);
    // Past its deadline the owner's database work times out or the transaction is gone.
    assert.ok(["POLICYSQL_TRANSACTION_UNAVAILABLE", "POLICYSQL_DATABASE_TIMEOUT"].includes(late.body.error?.code), JSON.stringify(late.body));
    assert.notEqual((await short.ownerRecord(expiring)).status, "active");
  });

  test(`${ownerAdapter}: maxTransactionStatements bounds statements per transaction`, async (t) => {
    const h = await setup(t, { maxTransactionStatements: 2 }, { hooks: false });
    const id = await start(h, "read");
    const path = `/v1/transactions/${id}/statements`;
    for (const sequence of [1, 2]) assert.equal((await h.request("a", path, { sequence, ...read }, null)).status, 200);
    const third = await h.request("a", path, { sequence: 3, ...read }, null);
    assert.equal(third.status, 413, JSON.stringify(third.body));
    assert.equal(third.body.error.code, "POLICYSQL_TRANSACTION_LIMIT_EXCEEDED");
    assert.equal((await h.ownerRecord(id)).status, "failed");
  });

  // #62: the transaction limits are permanent, so they are 413 (as POLICYSQL_LIMIT_EXCEEDED), never
  // 429, which tells a client or proxy to retry later. The client treats it as a definite rejection
  // and sends the statement exactly once.
  test(`${ownerAdapter}: a transaction limit is a permanent 413 that the client rejects without retrying`, async (t) => {
    const h = await setup(t, { maxTransactionStatements: 1 }, { hooks: false });
    const sent = [];
    const fetchImpl = async (url, init) => {
      const response = await h.app.fetch(new Request(url, init), { database: h.binding("a"), session: h.session("a") }, h.background);
      sent.push({ path: new URL(url).pathname, status: response.status, retryAfter: response.headers.get("retry-after") });
      return response;
    };
    const client = new PolicySqlClient({ transport: createHttpTransport({ endpoint: "https://worker.test", fetchImpl }) });
    const tx = await client.beginTransaction({ mode: "read" });
    await tx.execute(read.sql);
    await assert.rejects(tx.execute(read.sql), (error) => {
      assert.ok(error instanceof PolicySqlError);
      assert.equal(error instanceof PolicySqlOutcomeUnknownError, false);
      assert.equal(error.code, "POLICYSQL_TRANSACTION_LIMIT_EXCEEDED");
      assert.equal(error.status, 413);
      assert.equal(error.response.body.error.code, "POLICYSQL_TRANSACTION_LIMIT_EXCEEDED");
      return true;
    });
    const statements = sent.filter((request) => request.path.endsWith("/statements"));
    assert.deepEqual(statements.map((request) => request.status), [200, 413], "one attempt per statement, no retry");
    assert.equal(statements[1].retryAfter, null);
    assert.equal(sent.some((request) => request.status === 429), false);
  });

  test(`${ownerAdapter}: maxTransactionResultBytes bounds a transaction's cumulative result bytes`, async (t) => {
    const probe = await setup(t, {}, { hooks: false });
    const probed = await probe.request("a", `/v1/transactions/${await start(probe, "read")}/statements`, { sequence: 1, ...read }, null);
    assert.equal(probed.status, 200);
    const bytes = new TextEncoder().encode(JSON.stringify(probed.body.result)).byteLength;
    for (const [limit, status] of [[bytes, 200], [bytes - 1, 413]]) {
      const h = await setup(t, { maxTransactionResultBytes: limit }, { hooks: false });
      const response = await h.request("a", `/v1/transactions/${await start(h, "read")}/statements`, { sequence: 1, ...read }, null);
      assert.equal(response.status, status, `limit=${limit}: ${JSON.stringify(response.body)}`);
    }
  });

  test(`${ownerAdapter}: maxCallbackRows bounds a commit check's callback rows`, async (t) => {
    // The callback reads the seed row and the transaction's own row: two rows.
    for (const [limit, callbackStatus, commitStatus] of [[2, 200, 200], [1, 413, 409]]) {
      const h = await setup(t, { maxCallbackRows: limit });
      const id = await start(h, "write");
      assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert(`rows_${limit}`) }, null)).status, 200);
      const committed = await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 }, null);
      assert.equal(h.hooksSeen[0].status, callbackStatus, `limit=${limit}: ${JSON.stringify(h.hooksSeen[0].result)}`);
      assert.equal(committed.status, commitStatus, `limit=${limit}`);
      if (callbackStatus !== 200) assert.equal(h.hooksSeen[0].result.error.code, "POLICYSQL_TRANSACTION_LIMIT_EXCEEDED");
    }
  });

  test(`${ownerAdapter}: maxTransactionStatements also caps callback queries per check`, async (t) => {
    const h = await setup(t, { maxTransactionStatements: 1 });
    const statuses = [];
    h.setValidator(async (hook) => {
      for (const sequence of [1, 2]) {
        const response = await h.request("a", new URL(hook.query.url).pathname, { sequence, ...read }, undefined, hook.query.token);
        statuses.push(response.status);
      }
      return true;
    });
    const id = await start(h, "write");
    assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("capped") }, null)).status, 200);
    await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 }, null);
    assert.deepEqual(statuses, [200, 409]);
  });

  test(`${ownerAdapter}: beginTimeoutMs, costTimeoutMs, and the atomic owner deadline come from the runtime`, async (t) => {
    const begins = [];
    const h = await setup(t, { transactionMs: 3_000, beginTimeoutMs: 700, costTimeoutMs: 900 }, { customizeProvider: beginSpy(begins) });
    const id = await start(h, "read");
    const interactive = begins.find((begin) => begin.mode === "read" && !begin.requestId.includes("-cost"));
    assert.equal(interactive.timeoutMs, 700, JSON.stringify(begins));
    assert.ok(interactive.deadlineInMs > 2_900 && interactive.deadlineInMs <= 3_000, "the transaction deadline");
    assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...read }, null)).status, 200);
    await h.flush();
    const cost = begins.filter((begin) => begin.requestId.includes("-cost"));
    assert.ok(cost.length > 0, "the statement was observed");
    for (const begin of cost) {
      assert.equal(begin.mode, "read");
      assert.ok(begin.timeoutMs <= 900 && begin.timeoutMs > 800, JSON.stringify(begin));
      assert.ok(begin.deadlineInMs <= 900 && begin.deadlineInMs > 800, JSON.stringify(begin));
    }
    // An atomic mutation with commit checks runs in an owner, bounded by transactionMs.
    assert.equal((await h.request("a", `/v1/transactions/${id}/rollback`, { sequence: 2 }, null)).status, 200);
    begins.length = 0;
    const atomic = await h.request("a", "/v1/transactions:execute", { statements: [insert("atomic_deadline")] }, "deadline-key-0001");
    assert.equal(atomic.status, 200, JSON.stringify(atomic.body));
    const write = begins.find((begin) => begin.mode === "write");
    assert.ok(write.deadlineInMs > 2_900 && write.deadlineInMs <= 3_000, JSON.stringify(write));
  });
}
