// The differential harness of ADR 0024 pull request 4: today's `TransactionOwnerCore` and the
// step machine (`StepOwnerCore`, test/helpers/step-owner.mjs, over the real WASM `step_json`)
// run the same owner scenarios side by side, with the same fake clock, the same kind of
// database (one SQLite file each), and the same store and timer faults. The harness asserts
// equal replies, database calls (SQL and arguments), terminal records, transaction log events,
// and final rows, except the differences in `ALLOWLIST`, each named with its reason.
//
// It covers the owner-level scenarios of transaction-owner.test.mjs and
// transaction-owner-port.test.mjs (without commit checks, which pull request 5 adds), plus
// generated command sequences. Pull request 9 deletes it; the transcripts replace it.
import assert from "node:assert/strict";
import test from "node:test";
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
  "commit-checks": "Commit checks and callbacks run in the machine from pull request 5; this harness configures none.",
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
`;
const SCHEMA = `
CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT);
CREATE TABLE counters (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, big INTEGER, ratio REAL);
INSERT INTO projects VALUES ('seed', 'tenant_a', 'seed');
INSERT INTO projects VALUES ('hidden', 'tenant_b', 'hidden');
`;
const LIMITS = { maxRows: 100, maxResultBytes: 64_000, timeoutMs: 1_000, maxStatements: 8 };
const TX = `tx_${"a".repeat(32)}`;
const T0 = 1_790_000_000_000;
const config = {
  environment: "test",
  costCatalog: { maxEstimatedRowsRead: 1000, maxEstimatedRowsWritten: 1000, resources: { 1: { upperRows: 100 } } },
};

const makeRuntime = (policyVersion = "policy_1") =>
  new PolicySqlRuntime(CATALOG, POLICY, "schema_1", policyVersion, runtimeLimitsJson(LIMITS));
const authOf = (runtime, subject = "user_1") => JSON.parse(runtime.authorize_session_json(JSON.stringify({
  principal: "https://issuer.test:user", subject, roles: ["member"], defaultRole: "member",
  access: ["execute"], session: { tenant_id: "tenant_a" },
}), undefined, "execute")).auth;
const bindingOf = (runtime) => ({ version: 1, scope: "tenant", databaseId: "db_a", generation: "1", snapshot: runtime.snapshot });
const identity = (runtime, input) => JSON.parse(runtime.identity_json(JSON.stringify(input)));

const COMPARED_LOGS = new Set(["transaction_started", "transaction_usage", "transaction_terminal", "transaction_owner_unavailable"]);

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

/** Both sides of one owner, with a fake clock. */
const environment = (t) => {
  const directory = mkdtempSync(join(tmpdir(), "policysql-step-diff-"));
  const runtimes = { current: makeRuntime() };
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
  for (const side of ["ts", "step"]) {
    const path = join(directory, `${side}.sqlite`);
    const db = new DatabaseSync(path);
    db.exec(SCHEMA);
    db.close();
    const calls = [];
    const database = sqliteProvider(path, calls, faults, connections);
    const getRuntime = () => runtimes.current;
    const makeCore = side === "ts"
      ? (facilities) => new TransactionOwnerCore(facilities, { getRuntime, database, config })
      : (facilities) => new StepOwnerCore(facilities, { getRuntime, database }, TX);
    sides[side] = { path, calls, slot: ownerSlot(makeCore, faults, side === "ts" ? tsPhase : stepPhase) };
  }
  t.after(() => {
    for (const db of connections) { try { db.close(); } catch { /* closed */ } }
    rmSync(directory, { recursive: true, force: true });
    runtimes.current.free();
  });
  let request = 0;
  const env = {
    runtimes, clock, faults, sides, logs,
    caller: { subject: "user_1" },
    setSide(side) { current = side; },
    rows(side) {
      const db = new DatabaseSync(sides[side].path, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 0");
      try {
        return {
          projects: db.prepare("SELECT * FROM projects ORDER BY id").all().map((row) => ({ ...row })),
          counters: db.prepare("SELECT id, tenant_id, CAST(big AS TEXT) AS big, typeof(big) AS big_type, ratio FROM counters ORDER BY id").all().map((row) => ({ ...row })),
        };
      } finally { db.close(); }
    },
    nextRequest: () => `req-${++request}`,
  };
  return env;
};

// One operation on one side. Commands carry the session and the verified text for the step
// side; the TypeScript side gets the parsed value as the engine forwards it today.
const perform = async (env, side, op, requestId) => {
  const { slot } = env.sides[side];
  const runtime = env.runtimes.current;
  const auth = authOf(runtime, op.subject ?? env.caller.subject);
  const databaseBinding = bindingOf(runtime);
  const snapshot = runtime.snapshot;
  const authFingerprint = identity(runtime, { op: "auth", auth, binding: databaseBinding }).fingerprint;
  switch (op.op) {
    case "begin": {
      const startFingerprint = op.startFingerprint ??
        identity(runtime, { op: "start", transactionId: TX, body: JSON.stringify({ mode: op.mode }) }).digest;
      return await slot.core.begin({ transactionId: TX, authFingerprint, startFingerprint, mode: op.mode, auth, databaseBinding, snapshot }, requestId);
    }
    case "statement": case "commit": case "rollback": {
      const text = op.text ?? (op.op === "statement"
        ? JSON.stringify({ sequence: op.seq, sql: op.sql, params: op.params ?? {} })
        : JSON.stringify({ sequence: op.seq }));
      const command = JSON.parse(text);
      return await slot.core.command(op.op, side === "ts"
        ? { transactionId: TX, authFingerprint, command, databaseBinding, snapshot }
        : { transactionId: TX, auth, bodyText: text, databaseBinding, snapshot }, requestId);
    }
    case "timer":
      await slot.fireTimer(env.clock.now);
      return null;
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
    const calls = env.sides[side].calls.length;
    const logs = env.logs[side].length;
    env.setSide(side);
    const reply = await perform(env, side, op, requestId);
    seen[side] = {
      reply: reply && normalizedReply(reply),
      calls: env.sides[side].calls.slice(calls),
      logs: env.logs[side].slice(logs),
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
};

const assertSameEnd = (env, label) => {
  assert.deepEqual(normalizedRecord("step", env.sides.step.slot.record()), normalizedRecord("ts", env.sides.ts.slot.record()), `${label}: record`);
  assert.deepEqual(env.rows("step"), env.rows("ts"), `${label}: rows`);
  assert.deepEqual(env.sides.step.slot.core.unrouted ?? [], [], `${label}: every reply routed`);
};

/** Runs ops that must agree completely. */
const agree = async (t, ops, prepare = () => {}) => {
  const env = environment(t);
  prepare(env);
  for (const [index, op] of ops.entries()) assertSame(await both(env, op), `${op.op}#${index}`);
  assertSameEnd(env, "end");
  return env;
};

const write = { op: "begin", mode: "write" };
const read = { op: "begin", mode: "read" };
const insert = (seq, id, name = id) => ({ op: "statement", seq, sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name } });
const select = (seq) => ({ op: "statement", seq, sql: "SELECT id, name FROM projects ORDER BY id" });
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

// ---- the allowlisted differences, each asserted for both sides ---------------------------------

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
];

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
  const stats = { sequences: 0, ops: 0, compared: 0, stopped: {} };
  const random = mulberry32(35_04);
  for (let sequence = 0; sequence < 150; sequence++) {
    const ops = generate(random);
    // Every generated sequence gets its own fresh owners and databases.
    await t.test(`sequence ${sequence}`, async (st) => {
      const env = environment(st);
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
      if (stopped) stats.stopped[stopped] = (stats.stopped[stopped] ?? 0) + 1;
      else assertSameEnd(env, `sequence ${sequence}`);
    });
    stats.sequences++;
  }
  t.diagnostic(JSON.stringify(stats));
  assert.ok(stats.compared > 600, JSON.stringify(stats));
});
