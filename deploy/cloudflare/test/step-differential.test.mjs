// The differential harness of ADR 0024 pull requests 4 and 5: today's `TransactionOwnerCore`
// and the step machine (`StepOwnerCore`, test/helpers/step-owner.mjs, over the real WASM
// `step_json`) run the same owner scenarios side by side, with the same fake clock, the same
// kind of database (one SQLite file each), the same store and timer faults, and the same
// scripted validator. The harness asserts equal replies, database calls (SQL and arguments),
// terminal records, transaction log events, validator calls (the signed hook body, with the
// capability token masked, and a valid signature), callback replies, and final rows, except
// the differences in `ALLOWLIST`, each named with its reason.
//
// It covers the owner-level scenarios of transaction-owner.test.mjs and
// transaction-owner-port.test.mjs, commit checks and callbacks included, plus generated command
// sequences. Pull request 9 deletes it; the transcripts replace it.
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initSync, PolicySqlRuntime } from "../pkg/policysql_wasm.js";
import { TransactionOwnerCore } from "../src/transaction-owner.ts";
import { runtimeLimitsJson } from "../src/limits.ts";
import { StepOwnerCore } from "./helpers/step-owner.mjs";

initSync({ module: readFileSync(new URL("../pkg/policysql_wasm_bg.wasm", import.meta.url)) });

/**
 * The intentional differences (ADR 0024 "Inconsistencies the move must resolve", the failure
 * table, and #70). A scenario that reaches one stops comparing there and asserts what each
 * side does; generated sequences stop at the first one they reach.
 */
export const ALLOWLIST = Object.freeze({
  "replay-before-liveness":
    "ADR 0024 \"Replay identity\": an exact retry of a completed command is answered from `last` before any " +
    "snapshot or liveness check. TransactionOwnerCore checks liveness first: after owner loss it answers " +
    "TRANSACTION_UNAVAILABLE, after the deadline DATABASE_TIMEOUT.",
  "expired-command":
    "ADR 0024 \"Events and host facts\": expiry is checked against now_ms on every client event. " +
    "TransactionOwnerCore checks the binding against the passed deadline first and answers DATABASE_TIMEOUT " +
    "(failed); core answers TRANSACTION_UNAVAILABLE and records expired.",
  "issue-70":
    "#70: core compiles and hashes the verified body text. TransactionOwnerCore recompiles JSON.stringify(command): " +
    "1e400 becomes NULL and 9007199254740993 is rounded (known bug until pull request 7).",
  "persist-failure-before-committing":
    "ADR 0024 failure table, PersistFailed before committing: core rolls back and records failed (from the record " +
    "before the statement, so a retry is unavailable, not replayed) before answering INTERNAL. " +
    "TransactionOwnerCore answers INTERNAL and leaves the transaction open.",
  "unrecorded-commit-retry":
    "ADR 0024 failure table, PersistFailed of the terminal record after Committed: a retry gets " +
    "COMMIT_OUTCOME_UNKNOWN from this owner and a successor alike. TransactionOwnerCore (#48) keeps the terminal " +
    "record in memory and replays committed once the store recovers. Neither is a rejection.",
  "timer-during-statement":
    "ADR 0024 failure table, TimerFired while a statement runs: core rolls back when it returns and answers " +
    "TRANSACTION_UNAVAILABLE. TransactionOwnerCore rolls back concurrently and then records the statement as done.",
  "old-format-record":
    "ADR 0024 \"Old-format records are discarded, not read\": the one-time incompatibility at the switch-over " +
    "(pull request 7). Core discards a TransactionOwnerCore record: commit gets COMMIT_OUTCOME_UNKNOWN, other " +
    "commands TRANSACTION_UNAVAILABLE.",
  "rollback-failure-keeps-phase":
    "ADR 0024 failure table, RollbackFailed: the decided phase stays. TransactionOwnerCore turns it into failed.",
  "expiry-during-validator":
    "ADR 0024 inconsistency 5 and failure table, TimerFired while validating: core answers the waiting commit " +
    "COMMIT_CHECK_REJECTED at expiry, rolls back, records expired, and ignores the late verdict. TransactionOwnerCore " +
    "rolls back at expiry but answers only when the validator returns, and then overwrites expired with failed.",
  "loss-between-checks":
    "ADR 0024 \"Flow\" (pull request 5): core stays validating from the first check to committing and writes " +
    "nothing between checks, so an owner lost during one check calls the next validator before its next write " +
    "(Persist(committing)) fails; no COMMIT is sent and the reply is INTERNAL on both sides. TransactionOwnerCore " +
    "writes active between checks, which fails on the lost owner before the next validator is called.",
});

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
        delete:
          filter: { tenant_id: { eq: { session: tenant_id } } }
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
INSERT INTO projects VALUES ('seed', 'tenant_a', 'seed');
INSERT INTO projects VALUES ('hidden', 'tenant_b', 'hidden');
CREATE TABLE audited (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, note TEXT);
INSERT INTO audited VALUES ('a0', 'tenant_a', 'seed');
INSERT INTO audited VALUES ('b0', 'tenant_b', 'hidden');
`;
const LIMITS = { maxRows: 100, maxResultBytes: 64_000, timeoutMs: 1_000, maxStatements: 8 };
const TX = `tx_${"a".repeat(32)}`;
const T0 = 1_790_000_000_000;
const VALIDATION = `cval_${"a".repeat(32)}`;
const HMAC_SECRET = "0123456789abcdef0123456789abcdef";
const VALIDATOR_URL = "https://validator.example.test/check";
const config = {
  environment: "test",
  costCatalog: { maxEstimatedRowsRead: 1000, maxEstimatedRowsWritten: 1000, resources: { 1: { upperRows: 100 } } },
  publicBaseUrl: "https://gateway.example.test",
  commitChecks: {
    consistency: { url: VALIDATOR_URL, hmacSecret: HMAC_SECRET },
    retention: { url: `${VALIDATOR_URL}/retention`, hmacSecret: HMAC_SECRET },
  },
};
const unconfigured = { environment: "test", costCatalog: config.costCatalog };

const makeRuntime = (policyVersion = "policy_1", limits = {}) =>
  new PolicySqlRuntime(CATALOG, POLICY, "schema_1", policyVersion, runtimeLimitsJson({ ...LIMITS, ...limits }));
const authOf = (runtime, subject = "user_1") => JSON.parse(runtime.authorize_session_json(JSON.stringify({
  principal: "https://issuer.test:user", subject, roles: ["member"], defaultRole: "member",
  access: ["execute"], session: { tenant_id: "tenant_a" },
}), undefined, "execute")).auth;
const bindingOf = (runtime) => ({ version: 1, scope: "tenant", databaseId: "db_a", generation: "1", snapshot: runtime.snapshot });
const identity = (runtime, input) => JSON.parse(runtime.identity_json(JSON.stringify(input)));

const COMPARED_LOGS = new Set([
  "transaction_started", "transaction_usage", "transaction_terminal", "transaction_owner_unavailable",
  "commit_check_unconfigured",
]);

// A database transport over one SQLite file. `faults` is shared by both sides' scenario code;
// every call is recorded for the comparison (cost observation connections excepted).
const sqliteProvider = (path, calls, faults, connections) => ({
  check() { return faults.check ? faults.check() : true; },
  connect(_binding, requestId) {
    const cost = requestId.endsWith("-cost");
    return {
      async begin(mode) {
        if (cost) {
          return { open: true, usage: [], async execute() { return []; }, async commit() { this.open = false; }, async rollback() { this.open = false; } };
        }
        calls.push({ op: "begin", mode });
        const db = new DatabaseSync(path);
        connections.push(db);
        db.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
        const transaction = {
          open: true,
          usage: [],
          async execute(statements) {
            // A rolled-back connection runs nothing more (a Hrana baton is gone).
            if (!transaction.open) throw new Error("transaction closed");
            const results = [];
            for (const { sql, args } of statements) {
              calls.push({ op: "execute", sql, args: Object.fromEntries(Object.entries(args ?? {}).map(([key, value]) =>
                [key, typeof value === "bigint" ? `${value}n` : value])) });
              if (faults.execute) await faults.execute(sql);
              if (!transaction.open) throw new Error("transaction closed");
              const statement = db.prepare(sql);
              statement.setReturnArrays(true);
              const rows = statement.all(args ?? {});
              const changes = /^\s*(INSERT|UPDATE|DELETE)\b/iu.test(sql) ? db.prepare("SELECT changes() AS n").get().n : 0;
              const usage = { rowsRead: rows.length, rowsWritten: changes, queryDurationMs: 1 };
              transaction.usage.push(usage);
              results.push({ columns: statement.columns().map((column) => column.name), rows, rowsAffected: changes, usage });
            }
            return results;
          },
          async commit() {
            calls.push({ op: "commit" });
            if (faults.commit) await faults.commit();
            db.exec("COMMIT");
            transaction.open = false;
            if (faults.afterCommit) await faults.afterCommit();
          },
          async rollback() {
            calls.push({ op: "rollback" });
            if (faults.rollback) await faults.rollback();
            if (transaction.open) db.exec("ROLLBACK");
            transaction.open = false;
          },
        };
        return transaction;
      },
    };
  },
});

class OwnerLostError extends Error {}

// One owner name on one side: a store, a timer, owner loss, and put faults (ADR 0022).
const ownerSlot = (makeCore, faults, phaseOf) => {
  const data = new Map();
  let timerAt = null;
  let life = { live: true };
  const facilities = (current) => {
    const alive = () => { if (!current.live) throw new OwnerLostError("owner lost"); };
    return {
      store: {
        async get(key) { alive(); return structuredClone(data.get(key)); },
        async put(key, value) {
          alive();
          const fault = faults.put?.({ phase: phaseOf(value) }) ?? {};
          if (fault.fail) throw new Error("store put failed");
          data.set(key, structuredClone(value));
          if (fault.lose) slot.lose();
        },
      },
      timer: { async schedule(atMs) { alive(); timerAt = atMs; } },
      background: { run() {} },
    };
  };
  const slot = {
    core: makeCore(facilities(life)),
    lose() {
      life.live = false;
      life = { live: true };
      slot.core = makeCore(facilities(life));
    },
    record: () => data.get("transaction"),
    setRecord(value) { data.set("transaction", value); },
    async fireTimer(now) {
      if (timerAt === null || now < timerAt) return false;
      timerAt = null;
      await slot.core.onTimer();
      return true;
    },
  };
  return slot;
};

const tsPhase = (record) => !record ? undefined
  : record.status === "committing" || (record.status === "failed" && record.commitSent) ? "commit_unknown" : record.status;
const stepPhase = (text) => {
  if (typeof text !== "string") return undefined;
  const phase = JSON.parse(text).phase;
  return phase === "committing" ? "commit_unknown" : phase;
};
const normalizedRecord = (side, value) => {
  if (value === undefined) return undefined;
  if (side === "ts") return { phase: tsPhase(value), nextSequence: value.nextSequence, last: value.last?.response ?? null };
  const record = JSON.parse(value);
  return { phase: stepPhase(value), nextSequence: record.nextSequence, last: record.last?.response ?? null };
};
const normalizedReply = (reply) => reply.ok ? { ok: true, value: reply.value }
  : { ok: false, code: reply.error.code, message: reply.error.message, path: reply.error.path };

const ALLOW = () => Response.json({ version: "1", allowed: true });

/** Whether `signature` is the hook's `v1=` HMAC-SHA-256 of `timestamp.body` (ADR 0007). */
const signedBy = (secret, timestamp, body, signature) =>
  signature === `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

