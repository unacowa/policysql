import assert from "node:assert/strict";
import test from "node:test";
import { Kysely, CamelCasePlugin, InsertResult, UpdateResult, DeleteResult, sql } from "kysely";
import { PolicySqlDialect, policyOptions } from "./index.js";
import { PolicySqlClient } from "../client/index.js";
import { mockGateway } from "../client/test-fixture.mjs";
import { createExampleClient, prepareProjectRename, renameExistingProject } from "../../examples/database-routing/client.mjs";

const setup = (t, { plugins, autoIdempotencyKey, fetchImpl, ...responseOptions } = {}) => {
  const gateway = mockGateway(responseOptions);
  const client = new PolicySqlClient({ endpoint: "https://gateway.test", token: "token", fetchImpl: fetchImpl?.(gateway) ?? gateway.fetchImpl });
  const dialect = new PolicySqlDialect({ client, autoIdempotencyKey });
  const db = new Kysely({ dialect, plugins });
  t.after(() => db.destroy());
  return { ...gateway, db, client, dialect };
};
const mutation = (db) => db.updateTable("posts").set({ title: "Updated" }).where("id", "=", "post_1");

test("standard query compilation emits named parameters without touching literal question marks", async (t) => {
  const h = setup(t);
  await h.db.selectFrom("posts").select(sql`${sql.lit("?")} || ${"suffix"}`.as("marker"))
    .where("id", "=", "post_1").limit(20).execute();
  const [item] = h.calls[0].body.statements;
  assert.equal(item.sql, 'select \'?\' || :p1 as "marker" from "posts" where "id" = :p2 limit :p3');
  assert.deepEqual(item.params, { p1: "suffix", p2: "post_1", p3: 20 });
});

test("standard query and result plugins run, including before query-specific metadata", async (t) => {
  const h = setup(t, { plugins: [new CamelCasePlugin()] });
  let raw;
  const rows = await h.db.selectFrom("posts").select(["id", "displayName"])
    .withPlugin(policyOptions({ onResponse: (response) => { raw = response; response.rows[0].id = "observer change"; } })).execute();
  assert.match(h.calls[0].body.statements[0].sql, /"display_name"/);
  assert.equal(rows[0].displayName, "Original");
  assert.equal(rows[0].id, "post_1");
  assert.equal(raw.rows[0].display_name, "Original");
  assert.equal(h.calls[0].body.statements[0].sql.includes("POLICYSQL_OPTIONS"), false);
});

for (const count of [0, 1, 3]) test(`standard mutation result classes and counts (${count})`, async (t) => {
  const h = setup(t, { affectedRows: count });
  const insert = h.db.insertInto("posts").values({ id: "post_1", title: "Title", status: "draft" });
  const update = mutation(h.db);
  const remove = h.db.deleteFrom("posts").where("id", "=", "post_1");
  const i = await insert.executeTakeFirstOrThrow();
  const u = await update.executeTakeFirstOrThrow();
  const d = await remove.executeTakeFirstOrThrow();
  assert.ok(i instanceof InsertResult);
  assert.ok(u instanceof UpdateResult);
  assert.ok(d instanceof DeleteResult);
  assert.equal(i.numInsertedOrUpdatedRows, BigInt(count));
  assert.equal(u.numUpdatedRows, BigInt(count));
  assert.equal(d.numDeletedRows, BigInt(count));
  assert.equal(i.insertId, undefined);
  for (const query of [insert, update, remove]) {
    assert.equal((await query.returning("id").executeTakeFirstOrThrow()).id, "post_1");
  }
});

test("empty standard select and TakeFirstOrThrow preserve Kysely semantics", async (t) => {
  const h = setup(t, { rows: [] });
  const query = h.db.selectFrom("posts").select("id");
  assert.equal(await query.executeTakeFirst(), undefined);
  await assert.rejects(query.executeTakeFirstOrThrow(), /no result/i);
});

