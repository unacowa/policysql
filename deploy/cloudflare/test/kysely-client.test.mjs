import assert from "node:assert/strict";
import test from "node:test";
import { Kysely, CamelCasePlugin } from "kysely";
import { PolicySqlClient, createHttpTransport } from "../../../packages/client/index.js";
import { PolicySqlDialect, policyOptions } from "../../../packages/kysely/index.js";
import { harness } from "./helpers/routing.mjs";

// The wrapper's authentication is out of scope here; each request carries the trusted
// session the wrapper would pass (ADR 0019).
const makeClient = async (t, h, { tenant = "a", session, autoIdempotencyKey, plugins, wrapFetch = f => f, ...options } = {}) => {
  const requests = [];
  const trusted = session ?? h.session(tenant);
  const fetchImpl = wrapFetch(async (url, init) => {
    requests.push({ path: new URL(url).pathname, body: JSON.parse(init.body), headers: new Headers(init.headers) });
    return h.app.fetch(new Request(url, init), { database: h.binding(tenant), session: trusted }, h.background);
  });
  const transport = createHttpTransport({ endpoint: "https://worker.test", fetchImpl });
  const client = new PolicySqlClient({ transport, ...options });
  const db = new Kysely({ dialect: new PolicySqlDialect({ client, autoIdempotencyKey }), plugins });
  t.after(() => db.destroy());
  return { client, db, requests };
};
const read = db => db.selectFrom("projects").select(["id", "name"]).orderBy("id");
const update = (db, name = "Updated") => db.updateTable("projects").set({ name }).where("id", "=", "seed");
const versions = { schemaVersion: "schema_routing_1", policyVersion: "policy_routing_1" };

test("minimal client and default/explicit roles are enforced by the trusted session + Wasm + SQLite", async (t) => {
  const h = await harness(t, { hooks: false, customizePolicy: policy => policy.replace("      member:", `      reader:
        select:
          columns: [id]
          filter: { id: { eq: nonexistent } }
          limit: 10
      member:`) });
  const session = h.session("a", { roles: ["member", "reader"], access: ["execute"] });
  const normal = await makeClient(t, h, { session });
  assert.deepEqual(await read(normal.db).execute(), [{ id: "seed", name: "database_a" }]);
  assert.equal(normal.requests.length, 1);
  assert.equal(normal.requests[0].headers.has("policysql-role"), false);
  assert.equal(Object.hasOwn(normal.requests[0].body, "expected"), false);
  const restricted = await makeClient(t, h, { session, role: "reader" });
  assert.deepEqual(await restricted.db.selectFrom("projects").select("id").execute(), []);
  await assert.rejects(read(restricted.db).execute());
  const before = h.events.length;
  const forbidden = await makeClient(t, h, { session, role: "admin" });
  await assert.rejects(read(forbidden.db).execute(), { status: 403 });
  assert.equal(h.events.length, before);
});

test("optional and explicit version preconditions match or fail before atomic/begin DB operations", async (t) => {
  const h = await harness(t, { hooks: false });
  for (const options of [{}, versions]) {
    const { db } = await makeClient(t, h, options);
    assert.equal((await read(db).execute()).length, 1);
    await db.transaction().execute(async trx => { assert.equal((await read(trx).execute()).length, 1); });
  }
  await h.flush();
  for (const options of [{ ...versions, schemaVersion: "old" }, { ...versions, policyVersion: "old" }]) {
    const { db, requests } = await makeClient(t, h, options);
    const count = h.counts().connects;
    await assert.rejects(read(db).execute(), { code: "POLICYSQL_STALE_OPERATION" });
    await assert.rejects(db.startTransaction().execute(), { code: "POLICYSQL_STALE_OPERATION" });
    assert.equal(h.counts().connects, count);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(r => r.body.expected));
  }
});