/** A callback query on one side: the TypeScript owner takes the parsed command, the step
 * machine the verified text (#70). Request ids count per side, so both sides see the same. */
const callbackOn = async (env, side, token, text) => {
  const { slot } = env.sides[side];
  const requestId = `cb-${++env.callbackCount[side]}`;
  const reply = side === "ts"
    ? await slot.core.callbackQuery({ capability: token, command: JSON.parse(text) }, requestId)
    : await slot.core.callbackQuery({ validationId: VALIDATION, capability: token, bodyText: text }, requestId);
  const normalized = normalizedReply(reply);
  env.callbacks[side].push(normalized);
  return normalized;
};

/** The validator endpoint of one side: records the call and runs `env.validator`. */
const hookFetch = (env, side) => async (url, init) => {
  const body = init.body;
  const hook = JSON.parse(body);
  const headers = new Headers(init.headers);
  env.tokens[side].push(hook.query.token);
  env.hooks[side].push({
    url: String(url),
    redirect: init.redirect,
    body: body.replaceAll(hook.query.token, "<token>"),
    tokenShape: /^[A-Za-z0-9_-]{43}$/u.test(hook.query.token),
    signed: signedBy(HMAC_SECRET, headers.get("policysql-hook-timestamp"), body, headers.get("policysql-hook-signature")),
  });
  try {
    return await env.validator({
      side, hook, query: (text, token = hook.query.token) => callbackOn(env, side, token, text),
    });
  } catch (error) {
    // A failed assertion of the scenario's validator script fails the test; any other error
    // is the scripted transport failure.
    if (error instanceof assert.AssertionError) env.validatorErrors.push(error);
    throw error;
  }
};