test("queryId sharing, compile-only, and concurrent reexecution do not share mutable options", async (t) => {
  const h = setup(t);
  const base = h.db.updateTable("posts").set({ title: "Updated" });
  const responses = [];
  const a = base.where("id", "=", "A").withPlugin(policyOptions({ idempotencyKey: "operation-A-123456", onResponse: r => { responses.push(r); } }));
  const b = base.where("id", "=", "B").withPlugin(policyOptions({ idempotencyKey: "operation-B-123456" }));
  assert.equal(a.compile().queryId, b.compile().queryId);
  a.toOperationNode();
  // A non-executed policy query must not poison an unconfigured sibling using the same id.
  await base.where("id", "=", "plain").execute();
  await Promise.all([a.execute(), b.execute(), a.execute()]);
  assert.deepEqual(h.calls.map(c => c.headers.get("idempotency-key")), [null, "operation-A-123456", "operation-B-123456", "operation-A-123456"]);
  assert.equal(responses.length, 2);
  assert.notEqual(responses[0], responses[1]);
  const compiled = b.compile();
  await h.db.executeQuery(compiled);
  assert.equal(h.calls.at(-1).headers.get("idempotency-key"), "operation-B-123456");
  await assert.rejects(h.db.executeQuery({ ...compiled }), /must be compiled/);
});

test("options are copied and duplicate/misordered/subquery options fail before HTTP", async (t) => {
  const h = setup(t);
  const options = { idempotencyKey: "stable-operation-key", expect: { affectedRows: 1 } };
  const query = mutation(h.db).withPlugin(policyOptions(options));
  options.idempotencyKey = "changed-operation-key";
  options.expect.affectedRows = 9;
  await query.execute();
  assert.equal(h.calls[0].headers.get("idempotency-key"), "stable-operation-key");
  assert.deepEqual(h.calls[0].body.statements[0].expect, { affectedRows: 1 });
  await assert.rejects(query.withPlugin(policyOptions()).execute(), /duplicate/);
  await assert.rejects(query.withPlugin(new CamelCasePlugin()).execute(), /last query plugin/);
  const removeModifiers = {
    transformQuery: ({ node }) => ({ ...node, endModifiers: undefined }),
    transformResult: async ({ result }) => result,
  };
  await assert.rejects(query.withPlugin(removeModifiers).execute(), /last query plugin/);
  await assert.rejects(query.withPlugin({
    transformQuery: ({ node }) => JSON.parse(JSON.stringify(node)),
    transformResult: async ({ result }) => result,
  }).execute(), /last query plugin/);
  const sub = h.db.selectFrom("posts").select("id").withPlugin(policyOptions({ expect: { rowCount: 1 } })).as("p");
  await assert.rejects(h.db.selectFrom(sub).select("p.id").execute(), /executed root/);
  assert.equal(h.calls.length, 1);
});

test("automatic keys are generated per atomic execution, and explicit keys win", async (t) => {
  const h = setup(t, { autoIdempotencyKey: true });
  const query = mutation(h.db);
  query.compile();
  assert.equal(h.calls.length, 0);
  await query.execute();
  await query.execute();
  assert.notEqual(h.calls[0].headers.get("idempotency-key"), h.calls[1].headers.get("idempotency-key"));
  await query.withPlugin(policyOptions({ idempotencyKey: "explicit-operation-key" })).execute();
  assert.equal(h.calls[2].headers.get("idempotency-key"), "explicit-operation-key");
  await h.db.selectFrom("posts").select("id").execute();
  assert.equal(h.calls[3].headers.has("idempotency-key"), false);
});

test("default key omission and explicit keys do not require crypto", async (t) => {
  const h = setup(t);
  const automatic = setup(t, { autoIdempotencyKey: true });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try {
    await mutation(h.db).execute();
    await mutation(automatic.db).withPlugin(policyOptions({ idempotencyKey: "explicit-operation-key" })).execute();
    await assert.rejects(mutation(automatic.db).execute(), /crypto.randomUUID/);
  } finally { Object.defineProperty(globalThis, "crypto", descriptor); }
});

