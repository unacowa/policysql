// End-to-end tests of the switch-over of atomic execution to the step machine (ADR 0024 pull
// request 8), through the public HTTP routes, the real WASM core, the real HTTP database
// transport, and SQLite, on both owner adapters. The differential harness
// (step-atomic-differential.test.mjs) compares the new path with the old one's recording scenario
// by scenario; these pin #70 on the atomic path, request ids, keyed retries across owner loss,
// and the cost observation.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { harness, OWNER_ADAPTERS, RawJson } from "./helpers/routing.mjs";
import { TransactionOwnerCore } from "../src/transaction-owner.ts";

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
const { sendCommand, PolicySqlOutcomeUnknownError } = await import("../../../packages/client/protocol.js");
/** The client library takes `reply` as an unknown outcome of `execute`, never as a rejection. */
const neverRejected = async (reply) => {
  await assert.rejects(sendCommand(async () => reply, { kind: "execute" }, {}, () => {}), PolicySqlOutcomeUnknownError);
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