/** Both sides of one owner, with a fake clock. */
const environment = (t, { ownerConfig = config, limits = {} } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "policysql-step-diff-"));
  const runtimes = { current: makeRuntime("policy_1", limits) };
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
  const sides = {};
  const env = {
    runtimes, clock, faults, sides, logs,
    hooks: { ts: [], step: [] },
    tokens: { ts: [], step: [] },
    callbacks: { ts: [], step: [] },
    callbackCount: { ts: 0, step: 0 },
    validator: ALLOW,
    validatorErrors: [],
  };
  for (const side of ["ts", "step"]) {
    const path = join(directory, `${side}.sqlite`);
    const db = new DatabaseSync(path);
    db.exec(SCHEMA);
    db.close();
    const calls = [];
    const database = sqliteProvider(path, calls, faults, connections);
    const getRuntime = () => runtimes.current;
    const fetchImpl = hookFetch(env, side);
    const makeCore = side === "ts"
      ? (facilities) => new TransactionOwnerCore(facilities, { getRuntime, database, config: ownerConfig, fetchImpl })
      : (facilities) => new StepOwnerCore(facilities, { getRuntime, database, config: ownerConfig, fetchImpl }, TX);
    sides[side] = { path, calls, slot: ownerSlot(makeCore, faults, side === "ts" ? tsPhase : stepPhase) };
  }
  t.after(() => {
    assert.deepEqual(env.validatorErrors, [], "the validator scripts' assertions hold");
    for (const db of connections) { try { db.close(); } catch { /* closed */ } }
    rmSync(directory, { recursive: true, force: true });
    runtimes.current.free();
  });
  let request = 0;
  Object.assign(env, {
    caller: { subject: "user_1" },
    setSide(side) { current = side; },
    rows(side) {
      const db = new DatabaseSync(sides[side].path, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 0");
      try {
        return {
          projects: db.prepare("SELECT * FROM projects ORDER BY id").all().map((row) => ({ ...row })),
          counters: db.prepare("SELECT id, tenant_id, CAST(big AS TEXT) AS big, typeof(big) AS big_type, ratio FROM counters ORDER BY id").all().map((row) => ({ ...row })),
          audited: db.prepare("SELECT * FROM audited ORDER BY id").all().map((row) => ({ ...row })),
        };
      } finally { db.close(); }
    },
    nextRequest: () => `req-${++request}`,
  });
  return env;
};

// One operation on one side. Commands carry the session and the verified text for the step
// side; the TypeScript side gets the parsed value as the engine forwards it today.
const perform = async (env, side, op, requestId) => {
  const { slot } = env.sides[side];
  // The step side answers as soon as the machine replies (a commit rejected by a failed
  // callback, before its validator returns); the comparison waits until both lanes have run
  // every effect, as TransactionOwnerCore does before it replies. This owner, even if lost.
  const core = slot.core;
  const settle = async (reply) => {
    if (op.settle !== false) await core.settled?.();
    return reply;
  };
  const runtime = env.runtimes.current;
  const auth = authOf(runtime, op.subject ?? env.caller.subject);
  const databaseBinding = bindingOf(runtime);
  const snapshot = runtime.snapshot;
  const authFingerprint = identity(runtime, { op: "auth", auth, binding: databaseBinding }).fingerprint;
  switch (op.op) {
    case "begin": {
      const startFingerprint = op.startFingerprint ??
        identity(runtime, { op: "start", transactionId: TX, body: JSON.stringify({ mode: op.mode }) }).digest;
      return await settle(await core.begin({ transactionId: TX, authFingerprint, startFingerprint, mode: op.mode, auth, databaseBinding, snapshot }, requestId));
    }
    case "statement": case "commit": case "rollback": {
      const text = op.text ?? (op.op === "statement"
        ? JSON.stringify({ sequence: op.seq, sql: op.sql, params: op.params ?? {} })
        : JSON.stringify({ sequence: op.seq }));
      const command = JSON.parse(text);
      return await settle(await core.command(op.op, side === "ts"
        ? { transactionId: TX, authFingerprint, command, databaseBinding, snapshot }
        : { transactionId: TX, auth, bodyText: text, databaseBinding, snapshot }, requestId));
    }
    case "timer":
      await slot.fireTimer(env.clock.now);
      return null;
    case "callback":
      // A callback query outside any validator call (with a token the validator kept).
      return await callbackOn(env, side, op.token ?? env.tokens[side].at(-1) ?? "A".repeat(43), op.text);
    case "lose":
      slot.lose();
      return null;
    default:
      throw new Error(`unknown op ${op.op}`);
  }
};

/** Runs `op` on both sides and returns what each saw. */
const both = async (env, op) => {
  if (op.op === "advance") {
    env.clock.now += op.ms;
    return null;
  }
  const requestId = env.nextRequest();
  const seen = {};
  // Both sides start the operation at the same time; a fault that moves the clock moves it
  // for that side only.
  const start = env.clock.now;
  const ends = {};
  for (const side of ["ts", "step"]) {
    env.clock.now = start;
    env.callbackCount[side] = 0;
    const calls = env.sides[side].calls.length;
    const logs = env.logs[side].length;
    const hooks = env.hooks[side].length;
    const callbacks = env.callbacks[side].length;
    env.setSide(side);
    const reply = await perform(env, side, op, requestId);
    seen[side] = {
      reply: reply && (op.op === "callback" ? reply : normalizedReply(reply)),
      calls: env.sides[side].calls.slice(calls),
      logs: env.logs[side].slice(logs),
      hooks: env.hooks[side].slice(hooks),
      callbacks: env.callbacks[side].slice(callbacks),
    };
    ends[side] = env.clock.now;
  }
  env.clock.now = Math.max(ends.ts, ends.step);
  return seen;
};

const assertSame = (seen, label) => {
  if (!seen) return;
  assert.deepEqual(seen.step.reply, seen.ts.reply, `${label}: reply`);
  assert.deepEqual(seen.step.calls, seen.ts.calls, `${label}: database calls`);
  assert.deepEqual(seen.step.logs, seen.ts.logs, `${label}: log events`);
  assert.deepEqual(seen.step.hooks, seen.ts.hooks, `${label}: validator calls`);
  assert.deepEqual(seen.step.callbacks, seen.ts.callbacks, `${label}: callback replies`);
  for (const hook of seen.step.hooks) {
    assert.equal(hook.signed, true, `${label}: the hook body is signed (HMAC inputs unchanged)`);
    assert.equal(hook.tokenShape, true, `${label}: the capability is 32 random bytes, base64url`);
  }
};

const assertSameEnd = (env, label) => {
  assert.deepEqual(normalizedRecord("step", env.sides.step.slot.record()), normalizedRecord("ts", env.sides.ts.slot.record()), `${label}: record`);
  assert.deepEqual(env.rows("step"), env.rows("ts"), `${label}: rows`);
  assert.deepEqual(env.sides.step.slot.core.unrouted ?? [], [], `${label}: every reply routed`);
};

/** Runs ops that must agree completely. */
const agree = async (t, ops, prepare = () => {}, options = {}) => {
  const env = environment(t, options);
  prepare(env);
  for (const [index, op] of ops.entries()) assertSame(await both(env, op), `${op.op}#${index}`);
  assertSameEnd(env, "end");
  return env;
};

const write = { op: "begin", mode: "write" };
const read = { op: "begin", mode: "read" };
const insert = (seq, id, name = id) => ({ op: "statement", seq, sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name } });
const select = (seq) => ({ op: "statement", seq, sql: "SELECT id, name FROM projects ORDER BY id" });
const audit = (seq, id, note = id) => ({ op: "statement", seq, sql: "INSERT INTO audited (id, note) VALUES (:id, :note)", params: { id, note } });
const query = (seq, sql = "SELECT id, note FROM audited ORDER BY id") => JSON.stringify({ sequence: seq, sql, params: {} });
const commit = (seq) => ({ op: "commit", seq });
const rollback = (seq) => ({ op: "rollback", seq });
const code = (seen, side) => seen[side].reply?.code ?? seen[side].reply?.value?.status;

