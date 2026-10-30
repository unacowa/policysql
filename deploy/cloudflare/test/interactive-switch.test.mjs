// End-to-end tests of the switch-over of interactive transactions to the step machine (ADR 0024
// pull request 7), through the public HTTP routes, the real WASM core, the real HTTP database
// transport, and SQLite, on both owner adapters. The owner-port conformance suite
// (transaction-owner-port.test.mjs) and the differential harness (step-differential.test.mjs)
// cover the rest of the protocol; these pin what the switch-over changed or fixed.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { harness, OWNER_ADAPTERS, RawJson } from "./helpers/routing.mjs";

const fixtureFile = (name) => readFileSync(new URL(`../../../tests/fixtures/nullable/${name}`, import.meta.url), "utf8");
// Nullable 64-bit integer and number columns (#70): `count` as an int64, `amount` a number.
const fixture = {
  catalog: fixtureFile("catalog.yaml").replace("count: { type: integer, nullable: true }", "count: { type: int64, representation: number, nullable: true }"),
  policy: fixtureFile("policy.yaml"),
  schema: fixtureFile("schema.sql"), physicalSchema: fixtureFile("physical-schema.json"),
  seed() {},
  callbackQuery: { sql: "SELECT id FROM nullabletexts", params: {} },
};
const UNKNOWN = "POLICYSQL_COMMIT_OUTCOME_UNKNOWN";
const BIG = "9007199254740993";
const read = { sql: "SELECT id, name FROM projects ORDER BY id", params: {} };
const insert = (id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name: id } });

const stored = (h, sql, ...args) => h.databases.get("a").database.prepare(sql).all(...args).map((row) => ({ ...row }));

