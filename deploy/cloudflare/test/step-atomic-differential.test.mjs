// The differential harness of ADR 0024 pull requests 6 and 8, against its recorded reference
// since pull request 9. It ran atomic `execute` through the engine of before pull request 8
// (`createLegacyExecute`: `executeSealedEnvelope` on the direct path, `LegacyTransactionOwnerCore`
// on the owner path) and through production (`createEngine`, whose `request` step runs the
// direct placement and forwards to production `TransactionOwnerCore` owners behind the in-memory
// port), with the same fake clock, the same kind of database (one SQLite file each,
// `policysql_idempotency` included), the same store faults, and the same scripted validator.
// Pull request 9 deleted the TypeScript path; what it did in every scenario is recorded in
// test/fixtures/reference/step-atomic-differential.json (the "ts" side,
// test/helpers/reference-transcript.mjs). The harness runs production and asserts equal
// results, database calls (SQL and arguments; the stored `response_json` compared as JSON),
// validator calls (the signed hook body with the token masked), callback replies, trace-sink
// calls, cost observations, and final rows (the idempotency table included), except the
// differences in `ALLOWLIST`, each named with its reason.
//
// It covers the scenarios of the former turso.test.mjs, execute-egress.test.mjs,
// idempotency.test.mjs, and cost.test.mjs that reach execution, on both placements, keyed and
// unkeyed. The owner-level scenarios of interactive transactions are in
// step-differential.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initSync, PolicySqlRuntime } from "../pkg/policysql_wasm.js";
import { createEngine } from "../src/engine.ts";
import { EngineError } from "../src/errors.ts";
import { runtimeLimitsJson } from "../src/limits.ts";
import { validateConfig } from "../src/engine-config.ts";
import { createMemoryTransactionOwners } from "./helpers/memory-owner.mjs";
import { asRecorded, referenceTranscript } from "./helpers/reference-transcript.mjs";

initSync({ module: readFileSync(new URL("../pkg/policysql_wasm_bg.wasm", import.meta.url)) });

// What the previous release's `execute` and `LegacyTransactionOwnerCore` did in every scenario
// below (the "ts" side), and what `cost.ts` estimated, recorded before pull request 9 deleted
// them.
const reference = referenceTranscript(new URL("./fixtures/reference/step-atomic-differential.json", import.meta.url));

/**
 * The intentional differences (ADR 0024 "Inconsistencies the move must resolve"). A scenario
 * that reaches one stops comparing there and asserts what each side does, except
 * `stored-record-shape`, which the comparison normalizes as stated.
 */
export const ALLOWLIST = Object.freeze({
  "idempotency-conflict-code":
    "ADR 0024 inconsistency 1: a keyed retry whose row has another fingerprint is IDEMPOTENCY_CONFLICT on both " +
    "placements in core; LegacyTransactionOwnerCore answered TRANSACTION_CONFLICT on the owner path. Both are definite " +
    "rejections of execute in the client.",
  "duplicate-idempotency-rows":
    "ADR 0024 inconsistency 2: more than one row for a key hash is INTERNAL (500) on both placements in core; " +
    "LegacyTransactionOwnerCore answered TRANSACTION_CONFLICT (409) on the owner path.",
  "stored-record-shape":
    "ADR 0024 inconsistency 2 (one strict rule for both paths): core writes one terminal record shape on both " +
    "placements, the owner path's, with `status: \"committed\"` and `commitChecks`; the TypeScript direct path " +
    "omits both keys. The comparison removes them from core's direct-path record after asserting their values; " +
    "core still replays the rows the TypeScript direct path wrote (`crates/policysql-transaction/tests/atomic.rs`).",
  "owner-prior-record-of-another-binding":
    "ADR 0024 pull request 6 (\"The owner's input\"; client-visible change 5 of pull request 8): an owner whose " +
    "previous record has another binding or snapshot does not answer from that record; core resolves the request " +
    "through its row (here IDEMPOTENCY_CONFLICT, since the fingerprint includes the binding). " +
    "LegacyTransactionOwnerCore answered TRANSACTION_CONFLICT from the record, before any database work.",
  "owner-commit-failure-code":
    "ADR 0024 pull request 7 executor and pull request 8 (client-visible change 6): the owner classifies every " +
    "COMMIT failure as `unknown`, which core answers INTERNAL (500) for execute. LegacyTransactionOwnerCore passed " +
    "the transport's code through (DATABASE_UNAVAILABLE, 503). Neither is a rejection in the client.",
  "direct-binding-revoked-before-commit":
    "ADR 0024 pull request 8 (client-visible change 6'): a binding the provider revokes between the envelope and " +
    "COMMIT (the transport's check before COMMIT) is a COMMIT failure of class `rejected`, which core answers " +
    "INTERNAL (500) for execute, because COMMIT may have been sent. The TypeScript direct path answered " +
    "DATABASE_BINDING_REJECTED (403). Neither is a rejection in the client; no COMMIT reaches the database.",
  "request-fingerprint-without-snapshot":
    "#80 (ABI 9): the request fingerprint no longer includes the binding's snapshot, so a committed keyed write " +
    "retried after a snapshot-changing deployment replays. Every stored fingerprint therefore differs from the " +
    "recorded one. The comparison names each fingerprint by its order of first appearance in the scenario, on " +
    "each side, so which rows and calls share a fingerprint is still compared; the value itself is pinned by " +
    "core's tests (crates/policysql-transaction/src/identity.rs, tests/fixtures/identity-goldens.json).",
});

/**
 * `request-fingerprint-without-snapshot`: replaces every `fingerprint` member below `value`
 * with `<fingerprint N>`, N its order of first appearance in `names` (one map per side and
 * scenario).
 */
