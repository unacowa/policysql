import test from "node:test";
import assert from "node:assert/strict";
import { createInProcessPolicySql, loadRuntime } from "../../../examples/in-process/policysql.ts";
import { identityRuntime as runtime } from "./helpers/identity.mjs";
// The default `maxRequestBytes` (ADR 0027), which these fixtures stay under.
const MAX_BODY_BYTES = 1_048_576;

// Core computes every identity, fingerprint, and digest (ADR 0024 pull request 2, ADR 0025);
// the engine and the owner use its result only. These tests hold the cost of core's
// canonicalization on hostile but in-limit bodies, and that the owner hashes only commands
// that compile.

const auth = {
  principal: "https://issuer.test:user_1", subject: "user_1", role: "member", roles: ["member"], access: ["execute"],
  session: { tenant_id: "tenant_a" },
};
const binding = { version: 1, scope: "tenant", databaseId: "db_1", generation: "1", snapshot: "snap_1" };
const KEY = "request-key-0001";

const core = (input) => JSON.parse(runtime.identity_json(typeof input === "string" ? input : JSON.stringify(input)));
// Core reads the value from the raw text (embedded, not re-serialized by JavaScript).
const coreDigestOfText = (text) => core(`{"op":"callback","command":${text}}`).digest;

// #55 review: canonicalization must not be super-linear up to the body limit, and the owner
// must not hash a body that cannot compile. 20,000 equal-length keys that share a 40-character
// prefix took 11 s with an earlier per-key duplicate scan. The bound below catches such
// regressions, not the platform's CPU limit, which only a measurement on Workers can show.
const ABSOLUTE_BOUND_MS = 250;
const wideParams = (count = 20_000) =>
  `{${Array.from({ length: count }, (_, index) => `"${"a".repeat(40)}${String(index).padStart(6, "0")}":0`).join(",")}}`;
// The fastest of a few runs (after one warm-up), so a busy test machine does not fail a bound
// by chance.
const fastest = (runs, work) => {
  work();
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
};
const assertFast = (label, work) => {
  const ms = fastest(5, work);
  assert.ok(ms < ABSOLUTE_BOUND_MS, `${label}: core took ${ms.toFixed(1)} ms`);
};

test("a wide object near the body limit is hashed in time linearithmic in its keys", () => {
  const params = wideParams();
  const body = `{"sequence":1,"sql":"SELECT id FROM projects","params":${params}}`;
  assert.ok(body.length > 1_000_000 && body.length < MAX_BODY_BYTES, `${body.length}`);
  const command = JSON.parse(body);
  const input = JSON.stringify({ op: "command", kind: "statement", command });
  assert.match(core(input).digest, /^[a-f0-9]{64}$/u);
  const request = JSON.stringify({ op: "request", endpoint: "execute", auth, binding, body, key: KEY });
  assert.match(core(request).idempotency.fingerprint, /^[a-f0-9]{64}$/u);
  assertFast("command digest", () => runtime.identity_json(input));
  assertFast("request identity", () => runtime.identity_json(request));
  // A duplicate key among them is still rejected (the engine rejects it before core runs).
  const duplicate = `{"op":"callback","command":${params.slice(0, -1)},"${"a".repeat(40)}000000":1}}`;
  assert.equal(core(duplicate).error.code, "POLICYSQL_INTERNAL");
  assertFast("duplicate detection", () => runtime.identity_json(duplicate));
});

test("number-heavy bodies near the body limit are hashed in time linear in the body", () => {
  const shapes = {
    "short decimals": (index) => `${index % 100}.${index % 10}`,
    "small integers": (index) => String(index % 1000),
    "17-digit decimals": (index) => `${90071992547409 + index * 7}.${String(index % 1000).padStart(3, "0")}`,
    "exponents": (index) => `${(index % 9) + 1}.${index % 97}e${(index % 600) - 300}`,
    "integral decimals": (index) => `${index * 7919}.0`,
  };
  for (const [name, make] of Object.entries(shapes)) {
    const items = [];
    let length = 2;
    for (let index = 0; length < 1_000_000; index++) {
      const item = make(index);
      items.push(item);
      length += item.length + 1;
    }
    const text = `[${items.join(",")}]`;
    assert.match(coreDigestOfText(text), /^[a-f0-9]{64}$/u, name);
    assertFast(name, () => coreDigestOfText(text));
  }
});