for (const ownerAdapter of OWNER_ADAPTERS) {
  const setup = (t, options = {}) => harness(t, { ownerAdapter, ...options });
  const begin = async (h, mode = "write") => {
    const started = await h.request("a", "/v1/transactions", { mode }, null);
    assert.equal(started.status, 201, JSON.stringify(started.body));
    return started.body.transactionId;
  };

  // #70: the owner compiled and hashed `JSON.stringify(command)`, so `1e400` became NULL and
  // an integer beyond 2^53 was rounded. The engine now forwards the verified body text, the
  // machine compiles it, and the transport binds the digits core wrote.
  test(`${ownerAdapter}: #70: 1e400 is rejected as in an atomic execute, never written as NULL`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false, fixture });
    const statement = '{"sql":"INSERT INTO nullabletexts (id, label, amount) VALUES (:id, :label, :value)","params":{"id":"overflow","label":"x","value":1e400}}';
    const atomic = await h.request("a", "/v1/transactions:execute", new RawJson(`{"statements":[${statement}]}`), null);
    assert.equal(atomic.status, 400, JSON.stringify(atomic.body));
    const id = await begin(h);
    const interactive = await h.request("a", `/v1/transactions/${id}/statements`, new RawJson(`{"sequence":1,${statement.slice(1)}`), null);
    assert.equal(interactive.status, atomic.status, JSON.stringify(interactive.body));
    assert.equal(interactive.body.error.code, atomic.body.error.code);
    assert.equal(interactive.body.error.path, atomic.body.error.path);
    // A compile error closes the transaction (ADR 0007); nothing was written, NULL least of all.
    const commit = await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 }, null);
    assert.equal(commit.status, 409, JSON.stringify(commit.body));
    assert.deepEqual(stored(h, "SELECT id FROM nullabletexts WHERE id = 'overflow'"), []);
  });

  test(`${ownerAdapter}: #70: an integer beyond 2^53 is bound exactly, also in a callback query`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: true, fixture });
    // (The atomic side of #70 is pinned by test/atomic-switch.test.mjs since pull request 8.)
    const id = await begin(h);
    const path = `/v1/transactions/${id}`;
    const text = `{"sequence":1,"sql":"INSERT INTO nullabletexts (id, label, count) VALUES (:id, :label, :value)","params":{"id":"interactive_big","label":"x","value":${BIG}}}`;
    const first = await h.request("a", `${path}/statements`, new RawJson(text), null);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    // The exact retry is the same text: it replays (core hashed the text, not a rounding of it).
    assert.deepEqual((await h.request("a", `${path}/statements`, new RawJson(text), null)).body, first.body);
    // The validator's callback query matches the exact value, which a rounded binding would miss.
    let callback;
    h.setValidator(async (hook) => {
      callback = await h.request("a", new URL(hook.query.url).pathname,
        new RawJson(`{"sequence":1,"sql":"SELECT id FROM nullabletexts WHERE count = :value","params":{"value":${BIG}}}`), undefined, hook.query.token);
      return callback.status === 200;
    });
    const commit = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    assert.equal(callback.status, 200, JSON.stringify(callback.body));
    assert.deepEqual(callback.body.rows.map((row) => row.id).sort(), ["interactive_big"]);
    assert.deepEqual(stored(h, "SELECT id, CAST(count AS TEXT) AS count, typeof(count) AS kind FROM nullabletexts WHERE id = 'interactive_big'"), [
      { id: "interactive_big", count: BIG, kind: "integer" },
    ]);
    // A different integer that JavaScript rounds to the same number is not an exact retry: it
    // conflicts (ADR 0007), where the rounded digest of before would have replayed it.
    h.setValidator(async () => true);
    const other = await begin(h);
    const otherText = text.replace(BIG, "9007199254740992").replace("interactive_big", "other");
    assert.equal((await h.request("a", `/v1/transactions/${other}/statements`, new RawJson(otherText), null)).status, 200);
    const changed = await h.request("a", `/v1/transactions/${other}/statements`, new RawJson(otherText.replace("9007199254740992", BIG)), null);
    assert.equal(changed.status, 409, JSON.stringify(changed.body));
    assert.equal(changed.body.error.code, "POLICYSQL_TRANSACTION_CONFLICT");
  });

  test(`${ownerAdapter}: owner loss: the successor fails the transaction closed, replays what completed, and never reconnects`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false });
    const id = await begin(h);
    const path = `/v1/transactions/${id}`;
    const statement = { sequence: 1, ...insert("lost") };
    const first = await h.request("a", `${path}/statements`, statement, null);
    assert.equal(first.status, 200);
    const connects = h.counts().connects;
    h.loseOwner(id);
    // An exact retry of the completed statement is answered from the stored reply (ADR 0024
    // "Replay identity"), before the liveness check.
    assert.deepEqual((await h.request("a", `${path}/statements`, statement, null)).body, first.body);
    // Work needs the lost connection: unavailable, and the record becomes failed.
    const next = await h.request("a", `${path}/statements`, { sequence: 2, ...read }, null);
    assert.equal(next.status, 409);
    assert.equal(next.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
    assert.equal((await h.ownerRecord(id)).status, "failed");
    // A commit is never sent without a connection: unavailable is true, not a misreport.
    const commit = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
    assert.equal(commit.status, 409);
    assert.equal(commit.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
    assert.equal(h.counts().connects, connects, "no replacement connection");
    assert.equal(h.events.filter(({ sql }) => sql === "COMMIT").length, 0);
    assert.equal(h.rows("a").some((row) => row.id === "lost"), false);
  });

  test(`${ownerAdapter}: commit retries in the unsafe windows are unknown or replayed, never rejected`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false });
    const unknown = (reply, label) => {
      assert.equal(reply.status, 503, `${label}: ${JSON.stringify(reply.body)}`);
      assert.equal(reply.body.error.code, UNKNOWN, label);
    };
    const open = async (label) => {
      const id = await begin(h);
      assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert(label) }, null)).status, 200);
      return { id, commit: () => h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 }, null) };
    };
    // Window A: the owner is lost after COMMIT applied, before the terminal record.
    const a = await open("window_a");
    let armed = true;
    h.afterDatabaseStatement(({ sql }) => { if (armed && sql === "COMMIT") { armed = false; h.loseOwner(a.id); } });
    assert.equal((await a.commit()).body.status, "committed");
    unknown(await a.commit(), "window A");
    // Window B: the terminal record landed, then the owner was lost: replayed.
    const b = await open("window_b");
    let lose = true;
    h.interceptOwnerPut(({ value }) => (lose && value?.status === "committed" ? (lose = false, { lose: true }) : undefined));
    const committed = await b.commit();
    assert.deepEqual((await b.commit()).body, committed.body, "window B");
    h.interceptOwnerPut(null);
    // A COMMIT transport error: unknown, recorded as such (ADR 0024 inconsistency 4).
    const c = await open("commit_error");
    let fail = true;
    h.afterDatabaseStatement(({ sql }) => { if (fail && sql === "COMMIT") { fail = false; throw new Error("connection reset"); } });
    unknown(await c.commit(), "COMMIT error");
    unknown(await c.commit(), "COMMIT error retry");
    assert.equal((await h.ownerRecord(c.id)).status, "commit_unknown");
    h.afterDatabaseStatement(null);
    for (const label of ["window_a", "window_b", "commit_error"]) {
      assert.equal(h.rows("a").filter((row) => row.id === label).length, 1, `${label} committed once`);
    }
  });

  test(`${ownerAdapter}: a timer during the validator answers the waiting commit at once and ignores the late verdict`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t);
    const id = await begin(h);
    const path = `/v1/transactions/${id}`;
    assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert("timed_out") }, null)).status, 200);
    let release;
    const verdict = new Promise((resolve) => { release = resolve; });
    let commitAnswered = false;
    h.setValidator(async () => {
      await h.fireTimer(id);
      // The validator has not answered yet; the commit already has (ADR 0024 inconsistency 5).
      await verdict;
      return true;
    });
    const commit = h.request("a", `${path}/commit`, { sequence: 2 }, null).then((reply) => { commitAnswered = true; return reply; });
    const answered = await commit;
    assert.equal(commitAnswered, true);
    assert.equal(answered.status, 409, JSON.stringify(answered.body));
    assert.equal(answered.body.error.code, "POLICYSQL_COMMIT_CHECK_REJECTED");
    // The late allow changes nothing.
    release();
    await h.flush();
    await h.ownerCore(id).settled?.();
    assert.equal((await h.ownerRecord(id)).status, "expired");
    assert.equal(h.events.some(({ sql }) => sql === "COMMIT"), false);
    assert.equal((await h.request("a", `${path}/commit`, { sequence: 2 }, null)).status, 409);
    assert.equal(h.rows("a").some((row) => row.id === "timed_out"), false);
  });

  test(`${ownerAdapter}: a stray callback query changes nothing (#73)`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t);
    const id = await begin(h);
    const path = `/v1/transactions/${id}`;
    assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert("stray") }, null)).status, 200);
    const callback = `/v1/commit-checks/${id.replace(/^tx_/u, "cval_")}/query`;
    for (const token of ["A".repeat(43), "malformed", ""]) {
      const stray = await h.request("a", callback, { sequence: 1, ...read }, undefined, token || undefined);
      assert.equal(stray.status, 409, JSON.stringify(stray.body));
      assert.equal(stray.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
    }
    assert.equal((await h.ownerRecord(id)).status, "active", "the open transaction is untouched");
    const commit = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    assert.equal(commit.body.meta.commitChecks, "passed");
    // After the verdict the capability is revoked: a late callback changes nothing either.
    const late = await h.request("a", callback, { sequence: 9, ...read }, undefined, "A".repeat(43));
    assert.equal(late.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
    assert.deepEqual((await h.request("a", `${path}/commit`, { sequence: 2 }, null)).body, commit.body);
    assert.equal(h.rows("a").filter((row) => row.id === "stray").length, 1);
  });

  // Since pull request 8 an atomic execute that can trigger a check runs on the machine's owner
  // path too: its record is the machine's (`kind: atomic`), which serializes work and answers
  // no request. Interactive inputs, stray callbacks, and timers that reach such an owner change
  // nothing, and a keyed retry still replays from its `policysql_idempotency` row.
  test(`${ownerAdapter}: an atomic owner's record is the machine's and answers no request`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t);
    const body = { statements: [insert("atomic_owned")] };
    const key = "atomic-owner-kept-0001";
    const first = await h.request("a", "/v1/transactions:execute", body, key);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.meta.commitChecks, "passed");
    const [name] = h.ownerNames();
    const record = await h.ownerRecordRaw(name);
    assert.equal(typeof record, "string", "the machine's durable text");
    assert.equal(JSON.parse(record).kind, "atomic");
    assert.equal(JSON.parse(record).phase, "committed");
    for (const [path, command] of [["statements", { sequence: 1, ...read }], ["commit", { sequence: 1 }], ["rollback", { sequence: 1 }]]) {
      const reply = await h.request("a", `/v1/transactions/${name}/${path}`, command, null);
      assert.equal(reply.status, 409, `${path}: ${JSON.stringify(reply.body)}`);
      assert.equal(reply.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE", path);
    }
    const stray = await h.request("a", `/v1/commit-checks/${name.replace(/^tx_/u, "cval_")}/query`, { sequence: 1, ...read }, undefined, "A".repeat(43));
    assert.equal(stray.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
    await h.ownerCore(name).onTimer();
    assert.equal(await h.ownerRecordRaw(name), record, "the record is untouched");
    const retry = await h.request("a", "/v1/transactions:execute", body, key);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.deepEqual(retry.body, first.body, "the replay names the original request and checks");
    assert.equal(h.rows("a").filter((row) => row.id === "atomic_owned").length, 1);
  });

  test(`${ownerAdapter}: replies keep the caller's request id`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false });
    const id = await begin(h);
    // The wrapper's request id reaches the owner and is the reply's `meta.requestId`.
    const send = async (path, body, requestId) => {
      const response = await h.app.fetch(new Request(`https://worker.test${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }), { database: h.binding("a"), session: h.session("a"), requestId }, h.background);
      return { status: response.status, body: await response.json() };
    };
    const statement = await send(`/v1/transactions/${id}/statements`, { sequence: 1, ...read }, "req_caller_0001");
    assert.equal(statement.status, 200, JSON.stringify(statement.body));
    assert.equal(statement.body.meta.requestId, "req_caller_0001");
    const commit = await send(`/v1/transactions/${id}/commit`, { sequence: 2 }, "req_caller_0002");
    assert.equal(commit.body.meta.requestId, "req_caller_0002");
    // An exact retry replays the original reply, its request id included.
    assert.deepEqual((await send(`/v1/transactions/${id}/commit`, { sequence: 2 }, "req_caller_0003")).body, commit.body);
    const conflict = await send(`/v1/transactions/${id}/rollback`, { sequence: 2 }, "req_caller_0004");
    assert.equal(conflict.body.error.requestId, "req_caller_0004");
  });
}