// ---- scenarios that agree ------------------------------------------------------------------

test("a statement, its exact retry, commit, and the commit's retry agree", async (t) => {
  await agree(t, [write, insert(1, "p1"), insert(1, "p1"), select(2), commit(3), commit(3), insert(4, "late")]);
});

test("a sequence gap and a changed payload conflict and roll back alike", async (t) => {
  await agree(t, [write, insert(3, "gap")]);
  await agree(t, [write, insert(1, "p1"), insert(1, "p2"), commit(2)]);
});

test("owner loss fails the transaction closed alike", async (t) => {
  await agree(t, [write, insert(1, "p1"), { op: "lose" }, insert(2, "p2"), commit(2), write]);
  await agree(t, [write, { op: "lose" }, write, commit(1)]);
});

test("timer expiry rolls back alike, and later commands are unavailable", async (t) => {
  await agree(t, [write, insert(1, "p1"), { op: "advance", ms: 4_000 }, { op: "timer" }, insert(2, "p2"), commit(2), insert(1, "p1"), read]);
  await agree(t, [read, { op: "lose" }, { op: "advance", ms: 4_000 }, { op: "timer" }, commit(1)]);
});

test("rollback, its retry, and a commit after it agree", async (t) => {
  await agree(t, [write, insert(1, "p1"), rollback(2), rollback(2), commit(3), commit(2)]);
});

test("read mode, compile errors, and the statement limit agree", async (t) => {
  await agree(t, [read, insert(1, "p1")]);
  await agree(t, [write, { op: "statement", seq: 1, sql: "SELECT tenant_id FROM projects" }, commit(2)]);
  await agree(t, [write, { op: "statement", seq: 1, sql: "SELEC nope" }]);
  await agree(t, [read, ...Array.from({ length: 9 }, (_, index) => select(index + 1)), commit(10)]);
});

test("begin retries and another caller agree", async (t) => {
  await agree(t, [write, write, { ...write, startFingerprint: "d".repeat(64) }, insert(1, "p1"), { ...commit(2), subject: "intruder" }, commit(2)]);
});

test("owner loss after COMMIT, before its record (window A), is unknown alike", async (t) => {
  await agree(t, [write, insert(1, "p1"), commit(2), commit(2), rollback(2), { op: "advance", ms: 5_000 }, { op: "timer" }, commit(2)], (env) => {
    let lost = false;
    env.faults.afterCommit = async () => {
      if (lost) return;
      lost = true;
      // Whichever side is committing loses its owner right after COMMIT applied.
      const side = env.sides.ts.calls.at(-1)?.op === "commit" && !env.sidesCommitted?.ts ? "ts" : "step";
      env.sidesCommitted = { ...env.sidesCommitted, [side]: true };
      env.sides[side].slot.lose();
      lost = side === "ts" ? false : true;
    };
  });
});

test("owner loss between the committed record and its reply (window B) replays alike", async (t) => {
  await agree(t, [write, insert(1, "p1"), commit(2), commit(2)], (env) => {
    const done = new Set();
    env.faults.put = ({ phase }) => {
      if (phase !== "committed" || done.size === 2) return undefined;
      const side = done.has("ts") ? "step" : "ts";
      done.add(side);
      return { lose: true };
    };
  });
});

test("a COMMIT transport error is unknown alike, also when the record cannot be stored", async (t) => {
  for (const failRecord of [false, true]) {
    await agree(t, [write, insert(1, "p1"), commit(2), commit(2), { op: "lose" }, commit(2)], (env) => {
      env.faults.commit = async () => { throw new Error("transport"); };
      if (failRecord) env.faults.put = ({ phase }) => (phase === "commit_unknown" || phase === "failed" ? { fail: true } : undefined);
    });
  }
});

test("the timer firing while COMMIT is in flight does not end it, alike (inconsistency 6, fixed by #48)", async (t) => {
  let env;
  env = await agree(t, [write, insert(1, "p1"), commit(2), commit(2)], (setup) => {
    setup.faults.commit = async () => {
      setup.clock.now += 10_000;
      const side = setup.sides.ts.calls.at(-1)?.op === "commit" && !setup.fired?.ts ? "ts" : "step";
      setup.fired = { ...setup.fired, [side]: true };
      await setup.sides[side].slot.fireTimer(setup.clock.now);
    };
  });
  assert.equal(normalizedRecord("step", env.sides.step.slot.record()).phase, "committed");
});

test("a deadline that passes once committing is stored sends no COMMIT, alike", async (t) => {
  const env = await agree(t, [write, insert(1, "p1"), commit(2), commit(2)], (setup) => {
    setup.faults.put = ({ phase }) => {
      if (phase === "commit_unknown") setup.clock.now = T0 + 4_000;
      return undefined;
    };
  });
  assert.equal(env.sides.step.calls.filter((call) => call.op === "commit").length, 0);
});

test("a failed put of committing sends no COMMIT and stays a definite rejection, alike", async (t) => {
  await agree(t, [write, insert(1, "p1"), commit(2), commit(2)], (env) => {
    env.faults.put = ({ phase }) => (phase === "commit_unknown" ? { fail: true } : undefined);
  });
});

test("a deployment between a commit and its retry keeps the commit answer, alike", async (t) => {
  const env = environment(t);
  for (const op of [write, insert(1, "p1"), commit(2)]) assertSame(await both(env, op), op.op);
  const previous = env.runtimes.current;
  env.runtimes.current = makeRuntime("policy_2");
  t.after(() => previous.free());
  for (const side of ["ts", "step"]) env.sides[side].slot.lose();
  assertSame(await both(env, commit(2)), "commit retry after the deployment");
  assertSame(await both(env, insert(3, "p3")), "a statement after the deployment");
});

// ---- commit checks and callbacks (pull request 5) ----------------------------------------------

test("an allowed commit check with callback queries and their exact retry agrees", async (t) => {
  const env = await agree(t, [write, audit(1, "x1"), insert(2, "p1"), commit(3), commit(3)], (setup) => {
    setup.validator = async ({ hook, query: run }) => {
      const first = await run(query(1));
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.deepEqual(await run(query(1)), first, "an exact retry replays");
      // The validator sees the uncommitted row, under the check's role (the commit's role
      // for a check without one).
      assert.deepEqual(first.value.rows.map((row) => row.id), ["a0", "x1"]);
      assert.equal(first.value.meta.role, hook.check === "consistency" ? "auditor" : "member");
      const second = await run(query(2, "SELECT id FROM audited WHERE note = 'x1'"));
      assert.equal(second.ok, true, JSON.stringify(second));
      return ALLOW();
    };
  });
  // Checks run by ascending id, each with its own capability.
  assert.deepEqual(env.hooks.step.map((hook) => JSON.parse(hook.body).check), ["consistency", "retention"]);
  assert.equal(new Set(env.tokens.step).size, 2);
  // Every changed statement is listed, not only those of the check's resources (as today).
  assert.deepEqual(JSON.parse(env.hooks.step[0].body).statements, [
    { index: 0, type: "insert", resource: "audited" }, { index: 1, type: "insert", resource: "projects" },
  ]);
  assert.deepEqual(env.rows("step").audited.map((row) => row.id), ["a0", "b0", "x1"]);
});

