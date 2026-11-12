import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { harness } from "./helpers/routing.mjs";

// The compile's time as a preset value, through the real WASM, the HTTP transport, SQLite, the
// engine and the transaction owner. The clock is the real one: every time is bracketed by the
// `Date.now()` before and after the request.
const read = name => readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url), "utf8");
const fixture = {
  catalog: read("now/catalog.yaml"), policy: read("now/policy.yaml"),
  schema: read("now/schema.sql"), physicalSchema: read("now/physical-schema.json"),
  seed(db, tenant) {
    db.prepare("INSERT INTO projects(id,tenant_id,name) VALUES(?,?,?)").run("p1", `tenant_${tenant}`, "Old");
    db.prepare("INSERT INTO projects(id,tenant_id,name) VALUES(?,?,?)").run("hidden", "another_tenant", "Hidden");
  },
  callbackQuery: { sql: "SELECT id,name FROM projects", params: {} },
};
const RETURNING = " RETURNING id,name,updated_at,touched_on,updated_ms";
const update = (id, name) => ({ sql: `UPDATE projects SET name=:name WHERE id=:id${RETURNING}`, params: { id, name } });
const insert = id => ({ sql: `INSERT INTO projects(id,name) VALUES(:id,:name)${RETURNING}`, params: { id, name: id } });
const execute = (h, statements, key = null) => h.request("a", "/v1/transactions:execute", { statements }, key);
const row = (h, id) => h.databases.get("a").database.prepare("SELECT updated_at,touched_on,updated_ms,typeof(updated_ms) AS storage FROM projects WHERE id=?").get(id);
const writes = h => h.events.filter(event => /^(INSERT|UPDATE) "projects"/.test(event.sql)).length;
const bracket = async work => {
  const before = Date.now();
  const result = await work();
  return { result, before, after: Date.now() };
};
// The three spellings of one instant; every one must agree with `updated_at`.
const consistent = (returned, stored = returned) => {
  const at = Date.parse(returned.updated_at);
  assert.equal(returned.updated_at, new Date(at).toISOString());
  assert.equal(typeof returned.updated_ms, "number", "a safe integer is a JSON number");
  assert.equal(returned.updated_ms, at);
  assert.equal(returned.touched_on, `${returned.updated_at.slice(0, 10)} ${returned.updated_at.slice(11, 19)}`);
  assert.equal(stored.updated_at, returned.updated_at);
  assert.equal(stored.touched_on, returned.touched_on);
  assert.equal(Number(stored.updated_ms), returned.updated_ms);
  assert.equal(stored.storage ?? "integer", "integer");
  return at;
};

for (const hooks of [false, true]) {
  test(`a keyed UPDATE stores the server's time in three shapes and returns what it stored (hooks=${hooks})`, async t => {
    const h = await harness(t, { hooks, fixture });
    const { result, before, after } = await bracket(() => execute(h, [update("p1", "Renamed")], "now-keyed-update-0001"));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const returned = result.body.results[0].rows[0];
    const at = consistent(returned, row(h, "p1"));
    assert.ok(before <= at && at <= after, `${before} <= ${at} <= ${after}`);
    if (hooks) assert.ok(h.ownerNames().length > 0, "the commit check sent the write to an owner");
    // Differential: SQLite's own calendar spells the same instant.
    const oracle = h.databases.get("a").database.prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%S', ?1 / 1000, 'unixepoch') || printf('.%03dZ', ?1 % 1000) AS rfc, datetime(?1 / 1000, 'unixepoch') AS dt",
    ).get(at);
    assert.equal(returned.updated_at, oracle.rfc);
    assert.equal(returned.touched_on, oracle.dt);
    // The other tenant's row keeps the seed's columns.
    const hidden = h.databases.get("a").database.prepare("SELECT updated_at,updated_ms FROM projects WHERE id='hidden'").get();
    assert.deepEqual({ ...hidden }, { updated_at: "2000-01-01T00:00:00.000Z", updated_ms: 0 });
  });

  test(`one envelope has one time for every statement and every row (hooks=${hooks})`, async t => {
    const h = await harness(t, { hooks, fixture });
    const statements = [
      { sql: `INSERT INTO projects(id,name) VALUES(:id,:name),(:id2,:name)${RETURNING}`, params: { id: "i1", id2: "i2", name: "n" } },
      update("p1", "Renamed"),
    ];
    const { result, before, after } = await bracket(() => execute(h, statements, "now-envelope-0000001"));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const rows = result.body.results.flatMap(item => item.rows);
    assert.equal(rows.length, 3);
    const stamps = new Set(rows.map(item => item.updated_at));
    assert.equal(stamps.size, 1, JSON.stringify(rows));
    for (const [id, item] of [["i1", rows[0]], ["i2", rows[1]], ["p1", rows[2]]]) {
      const at = consistent(item, row(h, id));
      assert.ok(before <= at && at <= after);
    }
  });

  test(`a keyed replay returns the first time and writes nothing; an unkeyed repeat takes a new time (hooks=${hooks})`, async t => {
    const h = await harness(t, { hooks, fixture });
    const first = await execute(h, [update("p1", "Renamed")], "now-keyed-replay-0001");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const before = writes(h);
    await new Promise(resolve => setTimeout(resolve, 15));
    const replay = await execute(h, [update("p1", "Renamed")], "now-keyed-replay-0001");
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body.results, first.body.results);
    assert.equal(writes(h), before, "the replay writes nothing");
    const stored = row(h, "p1");
    assert.equal(stored.updated_at, first.body.results[0].rows[0].updated_at);

    await new Promise(resolve => setTimeout(resolve, 15));
    const again = await execute(h, [update("p1", "Renamed")], null);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.ok(Date.parse(again.body.results[0].rows[0].updated_at) > Date.parse(first.body.results[0].rows[0].updated_at));
    consistent(again.body.results[0].rows[0], row(h, "p1"));
  });
}

