// End-to-end tests of the switch-over of atomic execution to the step machine (ADR 0024 pull
// request 8), through the public HTTP routes, the real WASM core, the real HTTP database
// transport, and SQLite, on both owner adapters. The differential harness
// (step-atomic-differential.test.mjs) compares the new path with the old one's recording scenario
// by scenario; these pin what the switch-over changed, fixed, or must keep across the deployment:
// #70 on the atomic path, request ids, keyed retries across owner loss and across the
// deployment (rows the previous release wrote), the cost observation, and version skew on the
// owner wire's `/atomic`.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { harness, OWNER_ADAPTERS, RawJson } from "./helpers/routing.mjs";
import { TransactionOwnerCore } from "../src/transaction-owner.ts";
import { durableObjectTransactionOwnerClass, durableObjectTransactionOwners } from "../src/adapters/durable-objects.ts";
import { statusFor } from "../src/http/status.ts";
import { referenceTranscript } from "./helpers/reference-transcript.mjs";

const fixtureFile = (name) => readFileSync(new URL(`../../../tests/fixtures/nullable/${name}`, import.meta.url), "utf8");
// Nullable 64-bit integer columns (#70): `count` as an int64.
const fixture = {
  catalog: fixtureFile("catalog.yaml").replace("count: { type: integer, nullable: true }", "count: { type: int64, representation: number, nullable: true }"),
  policy: fixtureFile("policy.yaml"),
  schema: fixtureFile("schema.sql"), physicalSchema: fixtureFile("physical-schema.json"),
  seed() {},
  callbackQuery: { sql: "SELECT id FROM nullabletexts", params: {} },
};
const BIG = "9007199254740993";
const KEY = "atomic-switch-key-0001";
const insert = (id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name: id } });
const execute = "/v1/transactions:execute";
const placements = [["direct", false], ["owner", true]];

const stored = (h, sql, ...args) => h.databases.get("a").database.prepare(sql).all(...args).map((row) => ({ ...row }));
const idempotencyRows = (h) => stored(h, "SELECT key_hash, fingerprint, response_json FROM policysql_idempotency ORDER BY rowid");
const { REJECTIONS, sendCommand, PolicySqlOutcomeUnknownError } = await import("../../../packages/client/protocol.js");
/** The client library takes `reply` as an unknown outcome of `execute`, never as a rejection. */
const neverRejected = async (reply) => {
  await assert.rejects(sendCommand(async () => reply, { kind: "execute" }, {}, () => {}), PolicySqlOutcomeUnknownError);
};

// What the previous release (origin/main at 6f97c57: the TypeScript direct path and
// `LegacyTransactionOwnerCore`'s atomic path) did is recorded (ADR 0024 pull request 9,
// test/helpers/reference-transcript.mjs): its execute's reply, the rows it wrote, its owner's
// record, its objects' replies, and its Worker's messages. The tests replay them against this
// version.
const reference = referenceTranscript(new URL("./fixtures/reference/atomic-switch.json", import.meta.url));

/**
 * A keyed execute committed by the previous release: its reply, the rows it wrote (the
 * idempotency row and the project row), and on the owner placement its owner's name and
 * record. The rows are planted where the previous release wrote them.
 */