test("a commit that changes no audited row triggers nothing, alike", async (t) => {
  const env = await agree(t, [write, insert(1, "p1"), commit(2)]);
  assert.equal(env.hooks.step.length + env.hooks.ts.length, 0);
});

test("a deny, a malformed decision, a non-2xx status, and a failed call reject before COMMIT, alike", async (t) => {
  const validators = {
    deny: () => Response.json({ version: "1", allowed: false }),
    "error code": () => Response.json({ version: "1", allowed: false, error: { code: "invariant" } }),
    version: () => Response.json({ version: "2", allowed: true }),
    "extra key": () => Response.json({ version: "1", allowed: true, more: 1 }),
    "error shape": () => Response.json({ version: "1", allowed: true, error: { code: 1 } }),
    "not JSON": () => new Response("allowed", { status: 200 }),
    "status 500": () => Response.json({ version: "1", allowed: true }, { status: 500 }),
    transport: () => { throw new TypeError("fetch failed"); },
    timeout: () => { throw new DOMException("The operation timed out.", "TimeoutError"); },
  };
  for (const [label, validator] of Object.entries(validators)) {
    const env = await agree(t, [write, audit(1, "x1"), commit(2), commit(2), audit(3, "x2")], (setup) => {
      setup.validator = validator;
    });
    assert.equal(env.sides.step.calls.filter((call) => call.op === "commit").length, 0, label);
    assert.deepEqual(env.rows("step").audited.map((row) => row.id), ["a0", "b0"], label);
  }
});

test("an unconfigured check rejects before any capability or validator call, alike", async (t) => {
  const env = await agree(t, [write, audit(1, "x1"), commit(2)], () => {}, { ownerConfig: unconfigured });
  assert.equal(env.hooks.step.length + env.hooks.ts.length, 0);
});

test("callback limits end the transaction alike", async (t) => {
  // Rows: the second query exceeds a limit of one row per check.
  await agree(t, [write, audit(1, "x1"), commit(2)], (setup) => {
    setup.validator = async ({ query: run }) => {
      await run(query(1, "SELECT id, note FROM audited WHERE id = 'a0'"));
      await run(query(2, "SELECT id, note FROM audited WHERE id = 'a0'"));
      return ALLOW();
    };
  }, { limits: { maxCallbackRows: 1 } });
  // Sequences: no more callback queries than statements per transaction.
  await agree(t, [write, audit(1, "x1"), commit(2)], (setup) => {
    setup.validator = async ({ query: run }) => {
      for (let sequence = 1; sequence <= 3; sequence++) await run(query(sequence));
      return ALLOW();
    };
  }, { limits: { maxTransactionStatements: 2 } });
  // Bytes: callback replies count against the transaction result-byte limit.
  await agree(t, [write, audit(1, "x1"), commit(2)], (setup) => {
    setup.validator = async ({ query: run }) => {
      await run(query(1));
      return ALLOW();
    };
  }, { limits: { maxTransactionResultBytes: 400 } });
});

test("a callback that is out of sequence, not a single read, or malformed ends the transaction, alike", async (t) => {
  const texts = {
    gap: query(2),
    mutation: query(1, "DELETE FROM audited"),
    "compile error": query(1, "SELEC nope"),
    "extra key": JSON.stringify({ sequence: 1, sql: "SELECT id FROM audited", params: {}, expect: {} }),
    "sequence zero": query(0),
  };
  for (const [label, text] of Object.entries(texts)) {
    await agree(t, [write, audit(1, "x1"), commit(2), commit(2)], (setup) => {
      setup.validator = async ({ query: run }) => {
        const reply = await run(text);
        assert.equal(reply.ok, false, `${label}: ${JSON.stringify(reply)}`);
        // Nothing runs after a failed callback: the transaction is gone.
        await run(query(1));
        return ALLOW();
      };
    });
  }
});