for (const hooks of [false, true]) test(`atomic expect, no-table omission, and commit callbacks (hooks=${hooks})`, async (t) => {
  const h = await harness(t, { hooks, idempotencyTable: false });
  const { db } = await makeClient(t, h);
  assert.equal((await update(db).executeTakeFirstOrThrow()).numUpdatedRows, 1n);
  assert.equal(h.rows("a")[0].name, "Updated");
  if (hooks) {
    assert.ok(h.hooksSeen.length > 0);
    assert.equal(h.hooksSeen[0].result.rows[0].name, "Updated");
  }
  await assert.rejects(update(db, "Must rollback").withPlugin(policyOptions({ expect: { affectedRows: 2 } })).execute());
  assert.equal(h.rows("a")[0].name, "Updated");
  assert.equal(h.events.some(e => e.sql.includes("policysql_idempotency")), false);
  await assert.rejects(update(db, "Key needs table").withPlugin(policyOptions({ idempotencyKey: "key-needs-table-123" })).execute());
  assert.equal(h.rows("a")[0].name, "Updated");
});

for (const hooks of [false, true]) test(`explicit atomic key deduplicates actual SQL and rejects changed payload (hooks=${hooks})`, async (t) => {
  const h = await harness(t, { hooks });
  const { db } = await makeClient(t, h);
  const operation = db.insertInto("projects").values({ id: "created", name: "Created" }).returning(["id", "name"])
    .withPlugin(policyOptions({ idempotencyKey: "create-project-123456" }));
  assert.deepEqual(await operation.execute(), [{ id: "created", name: "Created" }]);
  assert.deepEqual(await operation.execute(), [{ id: "created", name: "Created" }]);
  assert.equal(h.rows("a").filter(row => row.id === "created").length, 1);
  await assert.rejects(update(db).withPlugin(policyOptions({ idempotencyKey: "create-project-123456" })).execute(), { status: 409 });
});

test("callback and controlled transactions share owner/DB, support checks, and need no idempotency table", async (t) => {
  const h = await harness(t, { idempotencyTable: false });
  const { db, requests } = await makeClient(t, h, { autoIdempotencyKey: true });
  const result = await db.transaction().execute(async trx => {
    const row = await read(trx).executeTakeFirstOrThrow();
    await update(trx, row.name + " changed").withPlugin(policyOptions({ expect: { affectedRows: 1 } })).execute();
    return row.id;
  });
  assert.equal(result, "seed");
  assert.equal(h.rows("a")[0].name, "database_a changed");
  assert.equal(h.hooksSeen[0].result.rows[0].name, "database_a changed");
  const id = requests[1].path.split("/")[3];
  assert.ok(requests.slice(1).every(r => r.path.includes(id)));
  const trx = await db.startTransaction().execute();
  await update(trx, "Undo").execute();
  await trx.rollback().execute();
  assert.equal(h.rows("a")[0].name, "database_a changed");
  assert.ok(requests.every(r => !r.headers.has("idempotency-key")));
  assert.equal(h.events.some(e => e.sql.includes("policysql_idempotency")), false);
});

test("read-only mutations retain the Server rejection without executing SQL", async t => {
  const h = await harness(t, { hooks: false });
  const { db, requests } = await makeClient(t, h);
  await assert.rejects(db.transaction().setAccessMode("read only").execute(trx => update(trx).execute()), error => {
    assert.equal(error.code, "POLICYSQL_TRANSACTION_MODE_VIOLATION");
    assert.equal(error.status, 403);
    assert.equal(error.message, error.response.body.error.message);
    assert.equal(error.response.body.error.code, error.code);
    return true;
  });
  assert.deepEqual(requests.map(r => r.path.split("/").at(-1)), ["transactions", "statements"]);
  assert.equal(h.rows("a")[0].name, "database_a");
  assert.equal(h.events.filter(e => /^UPDATE\b/i.test(e.sql)).length, 0);
});

test("callback error and validator denial roll back actual writes", async (t) => {
  const h = await harness(t, { idempotencyTable: false });
  const { db } = await makeClient(t, h);
  const expected = new Error("application rejected");
  await assert.rejects(db.transaction().execute(async trx => { await update(trx).execute(); throw expected; }), error => error === expected);
  assert.equal(h.rows("a")[0].name, "database_a");
  h.setValidator(async () => false);
  await assert.rejects(db.transaction().execute(trx => update(trx).execute()));
  assert.equal(h.rows("a")[0].name, "database_a");
});