test("callback transaction awaits real results, retains plugins, and returns after commit", async (t) => {
  const h = setup(t, { plugins: [new CamelCasePlugin()], autoIdempotencyKey: true });
  const id = await h.db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("posts").select(["id", "displayName", "status"]).executeTakeFirstOrThrow();
    assert.equal(row.displayName, "Original");
    const result = await mutation(trx).withPlugin(policyOptions({ expect: { affectedRows: 1 } })).executeTakeFirstOrThrow();
    assert.equal(result.numUpdatedRows, 1n);
    return row.id;
  });
  assert.equal(id, "post_1");
  assert.deepEqual(h.calls.map(c => c.path.split("/").at(-1)), ["transactions", "statements", "statements", "commit"]);
  assert.deepEqual(h.calls.map(c => c.body.sequence), [undefined, 1, 2, 3]);
  assert.ok(h.calls.every(c => !c.headers.has("idempotency-key")));
  assert.deepEqual(h.calls[2].body.expect, { affectedRows: 1 });
});

test("callback application error rolls back once and preserves the error", async (t) => {
  const h = setup(t);
  const expected = new Error("application decision");
  let count = 0;
  await assert.rejects(h.db.transaction().execute(async trx => { count++; await mutation(trx).execute(); throw expected; }), e => e === expected);
  assert.equal(count, 1);
  assert.equal(h.calls.at(-1).path.split("/").at(-1), "rollback");
});

test("controlled read transaction, explicit rollback, and unsupported features", async (t) => {
  const h = setup(t, { autoIdempotencyKey: true });
  const trx = await h.db.startTransaction().setAccessMode("read only").execute();
  assert.equal(h.calls[0].body.mode, "read");
  await assert.rejects(mutation(trx).execute(), /read-only/);
  await assert.rejects(trx.selectFrom("posts").select("id").withPlugin(policyOptions({ idempotencyKey: "explicit-operation-key" })).execute(), /inside transactions/);
  await assert.rejects(trx.savepoint("a").execute(), /not supported/);
  assert.throws(() => trx.transaction(), /does not support|not supported/i);
  await trx.selectFrom("posts").select("id").execute();
  await trx.rollback().execute();
  assert.equal(trx.isRolledBack, true);
  await assert.rejects(trx.selectFrom("posts").select("id").execute());
  assert.equal(h.calls.length, 3);
  await assert.rejects(h.db.startTransaction().setIsolationLevel("serializable").execute(), /isolation/);
  await assert.rejects(h.db.schema.createTable("forbidden").addColumn("id", "text").execute(), /unsupported/);
  assert.throws(() => h.db.introspection, /introspection/);
  await assert.rejects(sql`select 1`.execute(h.db), /unsupported/);
  await assert.rejects(async () => { for await (const row of h.db.selectFrom("posts").select("id").stream()) void row; }, /streaming/);
  assert.equal(h.calls.length, 3);
});

test("parallel transactions use independent owners while their queries stay sequential", async (t) => {
  const h = setup(t);
  await Promise.all([1, 2].map(() => h.db.transaction().execute(async trx => {
    await Promise.all([mutation(trx).execute(), mutation(trx).execute()]);
  })));
  assert.equal(h.transactions.size, 2);
  for (const [id, tx] of h.transactions) {
    assert.equal(tx.status, "committed");
    assert.deepEqual(h.calls.filter(c => c.path.includes(id)).map(c => c.body.sequence), [1, 2, 3]);
  }
});

test("unknown callback commit is not converted to rollback or callback replay", async (t) => {
  const h = setup(t, { fetchImpl: gateway => async (url, init) => {
    const response = await gateway.fetchImpl(url, init);
    if (new URL(url).pathname.endsWith("/commit")) throw new Error("lost commit");
    return response;
  } });
  let calls = 0;
  await assert.rejects(h.db.transaction().execute(async trx => { calls++; await mutation(trx).execute(); }), { code: "POLICYSQL_OUTCOME_UNKNOWN", phase: "commit" });
  assert.equal(calls, 1);
  assert.equal(h.calls.some(c => c.path.endsWith("/rollback")), false);
});