test("a tampered or revoked capability gets nothing, alike", async (t) => {
  // Tampered: a token of the right shape that the owner never issued ends the transaction.
  await agree(t, [write, audit(1, "x1"), commit(2)], (setup) => {
    setup.validator = async ({ query: run, hook }) => {
      const flipped = `${hook.query.token[0] === "A" ? "B" : "A"}${hook.query.token.slice(1)}`;
      await run(query(1), flipped);
      await run(query(1));
      return ALLOW();
    };
  });
  // Revoked: the validator keeps its token and calls back after its verdict.
  const env = await agree(t, [write, audit(1, "x1"), commit(2), { op: "callback", text: query(1) }]);
  assert.equal(env.callbacks.step.at(-1).code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  assert.equal(normalizedRecord("step", env.sides.step.slot.record()).phase, "committed");
});

test("owner loss while a commit waits on its last validator never commits, alike", async (t) => {
  await agree(t, [write, audit(1, "x1"), commit(2), commit(2), { op: "advance", ms: 4_000 }, { op: "timer" }, commit(2)], (setup) => {
    setup.validator = async ({ side, hook, query: run }) => {
      if (hook.check !== "retention") return ALLOW();
      setup.sides[side].slot.lose();
      // The callback reaches the successor, which holds no capability.
      await run(query(1));
      return ALLOW();
    };
  });
});

test("each side issues its own random capability and the hook bodies agree otherwise", async (t) => {
  // The bodies are compared with the token masked; the tokens themselves are random.
  const env = await agree(t, [write, audit(1, "x1"), commit(2)], (setup) => {
    setup.validator = async ({ query: run }) => {
      await run(query(1));
      return ALLOW();
    };
  });
  assert.notEqual(env.tokens.step[0], env.tokens.ts[0], "each side issued its own random capability");
});

// ---- the allowlisted differences, each asserted for both sides ---------------------------------

test(`allowlist expiry-during-validator: ${ALLOWLIST["expiry-during-validator"]}`, async (t) => {
  const env = environment(t);
  for (const op of [write, audit(1, "x1")]) assertSame(await both(env, op), op.op);
  const release = {};
  const gates = { ts: new Promise((resolve) => { release.ts = resolve; }), step: new Promise((resolve) => { release.step = resolve; }) };
  const called = {};
  const calledGates = { ts: new Promise((resolve) => { called.ts = resolve; }), step: new Promise((resolve) => { called.step = resolve; }) };
  env.validator = async ({ side }) => {
    called[side]();
    await gates[side];
    return ALLOW();
  };
  const replies = {};
  for (const side of ["ts", "step"]) {
    env.setSide(side);
    const commitReply = perform(env, side, { ...commit(2), settle: false }, env.nextRequest()).then((reply) => { replies[side] = reply; });
    await calledGates[side];
    env.clock.now = T0 + 4_000;
    await env.sides[side].slot.fireTimer(env.clock.now);
    // Let the machine's reply arrive, if it is sent at expiry.
    await new Promise((resolve) => setImmediate(resolve));
    if (side === "step") assert.equal(replies.step?.error.code, "POLICYSQL_COMMIT_CHECK_REJECTED", "core answers at expiry");
    else assert.equal(replies.ts, undefined, "TS waits for the validator");
    release[side]();
    await commitReply;
    await env.sides[side].slot.core.settled?.();
    env.clock.now = T0;
  }
  assert.equal(replies.ts.error.code, "POLICYSQL_COMMIT_CHECK_REJECTED");
  assert.equal(replies.step.error.code, "POLICYSQL_COMMIT_CHECK_REJECTED");
  assert.equal(normalizedRecord("ts", env.sides.ts.slot.record()).phase, "failed");
  assert.equal(normalizedRecord("step", env.sides.step.slot.record()).phase, "expired");
  for (const side of ["ts", "step"]) {
    assert.equal(env.sides[side].calls.filter((call) => call.op === "commit").length, 0, `${side}: no COMMIT`);
  }
  assert.deepEqual(env.rows("step"), env.rows("ts"));
  assert.deepEqual(env.sides.step.slot.core.unrouted, [], "the late verdict answered nobody");
});

test(`allowlist loss-between-checks: ${ALLOWLIST["loss-between-checks"]}`, async (t) => {
  const env = environment(t);
  for (const op of [write, audit(1, "x1")]) assertSame(await both(env, op), op.op);
  env.validator = async ({ side, hook }) => {
    if (hook.check === "consistency") env.sides[side].slot.lose();
    return ALLOW();
  };
  const lost = await both(env, commit(2));
  assert.equal(lost.ts.reply.code, "POLICYSQL_INTERNAL");
  assert.equal(lost.step.reply.code, "POLICYSQL_INTERNAL");
  assert.deepEqual(lost.ts.hooks.map((hook) => JSON.parse(hook.body).check), ["consistency"]);
  assert.deepEqual(lost.step.hooks.map((hook) => JSON.parse(hook.body).check), ["consistency", "retention"]);
  for (const side of ["ts", "step"]) {
    assert.equal(env.sides[side].calls.filter((call) => call.op === "commit").length, 0, `${side}: no COMMIT`);
  }
  // The successor answers alike, and the timer expires the record alike.
  assertSame(await both(env, commit(2)), "commit retry on the successor");
  await both(env, { op: "advance", ms: 4_000 });
  assertSame(await both(env, { op: "timer" }), "timer");
  assertSameEnd(env, "end");
});

// Formerly the `callback-without-validation` allowlist entry (#73): a callback that reaches an
// owner with no live capability (before any check, or with any token) changes nothing on either
// side, and the transaction goes on to its next statement and commit.
test("a callback with no validation running changes nothing, alike (#73)", async (t) => {
  const stray = (token) => ({ op: "callback", token, text: query(1) });
  const env = await agree(t, [
    write, audit(1, "x1"), stray("A".repeat(43)), stray("malformed"), stray(""), select(2), commit(3),
  ]);
  const strays = env.callbacks.step.slice(0, 3);
  assert.deepEqual(strays.map((reply) => reply.code), Array(3).fill("POLICYSQL_TRANSACTION_UNAVAILABLE"));
  assert.equal(normalizedRecord("step", env.sides.step.slot.record()).phase, "committed");
});

test(`allowlist issue-70: ${ALLOWLIST["issue-70"]}`, async (t) => {
  const env = environment(t);
  assertSame(await both(env, write), "begin");
  const overflow = await both(env, {
    op: "statement", seq: 1, text: '{"sequence":1,"sql":"INSERT INTO counters (id, ratio) VALUES (:id, :value)","params":{"id":"inf","value":1e400}}',
  });
  assert.equal(overflow.ts.reply.ok, true, "TS: JSON.stringify turned 1e400 into null");
  assert.deepEqual(overflow.ts.calls[0].args.value, null);
  assert.equal(overflow.step.reply.code, "POLICYSQL_INVALID_REQUEST", "core rejects the overflow from the text");
  assert.equal(overflow.step.calls.filter((call) => call.op === "execute").length, 0, "nothing executes");

  const overflowCommit = await both(env, commit(2));
  assert.equal(overflowCommit.ts.reply.value.status, "committed");
  assert.equal(overflowCommit.step.reply.code, "POLICYSQL_TRANSACTION_UNAVAILABLE", "the compile error closed it");
  assert.deepEqual(env.rows("ts").counters.map((row) => [row.id, row.ratio]), [["inf", null]], "TS wrote NULL");
  assert.deepEqual(env.rows("step").counters, [], "core wrote nothing");

  const big = '{"sequence":1,"sql":"INSERT INTO counters (id, big) VALUES (:id, :value)","params":{"id":"big","value":9007199254740993}}';
  const exact = environment(t);
  assertSame(await both(exact, write), "begin");
  const inserted = await both(exact, { op: "statement", seq: 1, text: big });
  assert.equal(inserted.step.reply.ok, true, JSON.stringify(inserted.step.reply));
  assert.equal(inserted.step.calls.find((call) => call.op === "execute").args.value, "9007199254740993n", "core keeps the digits");
  assert.equal(inserted.ts.calls.find((call) => call.op === "execute").args.value, 9007199254740992, "TS rounds");
  assertSame(await both(exact, commit(2)), "commit");
  assert.equal(exact.rows("step").counters[0].big, "9007199254740993");
  assert.equal(exact.rows("ts").counters[0].big, "9007199254740992", "TS wrote the rounded value");

  // The rounded spelling is another command for core, and an exact retry for TS.
  const retried = environment(t);
  assertSame(await both(retried, write), "begin");
  await both(retried, { op: "statement", seq: 1, text: big });
  const rounded = await both(retried, { op: "statement", seq: 1, text: big.replace("993", "992") });
  assert.equal(rounded.ts.reply.ok, true, "TS replays the rounded retry");
  assert.equal(rounded.step.reply.code, "POLICYSQL_TRANSACTION_CONFLICT");
});

test(`allowlist replay-before-liveness: ${ALLOWLIST["replay-before-liveness"]}`, async (t) => {
  for (const [label, interrupt] of [["owner loss", { op: "lose" }], ["expiry", { op: "advance", ms: 4_000 }]]) {
    const env = environment(t);
    for (const op of [write, insert(1, "p1")]) assertSame(await both(env, op), op.op);
    await both(env, interrupt);
    const retry = await both(env, insert(1, "p1"));
    assert.equal(retry.step.reply.ok, true, `${label}: core replays`);
    assert.equal(retry.ts.reply.code, label === "expiry" ? "POLICYSQL_DATABASE_TIMEOUT" : "POLICYSQL_TRANSACTION_UNAVAILABLE");
    const next = await both(env, commit(2));
    assert.equal(next.step.reply.code, "POLICYSQL_TRANSACTION_UNAVAILABLE", `${label}: nothing more runs`);
  }
});

test(`allowlist expired-command: ${ALLOWLIST["expired-command"]}`, async (t) => {
  const env = environment(t);
  for (const op of [write, insert(1, "p1")]) assertSame(await both(env, op), op.op);
  await both(env, { op: "advance", ms: 4_000 });
  const late = await both(env, commit(2));
  assert.equal(late.ts.reply.code, "POLICYSQL_DATABASE_TIMEOUT");
  assert.equal(late.step.reply.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  assert.equal(normalizedRecord("ts", env.sides.ts.slot.record()).phase, "failed");
  assert.equal(normalizedRecord("step", env.sides.step.slot.record()).phase, "expired");
  assert.deepEqual(env.rows("step"), env.rows("ts"));
});

test(`allowlist unrecorded-commit-retry: ${ALLOWLIST["unrecorded-commit-retry"]}`, async (t) => {
  const env = environment(t);
  let failing = true;
  env.faults.put = ({ phase }) => (failing && phase === "committed" ? { fail: true } : undefined);
  for (const op of [write, insert(1, "p1")]) assertSame(await both(env, op), op.op);
  const first = await both(env, commit(2));
  assert.equal(first.ts.reply.value.status, "committed");
  assert.deepEqual(first.step.reply, first.ts.reply, "COMMIT applied: both say committed");
  const stuck = await both(env, commit(2));
  assert.equal(stuck.ts.reply.code, "POLICYSQL_COMMIT_OUTCOME_UNKNOWN");
  assert.equal(stuck.step.reply.code, "POLICYSQL_COMMIT_OUTCOME_UNKNOWN");
  failing = false;
  const recovered = await both(env, commit(2));
  assert.equal(recovered.ts.reply.value.status, "committed", "TS re-records its in-memory terminal record");
  assert.equal(recovered.step.reply.code, "POLICYSQL_COMMIT_OUTCOME_UNKNOWN", "core answers as a successor would");
  assert.deepEqual(env.rows("step"), env.rows("ts"), "committed once on both");
});

test(`allowlist persist-failure-before-committing: ${ALLOWLIST["persist-failure-before-committing"]}`, async (t) => {
  const env = environment(t);
  let fail = false;
  env.faults.put = ({ phase }) => (fail && phase === "active" ? { fail: true } : undefined);
  assertSame(await both(env, write), "begin");
  fail = true;
  const failed = await both(env, insert(1, "p1"));
  fail = false;
  assert.equal(failed.ts.reply.code, "POLICYSQL_INTERNAL");
  assert.equal(failed.step.reply.code, "POLICYSQL_INTERNAL");
  const recorded = normalizedRecord("step", env.sides.step.slot.record());
  assert.deepEqual(recorded, { phase: "failed", nextSequence: 1, last: null },
    "core recorded failed from the record before the statement: it is not done");
  assert.equal(normalizedRecord("ts", env.sides.ts.slot.record()).phase, "active", "TS left it open");
  const after = await both(env, insert(1, "p1"));
  assert.equal(after.step.reply.code, "POLICYSQL_TRANSACTION_UNAVAILABLE", "core: the retry is not replayed as done");
  // A successor answers the retry the same way.
  env.sides.step.slot.lose();
  env.setSide("step");
  const successor = await perform(env, "step", insert(1, "p1"), env.nextRequest());
  assert.equal(successor.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  const commitAfter = await both(env, commit(2));
  assert.equal(commitAfter.step.reply.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  assert.deepEqual(env.rows("step").projects.map((row) => row.id), ["hidden", "seed"], "nothing committed");
});

test(`allowlist timer-during-statement: ${ALLOWLIST["timer-during-statement"]}`, async (t) => {
  const env = environment(t);
  assertSame(await both(env, write), "begin");
  const fired = new Set();
  env.faults.execute = async () => {
    const side = fired.has("ts") ? "step" : "ts";
    if (fired.has(side)) return;
    fired.add(side);
    env.clock.now = T0 + 4_000;
    await env.sides[side].slot.fireTimer(env.clock.now);
  };
  const statement = await both(env, insert(1, "p1"));
  assert.equal(statement.step.reply.code, "POLICYSQL_TRANSACTION_UNAVAILABLE", "core answers the expiry");
  assert.notEqual(statement.ts.reply.code, "POLICYSQL_TRANSACTION_UNAVAILABLE", "TS answers the statement's own failure");
  assert.equal(normalizedRecord("step", env.sides.step.slot.record()).phase, "expired");
  assert.equal(normalizedRecord("ts", env.sides.ts.slot.record()).phase, "failed");
  assert.deepEqual(env.rows("step").projects, env.rows("ts").projects, "nothing committed on either side");
});

test(`allowlist rollback-failure-keeps-phase: ${ALLOWLIST["rollback-failure-keeps-phase"]}`, async (t) => {
  const env = environment(t);
  assertSame(await both(env, write), "begin");
  env.faults.rollback = async () => { throw new Error("rollback transport"); };
  const reply = await both(env, rollback(1));
  assert.equal(reply.ts.reply.value.status, "failed");
  assert.equal(reply.step.reply.value.status, "rolled_back");
});

test(`allowlist old-format-record: ${ALLOWLIST["old-format-record"]}`, async (t) => {
  const env = environment(t);
  for (const op of [write, insert(1, "p1")]) assertSame(await both(env, op), op.op);
  // The step side reads the record TransactionOwnerCore wrote.
  env.sides.step.slot.setRecord(structuredClone(env.sides.ts.slot.record()));
  env.sides.step.slot.lose();
  env.setSide("step");
  const requestId = env.nextRequest();
  const statement = await perform(env, "step", insert(2, "p2"), requestId);
  assert.equal(statement.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  assert.equal(stepPhase(env.sides.step.slot.record()), "discarded");
  const commitReply = await perform(env, "step", commit(2), env.nextRequest());
  assert.equal(commitReply.error.code, "POLICYSQL_COMMIT_OUTCOME_UNKNOWN");
});

// ---- generated sequences -------------------------------------------------------------------

const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

const STATEMENTS = [
  () => ({ sql: "SELECT id, name FROM projects ORDER BY id" }),
  (random) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id: `g${Math.floor(random() * 4)}`, name: "n" } }),
  (random) => ({ sql: "UPDATE projects SET name = :name WHERE id = :id RETURNING id, name", params: { id: random() < 0.5 ? "seed" : "none", name: `u${Math.floor(random() * 3)}` } }),
  (random) => ({ sql: "INSERT INTO counters (id, big, ratio) VALUES (:id, :big, :ratio)", params: { id: `c${Math.floor(random() * 3)}`, big: Math.floor(random() * 1000), ratio: 1.5 } }),
  () => ({ sql: "SELECT tenant_id FROM projects" }),
  // Twice: a commit after it runs the validator (one callback query, then allow or deny).
  (random) => ({ sql: "INSERT INTO audited (id, note) VALUES (:id, :note)", params: { id: `x${Math.floor(random() * 3)}`, note: "n" } }),
  (random) => ({ sql: "INSERT INTO audited (id, note) VALUES (:id, :note)", params: { id: `y${Math.floor(random() * 3)}`, note: "m" } }),
];

/** The generated sequences' validator: one callback query, then allow (or deny). */
const generatedValidator = async ({ hook, query: run }) => {
  await run(query(1));
  return Response.json({ version: "1", allowed: !hook.requestId.endsWith("3") });
};

/** The allowlisted condition `op` reaches, judged from the TypeScript side's state. */
const reaches = (env, op, history) => {
  const record = env.sides.ts.slot.record();
  if (!record || !["statement", "commit", "rollback"].includes(op.op)) return null;
  const retry = op.seq === record.nextSequence - 1 && history.completed.get(op.seq) === op.text;
  const expired = record.expiresAtMs !== undefined && env.clock.now >= record.expiresAtMs;
  if (record.status === "active" && retry && (history.lost || expired)) return "replay-before-liveness";
  if (record.status === "active" && expired && !retry) return "expired-command";
  return null;
};

const generate = (random) => {
  const ops = [random() < 0.7 ? write : read];
  let seq = 1;
  let last = null;
  const length = 2 + Math.floor(random() * 12);
  for (let index = 0; index < length; index++) {
    const pick = random();
    let op;
    if (pick < 0.4) {
      const statement = STATEMENTS[Math.floor(random() * STATEMENTS.length)](random);
      op = { op: "statement", seq, ...statement };
    } else if (pick < 0.5 && last) op = last;
    else if (pick < 0.6) op = commit(seq);
    else if (pick < 0.65) op = rollback(seq);
    else if (pick < 0.7) op = { ...(random() < 0.5 ? select(seq) : insert(seq, "x")), seq: seq + (random() < 0.5 ? 1 : -1) };
    else if (pick < 0.78) op = { op: "advance", ms: random() < 0.5 ? 10 : 4_100 };
    else if (pick < 0.86) op = { op: "timer" };
    else if (pick < 0.9) op = { op: "lose" };
    else if (pick < 0.95) op = random() < 0.5 ? write : read;
    else op = { ...commit(seq), subject: "intruder" };
    if (op.op === "statement" || op.op === "commit" || op.op === "rollback") {
      op = {
        ...op,
        text: op.op === "statement" ? JSON.stringify({ sequence: op.seq, sql: op.sql, params: op.params ?? {} }) : JSON.stringify({ sequence: op.seq }),
      };
      last = op;
    }
    ops.push(op);
    if (op.op === "statement" || op.op === "commit" || op.op === "rollback") seq = Math.max(seq, op.seq) + (random() < 0.8 ? 1 : 0);
  }
  return ops;
};

test("generated command sequences agree except the allowlisted differences", async (t) => {
  const stats = { sequences: 0, ops: 0, compared: 0, validatorCalls: 0, callbacks: 0, stopped: {} };
  const random = mulberry32(35_04);
  for (let sequence = 0; sequence < 150; sequence++) {
    const ops = generate(random);
    // Every generated sequence gets its own fresh owners and databases.
    await t.test(`sequence ${sequence}`, async (st) => {
      const env = environment(st);
      env.validator = generatedValidator;
      const history = { completed: new Map(), lost: false };
      let stopped = null;
      for (const [index, op] of ops.entries()) {
        stats.ops++;
        const reason = reaches(env, op, history);
        if (reason) {
          stopped = reason;
          break;
        }
        const seen = await both(env, op);
        assertSame(seen, `sequence ${sequence} op ${index} ${JSON.stringify(op)}`);
        stats.compared++;
        if (op.op === "lose") history.lost = true;
        if (op.op === "begin") history.lost = false;
        if (seen?.ts.reply?.ok && op.text) history.completed.set(op.seq, op.text);
      }
      stats.validatorCalls += env.hooks.ts.length;
      stats.callbacks += env.callbacks.ts.length;
      if (stopped) stats.stopped[stopped] = (stats.stopped[stopped] ?? 0) + 1;
      else assertSameEnd(env, `sequence ${sequence}`);
    });
    stats.sequences++;
  }
  t.diagnostic(JSON.stringify(stats));
  assert.ok(stats.compared > 600, JSON.stringify(stats));
});

/** One random validator script: callback queries of random kinds, then a random verdict. */
const randomValidator = (random) => {
  const steps = Array.from({ length: Math.floor(random() * 4) }, () => {
    const pick = random();
    if (pick < 0.55) return { kind: "read", offset: 0 };
    if (pick < 0.65) return { kind: "read", offset: random() < 0.5 ? 1 : -1 };
    if (pick < 0.75) return { kind: "retry" };
    if (pick < 0.82) return { kind: "tampered" };
    if (pick < 0.88) return { kind: "delete" };
    if (pick < 0.94) return { kind: "bad" };
    return { kind: "projects" };
  });
  const verdict = random();
  return async ({ hook, query: run }) => {
    let next = 1;
    let last = null;
    for (const step of steps) {
      if (step.kind === "retry") {
        if (last) await run(last);
        continue;
      }
      const sequence = step.kind === "read" ? Math.max(1, next + step.offset) : next;
      const sql = {
        read: "SELECT id, note FROM audited ORDER BY id",
        tampered: "SELECT id FROM audited",
        delete: "DELETE FROM audited",
        bad: "SELEC nope",
        projects: "SELECT id, name FROM projects",
      }[step.kind];
      const text = query(sequence, sql);
      const token = step.kind === "tampered" ? `${hook.query.token[0] === "A" ? "B" : "A"}${hook.query.token.slice(1)}` : undefined;
      const reply = await run(text, token);
      if (reply.ok) {
        next = sequence + 1;
        last = text;
      }
    }
    if (verdict < 0.6) return ALLOW();
    if (verdict < 0.75) return Response.json({ version: "1", allowed: false });
    if (verdict < 0.85) return Response.json({ version: "1", allowed: true, unexpected: true });
    if (verdict < 0.93) return Response.json({ version: "1", allowed: true }, { status: 503 });
    throw new TypeError("fetch failed");
  };
};

test("generated commit-check sequences agree", async (t) => {
  const stats = { sequences: 0, validatorCalls: 0, callbacks: 0, committed: 0, rejected: 0 };
  const random = mulberry32(35_05);
  for (let sequence = 0; sequence < 60; sequence++) {
    const statements = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, index) => {
      const pick = random();
      if (pick < 0.6) return audit(index + 1, `g${sequence}_${index}`);
      if (pick < 0.8) return insert(index + 1, `p${sequence}_${index}`);
      return select(index + 1);
    });
    const validator = randomValidator(random);
    const after = random() < 0.5 ? [commit(statements.length + 1)] : [{ op: "callback", text: query(9) }];
    const ops = [write, ...statements, commit(statements.length + 1), ...after];
    await t.test(`sequence ${sequence}`, async (st) => {
      const env = await agree(st, ops, (setup) => { setup.validator = validator; });
      stats.validatorCalls += env.hooks.ts.length;
      stats.callbacks += env.callbacks.ts.length;
      const phase = normalizedRecord("ts", env.sides.ts.slot.record()).phase;
      if (phase === "committed") stats.committed++;
      if (env.hooks.ts.length > 0 && phase !== "committed") stats.rejected++;
    });
    stats.sequences++;
  }
  t.diagnostic(JSON.stringify(stats));
  assert.ok(stats.validatorCalls >= 25 && stats.callbacks >= 25 && stats.committed >= 10 && stats.rejected >= 10, JSON.stringify(stats));
});