const relabelFingerprints = (names, value) => {
  if (Array.isArray(value)) return value.map((item) => relabelFingerprints(names, item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key !== "fingerprint" || typeof item !== "string") return [key, relabelFingerprints(names, item)];
    if (!names.has(item)) names.set(item, `<fingerprint ${names.size + 1}>`);
    return [key, names.get(item)];
  }));
};

const CATALOG = `version: 1
resources:
  projects:
    source: { table: projects }
    columns:
      id: { type: string }
      tenant_id: { type: string }
      name: { type: string, nullable: true }
  counters:
    source: { table: counters }
    columns:
      id: { type: string }
      tenant_id: { type: string }
      big: { type: int64, representation: number, nullable: true }
      ratio: { type: number, nullable: true }
  audited:
    source: { table: audited }
    columns:
      id: { type: string }
      tenant_id: { type: string }
      note: { type: string, nullable: true }
`;
const POLICY = `version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id, name]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
        insert:
          columns: [id, name]
          presets: { tenant_id: { session: tenant_id } }
          check: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id, name] }
        update:
          columns: [name]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          check: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id, name] }
        delete:
          filter: { tenant_id: { eq: { session: tenant_id } } }
  counters:
    roles:
      member:
        select:
          columns: [id, big, ratio]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
        insert:
          columns: [id, big, ratio]
          presets: { tenant_id: { session: tenant_id } }
          check: { tenant_id: { eq: { session: tenant_id } } }
  audited:
    roles:
      member:
        select:
          columns: [id, note]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
        insert:
          columns: [id, note]
          presets: { tenant_id: { session: tenant_id } }
          check: { tenant_id: { eq: { session: tenant_id } } }
      auditor:
        select:
          columns: [id, note]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
commit_checks:
  retention:
    triggered_by: [audited]
    hook:
      timeout_ms: 800
  consistency:
    triggered_by: [audited]
    role: auditor
    hook:
      timeout_ms: 1000
`;
const SCHEMA = `
CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT);
CREATE TABLE counters (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, big INTEGER, ratio REAL);
CREATE TABLE audited (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, note TEXT);
CREATE TABLE policysql_idempotency (key_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL);
INSERT INTO projects VALUES ('seed', 'tenant_a', 'seed');
INSERT INTO projects VALUES ('hidden', 'tenant_b', 'hidden');
INSERT INTO audited VALUES ('a0', 'tenant_a', 'seed');
`;
const LIMITS = { maxRows: 100, maxResultBytes: 64_000, timeoutMs: 1_000, maxStatements: 8 };
const T0 = 1_790_000_000_000;
const HMAC_SECRET = "0123456789abcdef0123456789abcdef";
const VALIDATOR_URL = "https://validator.example.test/check";
const KEY = "request-key-0001";
const costCatalog = { maxEstimatedRowsRead: 1000, maxEstimatedRowsWritten: 1000, resources: { 1: { upperRows: 100 }, 2: { upperRows: 50 }, 3: { upperRows: 10 } } };
const config = {
  environment: "test",
  costCatalog,
  publicBaseUrl: "https://gateway.example.test",
  commitChecks: {
    consistency: { url: VALIDATOR_URL, hmacSecret: HMAC_SECRET },
    retention: { url: `${VALIDATOR_URL}/retention`, hmacSecret: HMAC_SECRET },
  },
};
const COMPARED_LOGS = new Set(["commit_check_unconfigured", "transaction_terminal_unrecorded", "cost_observation", "cost_observation_failed"]);

const makeRuntime = (limits = {}) =>
  new PolicySqlRuntime(CATALOG, POLICY, "schema_1", "policy_1", runtimeLimitsJson({ ...LIMITS, ...limits }));
const session = (access = ["execute"]) => ({
  principal: "https://issuer.test:user", subject: "user_1", roles: ["member"], defaultRole: "member",
  access, session: { tenant_id: "tenant_a" },
});
const bindingOf = (runtime) => ({ version: 1, scope: "tenant", databaseId: "db_a", generation: "1", snapshot: runtime.snapshot });

// A database provider over one SQLite file; every call outside cost observation is recorded.
const sqliteProvider = (path, calls, faults, connections) => ({
  check() { return faults.check ? faults.check() : true; },
  connect(_binding, requestId) {
    const cost = requestId.endsWith("-cost");
    return {
      async begin(mode) {
        if (!cost) calls.push({ op: "begin", mode });
        const db = new DatabaseSync(path);
        connections.push(db);
        db.exec("PRAGMA busy_timeout = 2000");
        db.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
        const transaction = {
          open: true,
          usage: [],
          async execute(statements) {
            if (!transaction.open) throw new Error("transaction closed");
            const results = [];
            for (const { sql, args } of statements) {
              if (!cost) {
                calls.push({ op: "execute", sql, args: Object.fromEntries(Object.entries(args ?? {}).map(([key, value]) =>
                  [key, typeof value === "bigint" ? `${value}n` : value])) });
                if (faults.execute) await faults.execute(sql);
              }
              const statement = db.prepare(sql);
              statement.setReturnArrays(true);
              const rows = statement.all(args ?? {});
              const changes = /^\s*(INSERT|UPDATE|DELETE)\b/iu.test(sql) ? db.prepare("SELECT changes() AS n").get().n : 0;
              const usage = { rowsRead: rows.length, rowsWritten: changes, queryDurationMs: 1 };
              transaction.usage.push(usage);
              results.push({ columns: statement.columns().map((column) => column.name), rows, rowsAffected: changes, usage });
            }
            if (!cost && faults.results) return faults.results(statements, results);
            return results;
          },
          async commit() {
            if (!cost) {
              calls.push({ op: "commit" });
              if (faults.commit) await faults.commit();
            }
            db.exec("COMMIT");
            transaction.open = false;
          },
          async rollback() {
            if (!cost) calls.push({ op: "rollback" });
            if (transaction.open) db.exec("ROLLBACK");
            transaction.open = false;
          },
        };
        return transaction;
      },
    };
  },
});