const committedByPreviousRelease = (recorded, h) => {
  const wrote = recorded.take("previous release committed");
  const database = h.databases.get("a").database;
  for (const row of wrote.idempotency) {
    database.prepare("INSERT INTO policysql_idempotency (key_hash, fingerprint, response_json) VALUES (?, ?, ?)")
      .run(row.key_hash, row.fingerprint, row.response_json);
  }
  for (const row of wrote.projects) {
    const columns = Object.keys(row);
    database.prepare(`INSERT INTO projects (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...columns.map((column) => row[column]));
  }
  return wrote;
};

/** An object that answers with the previous release's recorded replies, in order. */
const recordedObject = (recorded) => async (url) => {
  const reply = recorded.take(`previous object ${new URL(url).pathname}`);
  return new Response(reply.body, { status: reply.status, headers: reply.headers });
};

for (const ownerAdapter of OWNER_ADAPTERS) {
  const setup = (t, options = {}) => {
    t.mock.method(console, "log", () => {});
    return harness(t, { ownerAdapter, ...options });
  };

  for (const [placement, hooks] of placements) {
    // #70: the TypeScript direct path bound `JSON.parse(body)` values, so 9007199254740993
    // became 9007199254740992; the machine binds the digits of the verified text.
    test(`${ownerAdapter}: #70: an atomic execute (${placement}) binds an integer beyond 2^53 exactly, as an interactive statement does`, async (t) => {
      const h = await setup(t, { hooks, fixture });
      h.setValidator(async () => true);
      const statement = (id, value = BIG) => `{"sql":"INSERT INTO nullabletexts (id, label, count) VALUES (:id, :label, :value)","params":{"id":"${id}","label":"x","value":${value}}}`;
      const text = `{"statements":[${statement("atomic_big")}]}`;
      const atomic = await h.request("a", execute, new RawJson(text), KEY);
      assert.equal(atomic.status, 200, JSON.stringify(atomic.body));
      assert.equal(atomic.body.meta.commitChecks, hooks ? "passed" : "not_triggered");
      assert.equal(h.ownerNames().length, hooks ? 1 : 0, "the placement");
      const begun = await h.request("a", "/v1/transactions", { mode: "write" }, null);
      const path = `/v1/transactions/${begun.body.transactionId}`;
      assert.equal((await h.request("a", `${path}/statements`, new RawJson(`{"sequence":1,${statement("interactive_big").slice(1)}`), null)).status, 200);
      assert.equal((await h.request("a", `${path}/commit`, { sequence: 2 }, null)).status, 200);
      // Both paths stored the same exact integer.
      assert.deepEqual(stored(h, "SELECT id, CAST(count AS TEXT) AS count, typeof(count) AS kind FROM nullabletexts ORDER BY id"), [
        { id: "atomic_big", count: BIG, kind: "integer" },
        { id: "interactive_big", count: BIG, kind: "integer" },
      ]);
      // An atomic read by the exact value finds both rows; a rounded binding would find none.
      const read = await h.request("a", execute, new RawJson(`{"statements":[{"sql":"SELECT id FROM nullabletexts WHERE count = :value ORDER BY id","params":{"value":${BIG}}}]}`), null);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.deepEqual(read.body.results[0].rows.map((row) => row.id), ["atomic_big", "interactive_big"]);
      // The exact retry replays; an integer JavaScript rounds to the same number is another
      // request, so the key conflicts (core hashed the text, not a rounding of it).
      assert.deepEqual((await h.request("a", execute, new RawJson(text), KEY)).body, atomic.body);
      const rounded = await h.request("a", execute, new RawJson(`{"statements":[${statement("atomic_big", "9007199254740992")}]}`), KEY);
      assert.equal(rounded.status, 409, JSON.stringify(rounded.body));
      assert.equal(rounded.body.error.code, "POLICYSQL_IDEMPOTENCY_CONFLICT");
      assert.equal(stored(h, "SELECT count(*) AS n FROM nullabletexts")[0].n, 2);
    });

    test(`${ownerAdapter}: an atomic execute (${placement}) keeps the caller's request id in its reply and its row`, async (t) => {
      const h = await setup(t, { hooks });
      h.setValidator(async () => true);
      const send = async (body, requestId, key) => {
        const response = await h.app.fetch(new Request(`https://worker.test${execute}`, {
          method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body),
        }), { database: h.binding("a"), session: h.session("a"), requestId }, h.background);
        return { status: response.status, body: await response.json() };
      };
      const first = await send({ statements: [insert("request_id")] }, "req_atomic_0001", KEY);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.meta.requestId, "req_atomic_0001");
      assert.equal(JSON.parse(idempotencyRows(h)[0].response_json).originalRequestId, "req_atomic_0001");
      if (hooks) {
        const [name] = h.ownerNames();
        assert.equal(h.ownerInputs(name)[0].kind, "atomic");
      }
      // A replay names the original request; an error names the request that got it.
      assert.deepEqual((await send({ statements: [insert("request_id")] }, "req_atomic_0002", KEY)).body, first.body);
      const conflict = await send({ statements: [insert("other")] }, "req_atomic_0003", KEY);
      assert.equal(conflict.body.error.code, "POLICYSQL_IDEMPOTENCY_CONFLICT");
      assert.equal(conflict.body.error.requestId, "req_atomic_0003");
    });

    // Rows the previous release wrote: the direct path's (no `status`, no `commitChecks`) and
    // the TypeScript owner path's. The key hash and the fingerprint are unchanged (ADR 0025,
    // and this pull request keeps the ABI and so the snapshot), so the retry replays.
    test(`${ownerAdapter}: a keyed retry (${placement}) replays the row the previous release wrote`, async (t) => {
      const h = await setup(t, { hooks });
      h.setValidator(async () => true);
      const body = { statements: [insert("across_deploy")] };
      const wrote = committedByPreviousRelease(reference.of(t), h);
      const { before } = wrote;
      assert.equal(before.ok, true, JSON.stringify(before));
      const [row] = idempotencyRows(h);
      const record = JSON.parse(row.response_json);
      assert.equal(Object.hasOwn(record, "status"), hooks, "the owner path's row has a status, the direct path's none");
      assert.equal(wrote.owner !== null, hooks, "the placement");
      // The object kept the TypeScript owner's record across the deployment.
      if (hooks) h.plantOwnerRecord(wrote.owner.name, wrote.owner.record);
      const retry = await h.request("a", execute, body, KEY);
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.deepEqual(retry.body, before.value, "the same response as the previous release gave");
      assert.equal(retry.body.meta.requestId, "req_origin_main");
      assert.equal(h.rows("a").filter((item) => item.id === "across_deploy").length, 1, "never executed twice");
      assert.deepEqual(idempotencyRows(h), [row], "the row is untouched");
      if (hooks) {
        const { name } = wrote.owner;
        assert.equal(typeof await h.ownerRecordRaw(name), "string", "the machine replaced the old-format record");
        assert.equal((await h.ownerRecord(name)).status, "committed");
      }
    });
  }

  test(`${ownerAdapter}: a keyed retry replays across owner loss, also when the terminal record was lost after COMMIT`, async (t) => {
    const h = await setup(t);
    h.setValidator(async () => true);
    const body = { statements: [insert("lost_owner")] };
    const first = await h.request("a", execute, body, KEY);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const [name] = h.ownerNames();
    h.loseOwner(name);
    assert.deepEqual((await h.request("a", execute, body, KEY)).body, first.body);
    // COMMIT applied but the owner's terminal record is not stored, and the owner is lost: the
    // reply is still committed, and the successor resolves the retry through the row.
    const key = "atomic-switch-key-0002";
    let lost = null;
    h.interceptOwnerPut(({ name: owner, value }) => {
      if (value?.status !== "committed" || lost !== null) return undefined;
      lost = owner;
      return { fail: true };
    });
    const second = await h.request("a", execute, { statements: [insert("lost_record")] }, key);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    h.interceptOwnerPut(null);
    assert.equal((await h.ownerRecord(lost)).status, "active");
    h.loseOwner(lost);
    assert.deepEqual((await h.request("a", execute, { statements: [insert("lost_record")] }, key)).body, second.body);
    assert.equal(h.rows("a").filter((row) => row.id.startsWith("lost_")).length, 2, "each executed once");
    assert.equal(h.events.filter(({ sql }) => sql === "COMMIT").length, 2);
  });

  // The real counterpart of the property-test counterexample of #77: a keyed direct execute
  // whose COMMIT transport fails (here after the database applied it) is answered without a
  // rejection, and its retry is answered from the row, with one row and one execution. The
  // database serializes write transactions (`BEGIN IMMEDIATE`) and `key_hash` is the table's
  // PRIMARY KEY.
  test(`${ownerAdapter}: a keyed direct execute whose COMMIT reply is lost resolves through its row, executed once`, async (t) => {
    const h = await setup(t, { hooks: false });
    h.afterDatabaseStatement(({ sql }) => { if (sql === "COMMIT") throw new Error("connection reset"); });
    const body = { statements: [insert("lost_commit")] };
    const first = await h.request("a", execute, body, KEY);
    assert.equal(first.status, 503, JSON.stringify(first.body));
    await neverRejected(first);
    h.afterDatabaseStatement(null);
    const retry = await h.request("a", execute, body, KEY);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(h.rows("a").filter((row) => row.id === "lost_commit").length, 1);
    assert.equal(idempotencyRows(h).length, 1);
    assert.ok(h.events.some(({ sql }) => sql === "BEGIN IMMEDIATE"), "write transactions take the write lock");
  });

  // ADR 0024: the machine observes cost after COMMIT (and for a direct replay); the TypeScript
  // owner path observed after the envelope, before its checks, so also an execution a check
  // then rejected.
  test(`${ownerAdapter}: cost is observed after COMMIT on both placements, never for an execution a check rejected`, async (t) => {
    const logs = [];
    t.mock.method(console, "log", (line) => { try { logs.push(JSON.parse(line)); } catch { /* not a record */ } });
    const h = await harness(t, { ownerAdapter });
    const observed = (requestId) => logs.filter((log) => log.requestId === `${requestId}-cost` && log.event.startsWith("cost_observation"));
    const send = async (body, requestId, key = null) => {
      const response = await h.app.fetch(new Request(`https://worker.test${execute}`, {
        method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body),
      }), { database: h.binding("a"), session: h.session("a"), requestId }, h.background);
      await h.flush();
      return response.status;
    };
    h.setValidator(async () => false);
    assert.equal(await send({ statements: [insert("denied")] }, "req_cost_denied"), 409);
    assert.deepEqual(observed("req_cost_denied"), [], "no observation for a rejected execution");
    h.setValidator(async () => true);
    assert.equal(await send({ statements: [insert("allowed")] }, "req_cost_owner"), 200);
    assert.deepEqual(observed("req_cost_owner").map((log) => log.event), ["cost_observation"]);
    assert.equal(await send({ statements: [{ sql: "SELECT id FROM projects", params: {} }] }, "req_cost_direct", KEY), 200);
    assert.deepEqual(observed("req_cost_direct").map((log) => log.event), ["cost_observation"]);
    assert.equal(await send({ statements: [{ sql: "SELECT id FROM projects", params: {} }] }, "req_cost_replay", KEY), 200);
    assert.deepEqual(observed("req_cost_replay").map((log) => log.event), ["cost_observation"]);
    // The direct path's usage log after COMMIT is kept.
    assert.ok(logs.some((log) => log.event === "database_usage" && log.requestId === "req_cost_direct"));
  });

  test(`${ownerAdapter}: the production owner rejects a malformed delegated idempotency before any database work`, async (t) => {
    const h = await setup(t);
    const { invalidDelegatedValues } = JSON.parse(readFileSync(new URL("./fixtures/optional-idempotency.json", import.meta.url), "utf8"));
    const name = `tx_${"d".repeat(32)}`;
    const owner = new TransactionOwnerCore({
      store: { async get() { return undefined; }, async put() { assert.fail("nothing is stored"); } },
      timer: { async schedule() { assert.fail("no timer"); } }, background: { run() {} }, name,
    }, h.ownerDependencies());
    const auth = JSON.parse(h.runtime.authorize_session_json(JSON.stringify(h.session("a")), undefined, "execute")).auth;
    const checks = h.counts().checks;
    for (const idempotency of invalidDelegatedValues) {
      const reply = await owner.atomic({
        kind: "atomic", validationId: `cval_${"d".repeat(32)}`, auth, request: JSON.stringify({ statements: [insert("never")] }),
        idempotency, databaseBinding: h.binding("a"), snapshot: h.runtime.snapshot,
      }, "req_malformed");
      assert.equal(reply.ok, false, JSON.stringify(idempotency));
      assert.equal(reply.error.code, "POLICYSQL_INVALID_REQUEST", JSON.stringify(idempotency));
    }
    assert.equal(h.counts().checks, checks, "no provider call");
    assert.equal(h.counts().connects, 0);
  });
}