test("lost begin response is not retried and a caller may explicitly start again", async (t) => {
  const h = await harness(t, { hooks: false });
  let dropped = false;
  const { db, requests } = await makeClient(t, h, { wrapFetch: send => async (url, init) => {
    const response = await send(url, init);
    if (new URL(url).pathname === "/v1/transactions" && !dropped) { dropped = true; throw new Error("lost begin"); }
    return response;
  } });
  let callbacks = 0;
  await assert.rejects(db.transaction().setAccessMode("read only").execute(async () => { callbacks++; }), { phase: "begin", code: "POLICYSQL_OUTCOME_UNKNOWN" });
  assert.equal(callbacks, 0);
  assert.equal(h.ownerNames().length, 1);
  await db.transaction().setAccessMode("read only").execute(async trx => { callbacks++; await read(trx).execute(); });
  assert.equal(callbacks, 1);
  assert.equal(h.ownerNames().length, 2);
  const unused = h.ownerNames()[0];
  assert.equal((await h.ownerRecord(unused)).statementCount, 0);
  assert.equal(await h.fireTimer(unused), true, "the unused owner's expiry timer is pending");
  assert.equal((await h.ownerRecord(unused)).status, "expired");
  assert.ok(requests.every(r => !r.headers.has("idempotency-key")));
});

test("explicit confirmation of lost responses replays DO commands without repeating SQL", async (t) => {
  const h = await harness(t, { hooks: false });
  const lost = new Set();
  const { client, requests } = await makeClient(t, h, { wrapFetch: send => async (url, init) => {
    const response = await send(url, init);
    const path = new URL(url).pathname;
    if (/\/(statements|commit)$/.test(path) && !lost.has(path)) { lost.add(path); throw new Error("response lost"); }
    return response;
  } });
  const tx = await client.beginTransaction();
  await assert.rejects(tx.execute("UPDATE projects SET name = :name WHERE id = :id", { name: "Updated", id: "seed" }), { phase: "statement" });
  assert.equal(requests.length, 2);
  await tx.retryPending();
  await assert.rejects(tx.commit(), { phase: "commit" });
  assert.equal(requests.length, 4);
  await tx.commit();
  assert.equal(h.rows("a")[0].name, "Updated");
  assert.equal(h.events.filter(e => /^UPDATE\b/i.test(e.sql)).length, 1);
  assert.deepEqual(requests.map(r => r.body.sequence), [undefined, 1, 1, 2, 2]);
});

for (const outcome of ["unknown", "rejected"]) test(`destroy preserves an actual DO commit's ${outcome} outcome`, async (t) => {
  const h = await harness(t, { hooks: outcome === "rejected" });
  if (outcome === "rejected") h.setValidator(async () => false);
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const { db, requests } = await makeClient(t, h, { wrapFetch: send => async (url, init) => {
    const response = await send(url, init);
    if (new URL(url).pathname.endsWith("/commit")) {
      entered.resolve();
      await resume.promise;
      if (outcome === "unknown") throw new Error("lost commit");
    }
    return response;
  } });
  let callbacks = 0;
  const checked = assert.rejects(db.transaction().execute(async trx => {
    callbacks++;
    await update(trx).execute();
  }), error => {
    if (outcome === "unknown") {
      assert.equal(error.code, "POLICYSQL_OUTCOME_UNKNOWN");
      assert.equal(error.phase, "commit");
      assert.equal(error.transactionId, requests[1].path.split("/")[3]);
      assert.equal(error.sequence, 2);
    } else {
      assert.equal(error.code, "POLICYSQL_COMMIT_CHECK_REJECTED");
      assert.equal(error.status, 409);
    }
    return true;
  });
  await entered.promise;
  const shutdown = db.destroy();
  resume.resolve();
  await Promise.all([checked, shutdown]);
  await h.flush();
  assert.equal(callbacks, 1);
  assert.equal(h.rows("a")[0].name, outcome === "unknown" ? "Updated" : "database_a");
  assert.equal(h.events.filter(e => /^UPDATE\b/i.test(e.sql)).length, 1);
  assert.equal(h.ownerNames().length, 1);
  assert.deepEqual(requests.map(r => r.body.sequence), [undefined, 1, 2]);
  assert.equal(requests.some(r => r.path.endsWith("/rollback")), false);
});