const signedBy = (secret, timestamp, body, signature) =>
  signature === `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
const ALLOW = () => Response.json({ version: "1", allowed: true });

/** Both sides with a fake clock. `limits` are the runtime limits; `trace` enables tracing. */
const environment = (t, { limits = {}, trace = false, engineConfig = config } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "policysql-step-atomic-"));
  const runtime = makeRuntime(limits);
  const clock = { now: T0 };
  t.mock.method(Date, "now", () => clock.now);
  const logs = { ts: [], step: [] };
  let current = "ts";
  t.mock.method(console, "log", (line) => {
    try {
      const value = JSON.parse(line);
      if (COMPARED_LOGS.has(value?.event)) logs[current].push(value);
    } catch { /* not a structured record */ }
  });
  const faults = {};
  const connections = [];
  const env = {
    runtime, clock, faults, logs, sides: {},
    hooks: { ts: [], step: [] }, tokens: { ts: [], step: [] }, callbacks: { ts: [], step: [] }, traces: { ts: [], step: [] },
    validator: ALLOW, validatorErrors: [],
    reference: reference.of(t),
    setSide(side) { current = side; },
    /** The side whose operation runs now (fault scripts act on that side). */
    currentSide: () => current,
  };
  for (const side of ["step"]) {
    const path = join(directory, `${side}.sqlite`);
    const db = new DatabaseSync(path);
    db.exec(SCHEMA);
    db.close();
    const calls = [];
    const database = sqliteProvider(path, calls, faults, connections);
    const getRuntime = () => runtime;
    const tasks = [];
    const background = { run(task) { tasks.push(Promise.resolve(task).catch(() => undefined)); } };
    const executionTrace = trace ? { enabled: true, sink: async (value) => { env.traces[side].push(structuredClone(value)); } } : undefined;
    let callbackCount = 0;
    const fetchImpl = async (url, init) => {
      const body = init.body;
      const hook = JSON.parse(body);
      const headers = new Headers(init.headers);
      env.tokens[side].push(hook.query.token);
      env.hooks[side].push({
        // The owner of an unkeyed execution is random on each side (`cval_` + 16 random bytes).
        url: String(url), body: body.replaceAll(hook.query.token, "<token>").replace(/cval_[0-9a-f]{32}/gu, "cval_<owner>"),
        signed: signedBy(HMAC_SECRET, headers.get("policysql-hook-timestamp"), body, headers.get("policysql-hook-signature")),
      });
      const query = async (text) => {
        const requestId = `cb-${++callbackCount}`;
        const owner = env.sides[side].owner(`tx_${hook.validationId.slice("cval_".length)}`);
        const reply = await owner.callbackQuery({ validationId: hook.validationId, capability: hook.query.token, command: text }, requestId);
        const normalized = reply.ok ? { ok: true, value: reply.value } : { ok: false, code: reply.error.code };
        env.callbacks[side].push(normalized);
        return normalized;
      };
      try {
        return await env.validator({ side, hook, query });
      } catch (error) {
        if (error instanceof assert.AssertionError) env.validatorErrors.push(error);
        throw error;
      }
    };
    const ownerDependencies = { getRuntime, database, config: engineConfig, fetchImpl };
    const owners = createMemoryTransactionOwners(() => ownerDependencies, { background });
    owners.interceptPut(({ value }) => faults.put?.({ phase: typeof value === "string" ? JSON.parse(value).phase : value?.status }));
    const engine = createEngine({ getRuntime, database, config: engineConfig, transactionOwners: owners.port, ...(executionTrace ? { executionTrace } : {}) });
    env.sides.step = { path, calls, tasks, background, execute: (input, context) => engine.execute(input, context, background),
      owner: (name) => owners.port.route(name), records: async () => Promise.all(owners.names().map((name) => owners.record(name))) };
  }
  t.after(() => {
    assert.deepEqual(env.validatorErrors, [], "the validator scripts' assertions hold");
    for (const db of connections) { try { db.close(); } catch { /* closed */ } }
    rmSync(directory, { recursive: true, force: true });
    runtime.free();
  });
  env.rows = (side) => {
    const db = new DatabaseSync(env.sides[side].path, { readOnly: true });
    try {
      return {
        projects: db.prepare("SELECT * FROM projects ORDER BY id").all().map((row) => ({ ...row })),
        counters: db.prepare("SELECT id, tenant_id, CAST(big AS TEXT) AS big, ratio FROM counters ORDER BY id").all().map((row) => ({ ...row })),
        audited: db.prepare("SELECT * FROM audited ORDER BY id").all().map((row) => ({ ...row })),
        idempotency: db.prepare("SELECT key_hash, fingerprint, response_json FROM policysql_idempotency ORDER BY rowid").all()
          .map((row) => ({ keyHash: row.key_hash, fingerprint: row.fingerprint, record: JSON.parse(row.response_json) })),
      };
    } finally { db.close(); }
  };
  let request = 0;
  env.nextRequest = () => `req-${++request}`;
  env.fingerprints = { ts: new Map(), step: new Map() };
  return env;
};

/**
 * `stored-record-shape`: core's direct-path record carries `status` and `commitChecks`;
 * the TypeScript direct path's does not. Asserted, then removed from core's side.
 */
const normalizeStored = (side, record) => {
  if (side !== "step" || record?.transactionId === undefined) return record;
  const { status, commitChecks, ...rest } = record;
  assert.equal(status, "committed", ALLOWLIST["stored-record-shape"]);
  assert.ok(["passed", "not_triggered"].includes(commitChecks), ALLOWLIST["stored-record-shape"]);
  return rest;
};

const normalizedCalls = (side, calls, ownerPath) => calls.map((call) => {
  if (call.op !== "execute" || !call.sql.startsWith("INSERT INTO policysql_idempotency")) return call;
  const record = JSON.parse(call.args.response_json);
  return { ...call, args: { ...call.args, response_json: ownerPath ? record : normalizeStored(side, record) } };
});

// The transaction id of an unkeyed owner execution names its random owner.
const randomOwner = (value) => (typeof value?.transactionId === "string" && /^atomic_[0-9a-f]{32}$/u.test(value.transactionId)
  ? { ...value, transactionId: "atomic_<owner>" } : value);

const normalizedResult = (result) => result.ok
  ? { ok: true, value: randomOwner(result.value), requestId: result.requestId }
  : { ok: false, code: result.error.code, message: result.error.message, path: result.error.path, requestId: result.requestId };

/** One `execute` on one side from `start`; returns what it saw and its clock at the end. */
const runSide = async (env, side, op, requestId, start) => {
  env.clock.now = start;
  const marks = {
    calls: env.sides[side].calls.length, logs: env.logs[side].length, hooks: env.hooks[side].length,
    callbacks: env.callbacks[side].length, traces: env.traces[side].length,
  };
  env.setSide(side);
  const context = { database: op.binding ?? bindingOf(env.runtime), session: session(op.access), requestId };
  const input = { bodyText: typeof op.body === "string" ? op.body : JSON.stringify(op.body),
    ...(op.key === undefined ? {} : { idempotencyKey: op.key }) };
  const result = await env.sides[side].execute(input, context);
  // Background work (cost observation) completes before the comparison.
  while (env.sides[side].tasks.length > 0) await env.sides[side].tasks.shift();
  return {
    seen: {
      result: normalizedResult(result),
      calls: normalizedCalls(side, env.sides[side].calls.slice(marks.calls), op.owner === true),
      logs: env.logs[side].slice(marks.logs).filter((log) => op.owner !== true || !log.event.startsWith("cost_")),
      hooks: env.hooks[side].slice(marks.hooks),
      callbacks: env.callbacks[side].slice(marks.callbacks),
      traces: env.traces[side].slice(marks.traces),
    },
    end: env.clock.now,
  };
};

/** One `execute` on the step side; returns what it and the reference side saw. */
const both = async (env, op) => {
  if (op.advance) {
    env.clock.now += op.advance;
    return null;
  }
  const requestId = env.nextRequest();
  const start = env.clock.now;
  const ts = env.reference.take("execute");
  const step = asRecorded(await runSide(env, "step", op, requestId, start));
  env.clock.now = Math.max(ts.end, step.end);
  ts.seen.calls = relabelFingerprints(env.fingerprints.ts, ts.seen.calls);
  step.seen.calls = relabelFingerprints(env.fingerprints.step, step.seen.calls);
  return { ts: ts.seen, step: step.seen };
};

const assertSame = (seen, label) => {
  if (!seen) return;
  assert.deepEqual(seen.step.result, seen.ts.result, `${label}: result`);
  assert.deepEqual(seen.step.calls, seen.ts.calls, `${label}: database calls`);
  assert.deepEqual(seen.step.logs, seen.ts.logs, `${label}: log events`);
  assert.deepEqual(seen.step.hooks, seen.ts.hooks, `${label}: validator calls`);
  assert.deepEqual(seen.step.callbacks, seen.ts.callbacks, `${label}: callback replies`);
  assert.deepEqual(seen.step.traces, seen.ts.traces, `${label}: trace sink`);
  for (const hook of seen.step.hooks) assert.equal(hook.signed, true, `${label}: the hook body is signed`);
};

const assertSameEnd = async (env, label, ownerPath = false) => {
  const rows = (side) => {
    const value = env.rows(side);
    return { ...value, idempotency: value.idempotency.map((row) => ({ ...row, record: ownerPath ? row.record : normalizeStored(side, row.record) })) };
  };
  assert.deepEqual(
    relabelFingerprints(env.fingerprints.step, asRecorded(rows("step"))),
    relabelFingerprints(env.fingerprints.ts, env.reference.take("rows")),
    `${label}: rows`,
  );
};

const agree = async (t, ops, prepare = () => {}, options = {}) => {
  const env = environment(t, options);
  prepare(env);
  // What each operation got (a status or a code), so a scenario also asserts its outcomes.
  env.answers = [];
  for (const [index, op] of ops.entries()) {
    const seen = await both(env, op);
    assertSame(seen, `op#${index}`);
    if (seen) env.answers.push(code(seen, "step"));
  }
  await assertSameEnd(env, "end", ops.some((op) => op.owner));
  return env;
};