// ---- version skew on the owner wire's `/atomic` (Durable Objects) -------------------------------

// The previous release's Worker side of the wire (origin/main at 6f97c57,
// src/adapters/durable-objects.ts `send`): every message carries the wire marker 1, the body is
// `JSON.stringify(input)`, and `/atomic` replies are read without a marker check.
const previousPort = (namespace) => ({
  route(name) {
    const stub = namespace.get(namespace.idFromName(name));
    return {
      async atomic(input, requestId) {
        const response = await stub.fetch("https://owner/atomic", {
          method: "POST",
          headers: { "content-type": "application/json", "x-policysql-request-id": requestId, "x-policysql-owner": name, "x-policysql-owner-wire": "1" },
          body: JSON.stringify(input),
        });
        const parsed = await response.json();
        if (response.ok) return { ok: true, value: parsed };
        return { ok: false, error: { code: parsed?.error?.code, message: parsed?.error?.message, path: parsed?.error?.path ?? null } };
      },
    };
  },
});

// The previous release's object (origin/main at 6f97c57): `serve` answered `/atomic` with
// `TransactionOwnerCore.atomic`, which handed it to the TypeScript atomic path
// (`LegacyTransactionOwnerCore`), and marked every reply with wire version 1. Its replies to
// this version's messages are recorded (`recordedObject`); its interactive paths were the step
// machine's and are not exercised here.