// The in-process engine and owner over the real runtime, recording every identity
// computation the engine and the owner ask core for.
const recordingEngine = (t) => {
  t.mock.method(console, "log", () => {});
  const real = loadRuntime()();
  const calls = [];
  const runtimeProxy = new Proxy(real, {
    get(target, key) {
      if (key === "identity_json") {
        return (input) => {
          calls.push(JSON.parse(input).op);
          return target.identity_json(input);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const p = createInProcessPolicySql(() => runtimeProxy);
  t.after(() => p.close());
  const session = {
    principal: "in-process:tenant_a", subject: "user_a", roles: ["member"], defaultRole: "member",
    access: ["execute"], session: { tenant_id: "tenant_a" },
  };
  return { p, calls, context: { database: p.binding, session, requestId: "req_wide" } };
};

const numberArrayBody = (sequence, make) => {
  const head = `{"sequence":${sequence},"sql":"SELECT id FROM projects WHERE name = :name","params":{"p":[`;
  const items = [];
  let length = head.length + 3;
  // At most 60,000 values: the engine refuses a body past `maxJsonValues` (65,536, ADR 0027)
  // before it reaches core, and this fixture is about the work core does for a body it admits.
  for (let index = 0; length < 1_030_000 && index < 60_000; index++) {
    const item = make(index);
    items.push(item);
    length += item.length + 1;
  }
  return `${head}${items.join(",")}]}}`;
};

// Regression fixture (#55 re-review): ~1 MB number arrays in `params`. The owner compiles such
// a statement before hashing it, so one that cannot compile is never hashed. The responses
// are main's before ADR 0024 pull request 2, byte for byte, except the exponents (below).
const INVALID_PARAMETER = { code: "POLICYSQL_INVALID_PARAMETER", message: "A statement parameter is missing or invalid.", path: "/statements/0" };
// Before ADR 0024 pull request 7 the owner re-serialized the command, and these exponents
// (`1e300` as `1e+300`) made the envelope exceed core's request limit, so compile rejected the
// envelope (POLICYSQL_INVALID_REQUEST). The step machine compiles the verified text itself
// (#70), which is within the limit, so its parameters are rejected, as an atomic execute does.
const CONFLICT = { code: "POLICYSQL_TRANSACTION_CONFLICT", message: "The transaction command conflicts with its current state.", path: null };
const NUMBER_SHAPES = {
  "17-digit decimals": [(index) => `${90071992547409 + index * 7}.${String(index % 1000).padStart(3, "0")}`, INVALID_PARAMETER],
  "short decimals": [(index) => `${index % 100}.${index % 10}`, INVALID_PARAMETER],
  "small integers": [(index) => String(index % 1000), INVALID_PARAMETER],
  "exponents": [(index) => `${(index % 9) + 1}.${index % 97}e${(index % 600) - 300}`, INVALID_PARAMETER],
};

test("regression: a statement of up to 60,000 numbers that cannot compile is answered as before and never hashed", async (t) => {
  for (const [name, [make, compileError]] of Object.entries(NUMBER_SHAPES)) {
    for (const mode of ["next sequence", "possible exact retry"]) {
      const { p, calls, context } = recordingEngine(t);
      const begun = await p.engine.begin({ bodyText: "{\"mode\":\"read\"}" }, context);
      assert.equal(begun.ok, true, JSON.stringify(begun));
      const { transactionId } = begun.value;
      if (mode === "possible exact retry") {
        const first = await p.engine.statement({ transactionId, bodyText: JSON.stringify({ sequence: 1, sql: "SELECT id FROM projects WHERE name = :name", params: { name: "x" } }) }, context);
        assert.equal(first.ok, true, JSON.stringify(first));
      }
      const bodyText = numberArrayBody(1, make);
      assert.ok(bodyText.length > 200_000 && bodyText.length < MAX_BODY_BYTES);
      calls.length = 0;
      const started = performance.now();
      const result = await p.engine.statement({ transactionId, bodyText }, context);
      const elapsed = performance.now() - started;
      assert.deepEqual(result.error, mode === "next sequence" ? compileError : CONFLICT, `${name}, ${mode}`);
      // Neither the engine nor the owner calls identity_json for a command any more: the
      // owner's step machine computes the fingerprint and digest in core (ADR 0024 pull
      // request 7), after compile, and never for a command that cannot compile (its tests).
      assert.deepEqual(calls, [], `${name}, ${mode}`);
      assert.ok(elapsed < 500, `${name}, ${mode}: ${elapsed.toFixed(1)} ms`);
      // The transaction is closed.
      const after = await p.engine.statement({ transactionId, bodyText: JSON.stringify({ sequence: 2, sql: "SELECT id FROM projects", params: {} }) }, context);
      assert.equal(after.error?.code, "POLICYSQL_TRANSACTION_UNAVAILABLE", `${name}, ${mode}`);
    }
  }
});

test("a wide statement body that cannot compile is answered definitely and never hashed by the owner", async (t) => {
  const { p, calls, context } = recordingEngine(t);
  const begun = await p.engine.begin({ bodyText: "{\"mode\":\"read\"}" }, context);
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const bodyText = `{"sequence":1,"sql":"SELECT id FROM projects","params":${wideParams()}}`;
  assert.ok(bodyText.length < MAX_BODY_BYTES);
  calls.length = 0;
  const result = await p.engine.statement({ transactionId: begun.value.transactionId, bodyText }, context);
  // The compiler rejects parameters the statement does not use: a definite client error.
  assert.equal(result.ok, false);
  assert.notEqual(result.error.code, "POLICYSQL_INTERNAL", JSON.stringify(result.error));
  assert.deepEqual(calls, []);
});

test("a statement that compiles is hashed by core once, and its exact retry replays", async (t) => {
  const { p, calls, context } = recordingEngine(t);
  const begun = await p.engine.begin({ bodyText: "{\"mode\":\"read\"}" }, context);
  const { transactionId } = begun.value;
  const bodyText = JSON.stringify({ sequence: 1, sql: "SELECT id FROM projects WHERE name = :name", params: { name: "x" } });
  calls.length = 0;
  const first = await p.engine.statement({ transactionId, bodyText }, context);
  assert.equal(first.ok, true, JSON.stringify(first));
  // Hashed inside the owner's step (core), not through identity_json.
  assert.deepEqual(calls, []);
  calls.length = 0;
  const retried = await p.engine.statement({ transactionId, bodyText }, context);
  assert.deepEqual(retried, { ...first, requestId: retried.requestId });
  assert.deepEqual(calls, []);
});

test("a core failure is POLICYSQL_INTERNAL before any database work", async (t) => {
  t.mock.method(console, "log", () => {});
  const real = loadRuntime()();
  let broken = null;
  const runtimeProxy = new Proxy(real, {
    get(target, key) {
      if (key === "identity_json") {
        return (input) => JSON.parse(input).op === broken ? "not json" : target.identity_json(input);
      }
      // One failing step of the owner's machine (its output is not JSON).
      if (key === "step_json") {
        return (...args) => {
          if (broken !== "step") return target.step_json(...args);
          broken = null;
          return "not json";
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const p = createInProcessPolicySql(() => runtimeProxy);
  t.after(() => p.close());
  const session = {
    principal: "in-process:tenant_a", subject: "user_a", roles: ["member"], defaultRole: "member",
    access: ["execute"], session: { tenant_id: "tenant_a" },
  };
  const context = { database: p.binding, session, requestId: "req_core_failure" };
  const rows = () => p.database.prepare("SELECT count(*) AS n FROM projects").get().n;
  const before = rows();
  // Since ADR 0024 pull request 8 an execute is the engine's `request` step, which computes the
  // identity itself: a failing step is INTERNAL and nothing executes.
  broken = "step";
  const insert = JSON.stringify({ statements: [{ sql: "INSERT INTO projects (id, name) VALUES (:id, :name)", params: { id: "p1", name: "x" } }] });
  assert.equal((await p.engine.execute({ bodyText: insert, idempotencyKey: KEY }, context)).error.code, "POLICYSQL_INTERNAL");
  assert.equal(rows(), before, "nothing executed");
  assert.equal(broken, null, "the request step was called");
  broken = "start";
  assert.equal((await p.engine.begin({ bodyText: "{\"mode\":\"write\"}" }, context)).error.code, "POLICYSQL_INTERNAL");
  broken = null;
  const begun = await p.engine.begin({ bodyText: "{\"mode\":\"write\"}" }, context);
  const { transactionId } = begun.value;
  // The owner's step machine fails: the owner abandons its state and answers 500 (ADR 0024).
  broken = "step";
  const statement = JSON.stringify({ sequence: 1, sql: "INSERT INTO projects (id, name) VALUES (:id, :name)", params: { id: "p2", name: "x" } });
  assert.equal((await p.engine.statement({ transactionId, bodyText: statement }, context)).error.code, "POLICYSQL_INTERNAL");
  assert.equal(rows(), before);
  // The abandoned transaction is closed: nothing runs on it afterwards.
  assert.equal((await p.engine.statement({ transactionId, bodyText: statement }, context)).error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  assert.equal(rows(), before);
});