const envelope = (...statements) => ({ statements: statements.map(([sql, params = {}, expect]) => ({ sql, params, ...(expect ? { expect } : {}) })) });
const selectProjects = envelope(["SELECT id, name FROM projects ORDER BY id"]);
const insertProject = (id, extra = {}) => envelope(["INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", { id, name: id }, extra.expect]);
const auditRow = (id) => envelope(["INSERT INTO audited (id, note) VALUES (:id, :note)", { id, note: id }]);
const code = (seen, side) => seen[side].result.code ?? seen[side].result.value?.status;

// ---- the direct placement ---------------------------------------------------------------------

const COMMITTED = "committed";

test("unkeyed reads, writes, and multi-statement envelopes agree, with their cost observations", async (t) => {
  const env = await agree(t, [
    { body: selectProjects },
    { body: insertProject("p1") },
    { body: envelope(["INSERT INTO counters (id, big, ratio) VALUES (:id, :big, :ratio)", { id: "c1", big: 9007199254740991, ratio: 0.5 }],
      ["SELECT id, big, ratio FROM counters ORDER BY id"], ["UPDATE projects SET name = :name WHERE id = :id RETURNING id, name", { id: "p1", name: "renamed" }]) },
    { body: envelope(["DELETE FROM projects WHERE id = :id", { id: "p1" }], ["SELECT id, name FROM projects ORDER BY id"]) },
  ]);
  assert.deepEqual(env.answers, [COMMITTED, COMMITTED, COMMITTED, COMMITTED]);
  assert.equal(env.logs.step.filter((log) => log.event === "cost_observation").length, 4);
});