for (const outcome of ["confirmed", "recovered", "unknown"]) test(`destroy during callback commit preserves its ${outcome} outcome`, async (t) => {
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let attempts = 0;
  const h = setup(t, { fetchImpl: gateway => async (url, init) => {
    const response = await gateway.fetchImpl(url, init);
    if (new URL(url).pathname.endsWith("/commit")) {
      attempts++;
      entered.resolve();
      await resume.promise;
      if (outcome === "unknown" || (outcome === "recovered" && attempts === 1)) throw new Error("lost commit");
    }
    return response;
  } });
  let callbacks = 0;
  const operation = h.db.transaction().execute(async trx => {
    callbacks++;
    await mutation(trx).execute();
    return "saved";
  });
  const checked = outcome === "unknown"
    ? assert.rejects(operation, error => {
      assert.equal(error.code, "POLICYSQL_OUTCOME_UNKNOWN");
      assert.equal(error.phase, "commit");
      assert.equal(error.transactionId, [...h.transactions.keys()][0]);
      assert.equal(error.sequence, 2);
      return true;
    })
    : operation.then(result => assert.equal(result, "saved"));
  await entered.promise;
  let destroyed = false;
  const shutdown = h.db.destroy().then(() => { destroyed = true; });
  try {
    const calls = h.calls.length;
    await assert.rejects(mutation(h.db).execute());
    assert.equal(h.calls.length, calls);
    assert.equal(destroyed, false);
  } finally { resume.resolve(); }
  await Promise.all([checked, shutdown]);
  assert.equal(callbacks, 1);
  assert.equal([...h.transactions.values()][0].status, "committed");
  assert.equal(attempts, outcome === "confirmed" ? 1 : 2);
  const commits = h.calls.filter(c => c.path.endsWith("/commit"));
  assert.ok(commits.every(c => c.path === commits[0].path && c.text === commits[0].text));
  assert.equal(h.calls.filter(c => c.path.endsWith("/statements")).length, 1);
  assert.equal(h.calls.some(c => c.path.endsWith("/rollback")), false);
});

test("callback error survives a rollback already completed by destroy", async (t) => {
  const h = setup(t);
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const expected = new Error("application decision during shutdown");
  const checked = assert.rejects(h.db.transaction().execute(async trx => {
    await mutation(trx).execute();
    entered.resolve();
    await resume.promise;
    throw expected;
  }), error => error === expected);
  await entered.promise;
  try { await h.db.destroy(); }
  finally { resume.resolve(); }
  await checked;
  assert.equal([...h.transactions.values()][0].status, "rolled_back");
  assert.deepEqual(h.calls.map(c => c.path.split("/").at(-1)), ["transactions", "statements", "rollback"]);
});

test("controlled unknown commit can be confirmed by calling commit again", async (t) => {
  let drop = true;
  const h = setup(t, { fetchImpl: gateway => async (url, init) => {
    const response = await gateway.fetchImpl(url, init);
    if (new URL(url).pathname.endsWith("/commit") && drop) throw new Error("lost commit");
    return response;
  } });
  const trx = await h.db.startTransaction().execute();
  await mutation(trx).execute();
  await assert.rejects(trx.commit().execute(), { code: "POLICYSQL_OUTCOME_UNKNOWN" });
  assert.equal(trx.isCommitted, false);
  drop = false;
  await trx.commit().execute();
  assert.equal(trx.isCommitted, true);
  assert.ok(h.calls.filter(c => c.path.endsWith("/commit")).every(c => c.body.sequence === 2));
});

test("destroy rolls back an abandoned active controlled transaction", async (t) => {
  const h = setup(t);
  const trx = await h.db.startTransaction().execute();
  await h.db.destroy();
  assert.equal(h.calls.at(-1).path.split("/").at(-1), "rollback");
  const calls = h.calls.length;
  await assert.rejects(trx.commit().execute(), { code: "POLICYSQL_TRANSACTION_UNAVAILABLE" });
  await assert.rejects(mutation(trx).execute(), { code: "POLICYSQL_TRANSACTION_UNAVAILABLE" });
  await trx.rollback().execute();
  assert.equal(trx.isRolledBack, true);
  assert.equal(h.calls.length, calls);
});

test("invalid configuration and options are rejected without I/O", async (t) => {
  const h = setup(t);
  for (const autoIdempotencyKey of [null, 0, "false"]) assert.throws(() => new PolicySqlDialect({ client: h.client, autoIdempotencyKey }), /boolean/);
  for (const options of [{ idempotencyKey: null }, { idempotencyKey: "short" }, { expect: {} }, { unknown: 1 }, { onResponse: 1 }]) assert.throws(() => policyOptions(options), TypeError);
  assert.equal(h.calls.length, 0);
});