test("durable-objects: a Worker of this version never turns the previous object's /atomic answer into a rejection or a second execution", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = await harness(t, { ownerAdapter: "durable-objects" });
  h.setValidator(async () => true);
  // The previous release's objects, each over its own storage, which survives the upgrade.
  const storage = new Map();
  const data = (name) => { if (!storage.has(name)) storage.set(name, new Map()); return storage.get(name); };
  const recorded = reference.of(t);
  const context = { database: h.binding("a"), session: h.session("a") };
  // The previous release committed a keyed execute `body` through its own wire (recorded); its
  // object's storage keeps the record it wrote.
  const body = { statements: [insert("skewed")] };
  const wrote = committedByPreviousRelease(recorded, h);
  const committed = wrote.before;
  assert.equal(committed.ok, true, JSON.stringify(committed));
  data(wrote.owner.name).set("transaction", wrote.owner.record);
  // The previous release's objects answer this version's Worker (their replies recorded).
  const namespace = { idFromName: (name) => ({ name }), get: () => ({ fetch: recordedObject(recorded) }) };
  // Its response is lost; the client retries through a Worker of this version during the skew.
  const app = h.appWith(durableObjectTransactionOwners(namespace));
  const send = async (payload, key = null) => {
    const response = await app.fetch(new Request(`https://worker.test${execute}`, {
      method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(payload),
    }), context, h.background);
    return { status: response.status, body: await response.json() };
  };
  const events = h.events.length;
  for (const [label, reply] of [["keyed retry", await send(body, KEY)], ["unkeyed", await send({ statements: [insert("skewed_new")] })]]) {
    assert.equal(reply.status, 500, `${label}: ${JSON.stringify(reply.body)}`);
    assert.equal(reply.body.error.code, "POLICYSQL_INTERNAL", label);
    await neverRejected(reply);
  }
  // The previous object rejected the new atomic input (its `kind` member) before any database work.
  assert.deepEqual(h.events.slice(events), [], "nothing reached the database");
  assert.deepEqual(h.rows("a").filter((row) => row.id.startsWith("skewed")).map((row) => row.id), ["skewed"]);
  // The skew ends: this version's objects over the same storage. The retry replays.
  const OwnerObject = durableObjectTransactionOwnerClass(() => h.ownerDependencies());
  const upgraded = new Map();
  const current = {
    idFromName: (name) => ({ name }),
    get: ({ name }) => {
      if (!upgraded.has(name)) {
        upgraded.set(name, new OwnerObject({
          id: { name },
          waitUntil() {},
          storage: { async get(key) { return structuredClone(data(name).get(key)); }, async put(key, value) { data(name).set(key, structuredClone(value)); }, async setAlarm() {} },
        }, {}));
      }
      const object = upgraded.get(name);
      return { fetch: (input, init) => object.fetch(new Request(input, init)) };
    },
  };
  const after = h.appWith(durableObjectTransactionOwners(current));
  const replayed = await after.fetch(new Request(`https://worker.test${execute}`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": KEY }, body: JSON.stringify(body),
  }), context, h.background);
  assert.equal(replayed.status, 200);
  assert.deepEqual(await replayed.json(), committed.value, "the previous release's response");
  assert.equal(h.rows("a").filter((row) => row.id === "skewed").length, 1, "executed once");
});