test("a keyed write, its replay, and a conflicting body on the key agree", async (t) => {
  const env = await agree(t, [
    { body: insertProject("p1"), key: KEY },
    { body: insertProject("p1"), key: KEY },
    { body: insertProject("p2"), key: KEY },
    { body: insertProject("p2"), key: "request-key-0002" },
  ]);
  assert.deepEqual(env.answers, [COMMITTED, COMMITTED, "POLICYSQL_IDEMPOTENCY_CONFLICT", COMMITTED]);
  assert.equal(env.rows("step").idempotency.length, 2);
  assert.deepEqual(env.rows("step").projects.map((row) => row.id), ["hidden", "p1", "p2", "seed"]);
  // The replay executed nothing: one envelope per key.
  assert.equal(env.sides.step.calls.filter((call) => call.op === "commit").length, 2);
});

test("a read ignores the key, and a malformed key is rejected before any database work, alike", async (t) => {
  const env = await agree(t, [{ body: selectProjects, key: KEY }, { body: insertProject("p1"), key: "short" }, { body: selectProjects, key: "short" }]);
  assert.deepEqual(env.answers, [COMMITTED, "POLICYSQL_IDEMPOTENCY_KEY_REQUIRED", COMMITTED]);
  assert.equal(env.sides.step.calls.some((call) => call.sql?.includes("policysql_idempotency")), false);
});

test("a failed expectation rolls back, and nothing is stored, alike", async (t) => {
  const rename = (affectedRows) => envelope(["UPDATE projects SET name = :name WHERE id = :id RETURNING id, name", { id: "seed", name: "renamed" }, { affectedRows }]);
  const env = await agree(t, [
    { body: rename(2), key: KEY },
    { body: rename(2), key: KEY },
    { body: rename(1), key: KEY },
  ]);
  assert.deepEqual(env.answers, ["POLICYSQL_EXPECTATION_FAILED", "POLICYSQL_EXPECTATION_FAILED", COMMITTED]);
  assert.equal(env.sides.step.calls.filter((call) => call.op === "rollback").length, 2);
  assert.equal(env.rows("step").idempotency.length, 1);
});

test("the cumulative row and byte limits, and the database deadline, roll back alike", async (t) => {
  const rows = await agree(t, [{ body: insertProject("p1") }, { body: envelope(["SELECT id, name FROM projects ORDER BY id"], ["SELECT id, name FROM projects ORDER BY id"]) }], () => {}, { limits: { maxRows: 3 } });
  assert.deepEqual(rows.answers, [COMMITTED, "POLICYSQL_LIMIT_EXCEEDED"]);
  // `[{"id":"seed","name":"seed"}]` is 29 bytes.
  const over = await agree(t, [{ body: selectProjects }], () => {}, { limits: { maxResultBytes: 28 } });
  assert.deepEqual(over.answers, ["POLICYSQL_LIMIT_EXCEEDED"]);
  const within = await agree(t, [{ body: selectProjects }], () => {}, { limits: { maxResultBytes: 29 } });
  assert.deepEqual(within.answers, [COMMITTED]);
  // The envelope outlives its strictest timeout: the transport's deadline ends it first.
  const late = await agree(t, [{ body: insertProject("p1"), key: KEY }], (env) => {
    env.faults.execute = async (sql) => { if (sql.includes("INSERT INTO \"projects\"")) env.clock.now += 1_001; };
  });
  assert.deepEqual(late.answers, ["POLICYSQL_DATABASE_TIMEOUT"]);
});

test("compile errors, forbidden columns, and a rejected binding agree", async (t) => {
  const env = await agree(t, [
    { body: envelope(["SELEC nope"]) },
    { body: envelope(["SELECT tenant_id FROM projects"]) },
    { body: "{\"statements\": [" },
    { body: envelope(["SELECT id FROM projects"], ["DROP TABLE projects"]) },
  ]);
  assert.deepEqual(env.answers, ["POLICYSQL_INVALID_SQL", "POLICYSQL_FORBIDDEN_COLUMN", "POLICYSQL_INVALID_REQUEST", "POLICYSQL_UNSUPPORTED_SQL"]);
  const denied = await agree(t, [{ body: insertProject("p1"), key: KEY }], (setup) => { setup.faults.check = () => false; });
  assert.deepEqual(denied.answers, ["POLICYSQL_DATABASE_BINDING_REJECTED"]);
});