test("interactive statement limit and revoked DB binding prevent commit", async (t) => {
  const h = await harness(t, { hooks: false });
  const { db } = await makeClient(t, h);
  await assert.rejects(db.transaction().execute(async trx => { for (let i = 0; i < 9; i++) await read(trx).execute(); }), { code: "POLICYSQL_TRANSACTION_LIMIT_EXCEEDED" });
  const trx = await db.startTransaction().execute();
  await update(trx).execute();
  h.env.TENANT_A_ENABLED = "false";
  await assert.rejects(trx.commit().execute());
  // Revocation is detected before forwarding; the owner still expires its uncommitted DB transaction.
  for (const name of h.ownerNames()) await h.fireTimer(name);
  assert.equal(h.rows("a")[0].name, "database_a");
});

test("snapshot change during an interactive transaction rejects commit and rolls back", async (t) => {
  const h = await harness(t, { hooks: false });
  const { db, requests } = await makeClient(t, h);
  const trx = await db.startTransaction().execute();
  await update(trx).execute();
  const id = requests[1].path.split("/")[3];
  h.ownerCore(id).getRuntime = () => ({ snapshot: "changed" });
  await assert.rejects(trx.commit().execute());
  assert.equal(trx.isCommitted, false);
  assert.equal(h.rows("a")[0].name, "database_a");
});

test("owner loss never reconnects, replays the callback, or reports commit success", async (t) => {
  const h = await harness(t, { hooks: false });
  const { db } = await makeClient(t, h);
  let callbacks = 0;
  let connects;
  await assert.rejects(db.transaction().setAccessMode("read only").execute(async trx => {
    callbacks++;
    await read(trx).execute();
    connects = h.counts().connects;
    h.loseOwner(h.ownerNames()[0]);
    await read(trx).execute();
  }), { code: "POLICYSQL_TRANSACTION_UNAVAILABLE" });
  assert.equal(callbacks, 1);
  assert.equal(h.counts().connects, connects);
  assert.equal(h.ownerNames().length, 1);
});

test("interactive cumulative result bytes are bounded and roll back earlier writes", async (t) => {
  const h = await harness(t, { hooks: false });
  const { db } = await makeClient(t, h);
  // Each result fits the statement limit; their total exceeds the owner's 64,000 bytes.
  h.databases.get("a").database.prepare("UPDATE projects SET name = ? WHERE id = 'seed'").run("x".repeat(33_000));
  await assert.rejects(db.transaction().execute(async trx => {
    await read(trx).execute();
    await update(trx, "y".repeat(33_000)).execute();
    await read(trx).execute();
  }), { code: "POLICYSQL_TRANSACTION_LIMIT_EXCEEDED" });
  assert.equal(h.rows("a")[0].name, "x".repeat(33_000));
});

test("server expiry after a statement rolls back without creating a replacement transaction", async (t) => {
  const h = await harness(t, { hooks: false });
  const { db } = await makeClient(t, h);
  await assert.rejects(db.transaction().execute(async trx => {
    await update(trx).execute();
    await h.fireTimer(h.ownerNames()[0]);
    await read(trx).execute();
  }), { code: "POLICYSQL_TRANSACTION_UNAVAILABLE" });
  assert.equal(h.rows("a")[0].name, "database_a");
  assert.equal(h.ownerNames().length, 1);
});

test("raw redaction metadata retains row/column correspondence before result plugins", async (t) => {
  const h = await harness(t, { hooks: false, customizePolicy: policy => policy.replace(
    "          columns: [id, name]",
    "          columns:\n            - id\n            - name: name\n              visible_if: { id: { eq: a_visible } }\n              on_deny: null",
  ) });
  h.databases.get("a").database.prepare("INSERT INTO projects VALUES (?, ?, ?)").run("a_visible", "tenant_a", "Visible");
  const reverse = {
    transformQuery: ({ node }) => node,
    transformResult: async ({ result }) => ({ ...result, rows: [...result.rows].reverse() }),
  };
  const { db } = await makeClient(t, h, { plugins: [new CamelCasePlugin(), reverse] });
  let raw;
  const rows = await db.selectFrom("projects").select(["id", "name as displayName"]).orderBy("id")
    .withPlugin(policyOptions({ onResponse: response => { raw = response; } })).execute();
  assert.deepEqual(raw.rows, [{ id: "a_visible", display_name: "Visible" }, { id: "seed", display_name: null }]);
  assert.deepEqual(raw.meta.result.redactions, [{ row: 1, column: "display_name", code: "POLICY_REDACTED" }]);
  assert.deepEqual(rows, [{ id: "seed", displayName: null }, { id: "a_visible", displayName: "Visible" }]);
});