test("durable-objects: an object of this version answers the previous Worker's /atomic without a rejection or a second execution", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = await harness(t, { ownerAdapter: "durable-objects" });
  h.setValidator(async () => true);
  const body = { statements: [insert("new_object")] };
  const first = await h.request("a", execute, body, KEY);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const [name] = h.ownerNames();
  const record = await h.ownerRecordRaw(name);
  const events = h.events.length;
  // The previous release's Worker: its atomic input and wire marker 1. What it sent is recorded
  // (each `/atomic` message: the owner it routed to, its input, and its request id) with what it
  // answered its client, for three executes of tenant "a": a keyed retry of `body` (key `KEY`),
  // another keyed execute (`previous_keyed`, key "atomic-switch-key-0009"), and an unkeyed one
  // (`previous_unkeyed`). The messages are sent to this version's objects again.
  const recorded = reference.of(t);
  for (const label of ["keyed retry of a committed execute", "another keyed execute", "unkeyed"]) {
    const port = previousPort(h.ownerNamespace());
    const sent = recorded.take(`previous Worker: ${label}`);
    assert.equal(sent.messages.length, 1, label);
    for (const message of sent.messages) {
      assert.deepEqual(await port.route(message.name).atomic(message.input, message.requestId), message.reply, `${label}: this object's reply`);
    }
    for (const reply of [sent.messages[0].reply, sent.answered]) {
      assert.equal(reply.ok, false, label);
      assert.equal(reply.error.code, "POLICYSQL_INTERNAL", label);
      assert.equal(REJECTIONS.get(statusFor(reply.error.code)) ?? null, null, `${label}: no rejection status`);
    }
    await neverRejected({ status: statusFor(sent.answered.error.code), body: { error: { ...sent.answered.error, requestId: sent.answered.requestId } } });
  }
  assert.deepEqual(h.events.slice(events), [], "nothing reached the database");
  assert.equal(await h.ownerRecordRaw(name), record, "nothing reached the machine");
  assert.deepEqual(h.rows("a").filter((row) => row.id.startsWith("previous_")), []);
  // Once the versions agree, the keyed retry replays.
  assert.deepEqual((await h.request("a", execute, body, KEY)).body, first.body);
  assert.equal(h.rows("a").filter((row) => row.id === "new_object").length, 1);
});