test("a database failure during the lookup, the envelope, the row, or COMMIT agrees", async (t) => {
  for (const [label, fault] of [
    ["lookup", (sql) => sql.startsWith("SELECT fingerprint")],
    ["envelope", (sql) => sql.includes("\"projects\"")],
    ["row", (sql) => sql.startsWith("INSERT INTO policysql_idempotency")],
  ]) {
    const env = await agree(t, [{ body: insertProject("p1"), key: KEY }], (setup) => {
      setup.faults.execute = async (sql) => { if (fault(sql)) throw new Error(`${label} failed`); };
    });
    assert.deepEqual(env.answers, ["POLICYSQL_DATABASE_UNAVAILABLE"], label);
    assert.equal(env.sides.step.calls.filter((call) => call.op === "commit").length, 0, label);
  }
  // COMMIT may have applied: the reply is DATABASE_UNAVAILABLE (never a rejection) on both.
  const env = await agree(t, [{ body: insertProject("p1"), key: KEY }], (setup) => {
    setup.faults.commit = async () => { throw new Error("commit transport"); };
  });
  assert.deepEqual(env.answers, ["POLICYSQL_DATABASE_UNAVAILABLE"]);
  assert.equal(env.sides.step.calls.filter((call) => call.op === "commit").length, 1);
});

test("duplicate rows and a malformed stored record are internal, alike", async (t) => {
  const env = environment(t);
  assertSame(await both(env, { body: insertProject("p1"), key: KEY }), "first");
  env.faults.results = (statements, results) => statements[0].sql.startsWith("SELECT fingerprint") && results[0].rows.length === 1
    ? [{ ...results[0], rows: [results[0].rows[0], results[0].rows[0]] }] : results;
  const duplicate = await both(env, { body: insertProject("p1"), key: KEY });
  assertSame(duplicate, "duplicate rows");
  assert.equal(code(duplicate, "step"), "POLICYSQL_INTERNAL");
  env.faults.results = (statements, results) => statements[0].sql.startsWith("SELECT fingerprint") && results[0].rows.length === 1
    ? [{ ...results[0], rows: [[results[0].rows[0][0], "{\"version\":2}"]] }] : results;
  const malformed = await both(env, { body: insertProject("p1"), key: KEY });
  assertSame(malformed, "malformed record");
  assert.equal(code(malformed, "step"), "POLICYSQL_INTERNAL");
  await assertSameEnd(env, "end");
});

test("the execution trace reaches the sink and a debug caller, alike", async (t) => {
  const debug = ["execute", "debug"];
  const env = await agree(t, [
    { body: selectProjects, access: debug },
    { body: insertProject("p1"), key: KEY, access: debug },
    { body: insertProject("p1"), key: KEY, access: debug },
    { body: insertProject("p2") },
  ], () => {}, { trace: true });
  assert.deepEqual(env.answers, [COMMITTED, COMMITTED, COMMITTED, COMMITTED]);
  // Published before each executed envelope (not for the replay).
  assert.deepEqual(env.traces.step.map((trace) => trace.disposition), ["executed", "executed", "executed"]);
});

test("cost observations agree, also without a catalog and over the usage budget", async (t) => {
  const none = await agree(t, [{ body: selectProjects }, { body: insertProject("p1") }], () => {}, { engineConfig: { environment: "test", publicBaseUrl: config.publicBaseUrl, commitChecks: config.commitChecks } });
  assert.deepEqual(none.logs.step.map((log) => log.code ?? log.event), ["POLICYSQL_COST_UNKNOWN", "POLICYSQL_COST_UNKNOWN"]);
  const budget = await agree(t, [{ body: selectProjects }], () => {}, { engineConfig: { ...config, costCatalog: { ...costCatalog, maxEstimatedRowsRead: 5 } } });
  assert.deepEqual(budget.logs.step.map((log) => log.code ?? log.event), ["POLICYSQL_USAGE_BUDGET_EXCEEDED"]);
});

// ---- the owner placement (commit checks) ------------------------------------------------------

test("an envelope that triggers checks runs them on its owner and commits once, alike", async (t) => {
  const env = await agree(t, [{ body: auditRow("x1"), owner: true }, { body: envelope(["INSERT INTO audited (id, note) VALUES (:id, :note)", { id: "x2", note: "x2" }], ["SELECT id, note FROM audited ORDER BY id"]), owner: true }], (setup) => {
    setup.validator = async ({ hook, query }) => {
      const reply = await query(JSON.stringify({ sequence: 1, sql: "SELECT id, note FROM audited ORDER BY id", params: {} }));
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.equal(reply.value.meta.role, hook.check === "consistency" ? "auditor" : "member");
      return ALLOW();
    };
  });
  assert.deepEqual(env.answers, [COMMITTED, COMMITTED]);
  assert.deepEqual(env.hooks.step.map((hook) => JSON.parse(hook.body).check), ["consistency", "retention", "consistency", "retention"]);
  assert.deepEqual(env.rows("step").audited.map((row) => row.id), ["a0", "x1", "x2"]);
});

test("a keyed owner execution and its retry agree; the retry runs no validator", async (t) => {
  const env = await agree(t, [{ body: auditRow("x1"), key: KEY, owner: true }, { body: auditRow("x1"), key: KEY, owner: true }]);
  assert.deepEqual(env.answers, [COMMITTED, COMMITTED]);
  assert.equal(env.hooks.step.length, 2);
  assert.equal(env.sides.step.calls.filter((call) => call.op === "commit").length, 1);
});