test("each statement of an interactive transaction takes the time of its own request, and a retry is the recorded reply", async t => {
  const h = await harness(t, { hooks: true, fixture });
  const begun = await h.request("a", "/v1/transactions", { mode: "write" }, null);
  assert.equal(begun.status, 201, JSON.stringify(begun.body));
  const path = `/v1/transactions/${begun.body.transactionId}`;
  const first = await bracket(() => h.request("a", `${path}/statements`, { sequence: 1, ...insert("t1") }, null));
  assert.equal(first.result.status, 200, JSON.stringify(first.result.body));
  await new Promise(resolve => setTimeout(resolve, 15));
  const command = { sequence: 2, ...update("t1", "Again") };
  const second = await bracket(() => h.request("a", `${path}/statements`, command, null));
  assert.equal(second.result.status, 200, JSON.stringify(second.result.body));
  for (const { result, before, after } of [first, second]) {
    const at = Date.parse(result.body.result.rows[0].updated_at);
    assert.ok(before <= at && at <= after, `${before} <= ${at} <= ${after}`);
    consistent(result.body.result.rows[0], result.body.result.rows[0]);
  }
  assert.ok(Date.parse(second.result.body.result.rows[0].updated_at) > Date.parse(first.result.body.result.rows[0].updated_at));
  const before = writes(h);
  assert.deepEqual((await h.request("a", `${path}/statements`, command, null)).body, second.result.body);
  assert.equal(writes(h), before, "the retry executes nothing");
  assert.equal((await h.request("a", `${path}/commit`, { sequence: 3 }, null)).status, 200);
  consistent(second.result.body.result.rows[0], row(h, "t1"));
});

test("Explain compiles with the real time, names the parameters, and never returns the value", async t => {
  const h = await harness(t, { hooks: false, fixture });
  const result = await h.request("a", "/v1/transactions:explain", { statements: [update("p1", "Renamed")] }, null);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(
    [...result.body.statements[0].serverParameters].sort(),
    ["__policysql_now_epoch_ms", "__policysql_now_rfc3339", "__policysql_now_sqlite_datetime", "__policysql_session_tenant_id"],
  );
  assert.ok(!JSON.stringify(result.body).includes(new Date().getUTCFullYear() + "-"), "no instant in the explanation");
  assert.equal(h.events.length, 0, "Explain reaches no database statement that writes");
});

test("a client cannot name, pass, assign, or send the time: every attempt is refused before the database", async t => {
  const h = await harness(t, { hooks: false, fixture });
  const body = (sql, params) => ({ statements: [{ sql, params }] });
  const send = (payload, key = null) => h.request("a", "/v1/transactions:execute", payload, key);
  const cases = [
    [body("UPDATE projects SET name=:name WHERE id=:id", { id: "p1", name: "n", __policysql_now_rfc3339: "2000-01-01T00:00:00.000Z" }), 400, "POLICYSQL_INVALID_PARAMETER"],
    [body("UPDATE projects SET name=:__policysql_now_rfc3339 WHERE id=:id", { id: "p1" }), 400, "POLICYSQL_RESERVED_PARAMETER"],
    [body("UPDATE projects SET updated_at=:t WHERE id=:id", { id: "p1", t: "2000-01-01T00:00:00.000Z" }), 403, "POLICYSQL_FORBIDDEN_COLUMN"],
    [body("INSERT INTO projects(id,name,updated_ms) VALUES(:id,:name,:t)", { id: "x", name: "x", t: "1" }), 403, "POLICYSQL_FORBIDDEN_COLUMN"],
    [{ nowMs: 0, ...body("SELECT id FROM projects", {}) }, 400, "POLICYSQL_INVALID_REQUEST"],
  ];
  for (const [payload, status, code] of cases) {
    const result = await send(payload);
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(result.body.error.code, code);
    assert.equal(h.events.length, 0);
    assert.equal(h.counts().connects, 0);
  }
  assert.equal(row(h, "p1").updated_ms, 0, "nothing was written");
});