test("sample uses standard APIs and retains the key across atomic resends", async (t) => {
  const h = mockGateway();
  const db = createExampleClient({ endpoint: "https://gateway.test", token: "token", fetchImpl: h.fetchImpl });
  t.after(() => db.destroy());
  const rename = prepareProjectRename(db, { id: "post_1", name: "Updated" });
  await rename.send();
  await rename.send();
  assert.equal(h.calls[0].headers.get("idempotency-key"), rename.idempotencyKey);
  assert.equal(h.calls[0].text, h.calls[1].text);
  await renameExistingProject(db, { id: "post_1", name: "Again" });
  assert.ok(h.calls.slice(2).every(c => !c.headers.has("idempotency-key")));
});

test("destroy during begin closes the newly allocated transaction and never runs a callback", async (t) => {
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const h = setup(t, { fetchImpl: gateway => async (url, init) => {
    const response = await gateway.fetchImpl(url, init);
    if (new URL(url).pathname === "/v1/transactions") { entered.resolve(); await resume.promise; }
    return response;
  } });
  let callbacks = 0;
  const started = assert.rejects(h.db.transaction().execute(async () => { callbacks++; }), { code: "POLICYSQL_TRANSACTION_UNAVAILABLE" });
  await entered.promise;
  const destroyed = h.db.destroy();
  resume.resolve();
  await Promise.all([started, destroyed]);
  assert.equal(callbacks, 0);
  assert.equal([...h.transactions.values()][0].status, "rolled_back");
  assert.deepEqual(h.calls.map(c => c.path.split("/").at(-1)), ["transactions", "rollback"]);
});

test("failed controlled begin does not poison subsequent connections or destroy", async (t) => {
  let fail = true;
  const h = setup(t, { fetchImpl: gateway => async (url, init) => {
    if (fail) return Response.json({ error: { code: "POLICYSQL_STALE_OPERATION" } }, { status: 409 });
    return gateway.fetchImpl(url, init);
  } });
  await assert.rejects(h.db.startTransaction().execute(), { code: "POLICYSQL_STALE_OPERATION" });
  fail = false;
  await h.db.transaction().execute(trx => mutation(trx).execute());
  await h.db.destroy();
  assert.equal(h.transactions.size, 1);
  assert.equal([...h.transactions.values()][0].status, "committed");
});

test("observer and result plugin errors do not replay committed mutations", async (t) => {
  for (const kind of ["observer", "plugin"]) {
    const error = new Error(kind);
    const h = setup(t, { plugins: kind === "plugin" ? [{
      transformQuery: ({ node }) => node,
      transformResult: async () => { throw error; },
    }] : [] });
    const query = mutation(h.db).withPlugin(policyOptions({ onResponse: kind === "observer" ? () => { throw error; } : undefined }));
    await assert.rejects(query.execute(), caught => caught === error);
    assert.equal(h.calls.length, 1);
  }
});

test("missing mutation count is not silently converted to zero", async (t) => {
  const h = setup(t, { fetchImpl: gateway => async (url, init) => {
    const response = await gateway.fetchImpl(url, init);
    const body = await response.json();
    delete body.results[0].affectedRows;
    return Response.json(body);
  } });
  await assert.rejects(mutation(h.db).execute(), /affectedRows/);
  assert.equal(h.calls.length, 1);
});

test("an observer awaiting the same transaction is bounded instead of holding the connection forever", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const h = setup(t);
  const entered = Promise.withResolvers();
  const trx = await h.db.startTransaction().execute();
  const rejected = assert.rejects(mutation(trx).withPlugin(policyOptions({ onResponse: async () => {
    entered.resolve();
    await trx.selectFrom("posts").select("id").execute();
  } })).execute(), { code: "POLICYSQL_OBSERVER_TIMEOUT" });
  await entered.promise;
  t.mock.timers.tick(4_001);
  await rejected;
  await h.db.destroy();
  assert.deepEqual(h.calls.map(c => c.body.sequence), [undefined, 1]);
});