test("a deny, a failed validator, and an unconfigured check roll back before COMMIT, alike", async (t) => {
  for (const validator of [() => Response.json({ version: "1", allowed: false }), () => { throw new TypeError("fetch failed"); }]) {
    const env = await agree(t, [{ body: auditRow("x1"), key: KEY, owner: true }], (setup) => { setup.validator = validator; });
    assert.deepEqual(env.answers, ["POLICYSQL_COMMIT_CHECK_REJECTED"]);
    assert.equal(env.sides.step.calls.filter((call) => call.op === "commit").length, 0);
  }
  const env = await agree(t, [{ body: auditRow("x1"), owner: true }], () => {}, { engineConfig: { environment: "test", costCatalog } });
  assert.deepEqual(env.answers, ["POLICYSQL_COMMIT_CHECK_REJECTED"]);
  assert.equal(env.hooks.step.length, 0);
});

test("a failure on the owner path and a lost terminal record agree", async (t) => {
  const failed = await agree(t, [{ body: auditRow("x1"), owner: true }], (env) => {
    env.faults.execute = async (sql) => { if (sql.includes("\"audited\"") && sql.startsWith("INSERT")) throw new Error("envelope failed"); };
  });
  assert.deepEqual(failed.answers, ["POLICYSQL_INTERNAL"]);
  // The terminal record cannot be stored after COMMIT: the reply is still committed. The retry
  // finds the row (no second envelope); its own record cannot be stored either, so it answers
  // INTERNAL, which the client treats as an unknown outcome.
  const lost = await agree(t, [{ body: auditRow("x1"), key: KEY, owner: true }, { body: auditRow("x1"), key: KEY, owner: true }], (env) => {
    env.faults.put = ({ phase }) => (phase === "committed" ? { fail: true } : undefined);
  });
  assert.deepEqual(lost.answers, [COMMITTED, "POLICYSQL_INTERNAL"]);
  assert.equal(lost.sides.step.calls.filter((call) => call.op === "commit").length, 1);
  // The active record cannot be stored: nothing executes.
  const env = await agree(t, [{ body: auditRow("x1"), owner: true }], (setup) => {
    setup.faults.put = ({ phase }) => (phase === "active" ? { fail: true } : undefined);
  });
  assert.deepEqual(env.answers, ["POLICYSQL_INTERNAL"]);
  assert.equal(env.hooks.step.length, 0);
});

// ---- the allowlisted differences, each asserted for both sides ---------------------------------

test(`allowlist idempotency-conflict-code: ${ALLOWLIST["idempotency-conflict-code"]}`, async (t) => {
  const env = environment(t);
  assertSame(await both(env, { body: auditRow("x1"), key: KEY, owner: true }), "first");
  const seen = await both(env, { body: auditRow("x2"), key: KEY, owner: true });
  assert.equal(code(seen, "step"), "POLICYSQL_IDEMPOTENCY_CONFLICT");
  assert.equal(code(seen, "ts"), "POLICYSQL_TRANSACTION_CONFLICT");
  for (const side of ["ts", "step"]) assert.equal(seen[side].calls.filter((call) => call.op === "commit").length, 0);
  await assertSameEnd(env, "end", true);
});

test(`allowlist duplicate-idempotency-rows: ${ALLOWLIST["duplicate-idempotency-rows"]}`, async (t) => {
  const env = environment(t);
  assertSame(await both(env, { body: auditRow("x1"), key: KEY, owner: true }), "first");
  env.faults.results = (statements, results) => statements[0].sql.startsWith("SELECT fingerprint") && results[0].rows.length === 1
    ? [{ ...results[0], rows: [results[0].rows[0], results[0].rows[0]] }] : results;
  const seen = await both(env, { body: auditRow("x1"), key: KEY, owner: true });
  assert.equal(code(seen, "step"), "POLICYSQL_INTERNAL");
  assert.equal(code(seen, "ts"), "POLICYSQL_TRANSACTION_CONFLICT");
  for (const side of ["ts", "step"]) assert.equal(seen[side].calls.filter((call) => call.op === "commit").length, 0);
});

test(`allowlist stored-record-shape: ${ALLOWLIST["stored-record-shape"]}`, async (t) => {
  const env = environment(t);
  await both(env, { body: insertProject("p1"), key: KEY });
  const [ts] = env.reference.take("rows").idempotency;
  const [step] = env.rows("step").idempotency;
  assert.equal(Object.hasOwn(ts.record, "status") || Object.hasOwn(ts.record, "commitChecks"), false);
  assert.equal(step.record.status, "committed");
  assert.equal(step.record.commitChecks, "not_triggered");
});

test(`allowlist owner-prior-record-of-another-binding: ${ALLOWLIST["owner-prior-record-of-another-binding"]}`, async (t) => {
  const env = environment(t);
  assertSame(await both(env, { body: auditRow("x1"), key: KEY, owner: true }), "first");
  // The same key (its hash has no generation) under another generation of the same database.
  const seen = await both(env, { body: auditRow("x1"), key: KEY, owner: true, binding: { ...bindingOf(env.runtime), generation: "2" } });
  assert.equal(code(seen, "ts"), "POLICYSQL_TRANSACTION_CONFLICT");
  assert.deepEqual(seen.ts.calls, [], "the TypeScript owner answered from its record");
  assert.equal(code(seen, "step"), "POLICYSQL_IDEMPOTENCY_CONFLICT");
  assert.deepEqual(seen.step.calls.map((call) => call.op), ["begin", "execute", "rollback"], "core looked the row up");
  for (const side of ["ts", "step"]) assert.equal(seen[side].hooks.length, 0);
  await assertSameEnd(env, "end", true);
});

test(`allowlist owner-commit-failure-code: ${ALLOWLIST["owner-commit-failure-code"]}`, async (t) => {
  const unavailable = async () => { throw new EngineError("POLICYSQL_DATABASE_UNAVAILABLE", "The database is temporarily unavailable."); };
  // The direct placement still agrees: DATABASE_UNAVAILABLE on both.
  const direct = await agree(t, [{ body: insertProject("p1"), key: KEY }], (setup) => { setup.faults.commit = unavailable; });
  assert.deepEqual(direct.answers, ["POLICYSQL_DATABASE_UNAVAILABLE"]);
  const env = environment(t);
  env.faults.commit = unavailable;
  const seen = await both(env, { body: auditRow("x1"), key: KEY, owner: true });
  assert.equal(code(seen, "ts"), "POLICYSQL_DATABASE_UNAVAILABLE");
  assert.equal(code(seen, "step"), "POLICYSQL_INTERNAL");
  for (const side of ["ts", "step"]) {
    assert.equal(seen[side].calls.filter((call) => call.op === "commit").length, 1, `${side}: COMMIT was sent once`);
    assert.equal(seen[side].hooks.length, 2, `${side}: both checks allowed first`);
  }
  const { REJECTIONS } = await import("../../../packages/client/protocol.js");
  assert.equal([...REJECTIONS.values()].flat().some((value) => ["INTERNAL", "DATABASE_UNAVAILABLE"].includes(value)), false);
});

test(`allowlist direct-binding-revoked-before-commit: ${ALLOWLIST["direct-binding-revoked-before-commit"]}`, async (t) => {
  const env = environment(t);
  // Each side asks the provider three times: before the body, at connect, and before COMMIT
  // (core's own first check is the engine's). The third answer of each side revokes.
  const checks = { ts: 0, step: 0 };
  env.faults.check = () => ++checks[env.currentSide()] % 3 !== 0;
  const seen = await both(env, { body: insertProject("p1"), key: KEY });
  assert.equal(checks.step, 3, "three provider calls");
  assert.equal(seen.ts.result.code, "POLICYSQL_DATABASE_BINDING_REJECTED");
  assert.equal(seen.step.result.code, "POLICYSQL_INTERNAL");
  for (const side of ["ts", "step"]) {
    // Lookup, envelope, and row ran; no COMMIT reached the database, and the connection was
    // rolled back (the TypeScript path's catch rolled back a second time, a no-op).
    const ops = seen[side].calls.map((call) => call.op);
    assert.deepEqual(ops.slice(0, 5), ["begin", "execute", "execute", "execute", "rollback"], side);
    assert.equal(ops.includes("commit"), false, side);
  }
  const { REJECTIONS } = await import("../../../packages/client/protocol.js");
  assert.equal([...REJECTIONS.values()].flat().some((value) => ["INTERNAL", "DATABASE_BINDING_REJECTED"].includes(value)), false);
  const rows = { ts: env.reference.take("rows"), step: env.rows("step") };
  for (const side of ["ts", "step"]) assert.equal(rows[side].projects.some((row) => row.id === "p1"), false, side);
});

// ---- cost_estimate_json against cost.ts (cost.test.mjs) ----------------------------------------

// The cases of the former cost.test.mjs; `cost.ts` `estimateSealedEnvelope`'s answers are recorded.
test("cost_estimate_json evaluates as cost.ts evaluates", async (t) => {
  const recorded = reference.of(t);
  const runtime = makeRuntime();
  t.after(() => runtime.free());
  const validated = validateConfig({ environment: "test", costCatalog: { maxEstimatedRowsRead: 100, maxEstimatedRowsWritten: 100, resources: { 1: { upperRows: 20 } } } }).costCatalog;
  const statement = (operation, resource = 1) => ({ operation, protectedSql: "SELECT 1", costExplainSql: "EXPLAIN QUERY PLAN SELECT 1",
    clientParameters: {}, serverParameters: {}, explain: { resource } });
  const cases = [
    { statements: [statement("select")], rows: [[[0, 0, 0, "SCAN projects"]]], columns: ["id", "parent", "notused", "detail"] },
    { statements: [statement("select")], rows: [[["SCAN outer"], ["CORRELATED SCALAR SUBQUERY"], ["SCAN inner"]]], columns: ["detail"] },
    { statements: [statement("insert"), statement("update")], rows: [[["SEARCH projects USING INDEX unique_projects (id=?)"]]], columns: ["detail"] },
    { statements: [statement("select", 9)], rows: [[["SCAN"]]], columns: ["detail"] },
    { statements: [statement("select")], rows: [[[1]]], columns: ["detail"] },
    { statements: [statement("select", null)], rows: [[["SCAN"]]], columns: ["detail"] },
    { statements: [statement("delete")], rows: [[["SCAN"]]], columns: ["detail"], catalog: { maxEstimatedRowsRead: 100, maxEstimatedRowsWritten: 10, resources: { 1: { upperRows: 20 } } } },
    { statements: [statement("select")], rows: [[["SCAN"]]], columns: ["detail"], catalog: { maxEstimatedRowsRead: 10, maxEstimatedRowsWritten: 100, resources: { 1: { upperRows: 20 } } } },
    { statements: [statement("select")], rows: [[["SCAN"]]], columns: ["detail"], catalog: null },
  ];
  for (const [index, item] of cases.entries()) {
    const catalog = item.catalog === null ? undefined : item.catalog ? validateConfig({ environment: "test", costCatalog: item.catalog }).costCatalog : validated;
    const expected = recorded.take("cost.ts");
    const planned = item.statements.filter((value) => value.operation !== "insert").length;
    const actual = JSON.parse(runtime.cost_estimate_json(JSON.stringify({
      catalog: catalog ?? null,
      statements: item.statements.map((value) => ({ operation: value.operation, explainResource: value.explain.resource })),
      results: catalog === undefined ? [] : item.rows.slice(0, planned).map((rows) => ({ columns: item.columns, rows })),
    })));
    assert.deepEqual(actual, expected, `case ${index}`);
  }
});
