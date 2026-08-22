import assert from "node:assert/strict";
import test from "node:test";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";
import {
  bindPolicyKysely,
  compilePolicyQuery,
  createPolicyKysely,
  policyMutation,
  policySelect,
} from "./index.js";

class TestSqliteDialect {
  createAdapter() { return new SqliteAdapter(); }
  createDriver() { return new DummyDriver(); }
  createIntrospector(db) { return new SqliteIntrospector(db); }
  createQueryCompiler() { return new SqliteQueryCompiler(); }
}

test("Kysely boundary compiles operation nodes directly to named parameters", async () => {
  let captured;
  const client = {
    async execute(sql, params) {
      captured = { sql, params };
      return { rows: [{ id: "1" }], meta: {}, envelopeMeta: {} };
    },
  };
  const db = new Kysely({ dialect: new TestSqliteDialect() });
  const query = db
    .selectFrom("posts")
    .select("id")
    .where("status", "=", "published")
    .limit(20);
  assert.deepEqual(await policySelect(query, "posts", [], client).execute(), [{ id: "1" }]);
  assert.deepEqual(captured, {
    sql: 'select "id" from "posts" where "status" = :p1 limit :p2',
    params: { p1: "published", p2: 20 },
  });
  await db.destroy();
});

test("question marks in SQL literals are never mistaken for placeholders", async () => {
  let captured;
  const client = {
    async execute(statement, params) {
      captured = { sql: statement, params };
      return { rows: [], meta: {}, envelopeMeta: {} };
    },
  };
  const db = new Kysely({ dialect: new TestSqliteDialect() });
  const query = db
    .selectFrom("posts")
    .select(sql`coalesce(${sql.lit("?")}, ${"fallback"})`.as("marker"));
  await policySelect(query, "posts", [], client).execute();
  assert.match(captured.sql, /coalesce\('\?', :p1\)/);
  assert.deepEqual(captured.params, { p1: "fallback" });
  await db.destroy();
});

test("parameterized precompiled text is rejected because syntax boundaries are unavailable", () => {
  const query = {
    compile: () => ({ sql: "select '?' as marker, ? as value", parameters: [1] }),
  };
  const client = { async execute() { throw new Error("must not execute"); } };
  assert.throws(
    () => policySelect(query, "posts", [], client),
    /must expose Kysely toOperationNode/,
  );
});

test("bound Kysely builder chains retain the PolicySQL client", async () => {
  const client = { async execute() { return { rows: [{ value: 1 }], meta: {}, envelopeMeta: {} }; } };
  const terminal = { compile: () => ({ sql: "select 1 as value", parameters: [] }) };
  const policyDb = bindPolicyKysely({ selectFrom: () => ({ select: () => terminal }) }, client);
  const query = policyDb.selectFrom("posts").select(["id"]);
  assert.deepEqual(await policySelect(query, "posts").execute(), [{ value: 1 }]);
});

test("bound Kysely execute routes selects directly through PolicySQL", async () => {
  let captured;
  const client = {
    async execute(sql, params, options) {
      captured = { sql, params, options };
      return { rows: [{ id: "post_1" }], meta: { operation: "select" }, envelopeMeta: {} };
    },
  };
  const rawDb = new Kysely({ dialect: new TestSqliteDialect() });
  const db = createPolicyKysely({ kysely: rawDb, client });
  const rows = await db.selectFrom("posts").select("id").where("id", "=", "post_1").execute();
  assert.deepEqual(rows, [{ id: "post_1" }]);
  assert.deepEqual(captured, {
    sql: 'select "id" from "posts" where "id" = :p1',
    params: { p1: "post_1" },
    options: {},
  });
  await rawDb.destroy();
});

test("bound Kysely execute routes returning mutations with idempotency", async () => {
  const events = [];
  let captured;
  const client = {
    async execute(sql, params, options) {
      captured = { sql, params, options };
      return { rows: [{ id: "post_2" }], meta: { operation: "insert" }, envelopeMeta: {} };
    },
  };
  const rawDb = new Kysely({ dialect: new TestSqliteDialect() });
  const db = createPolicyKysely({
    kysely: rawDb,
    client,
    onQuery: (request) => events.push(["query", request.operation]),
    onResult: ({ request }) => events.push(["result", request.operation]),
  });
  const rows = await db
    .insertInto("posts")
    .values({ id: "post_2", title: "Mutation" })
    .returning("id")
    .execute();
  assert.deepEqual(rows, [{ id: "post_2" }]);
  assert.equal(captured.sql, 'insert into "posts" ("id", "title") values (:p1, :p2) returning "id"');
  assert.deepEqual(captured.params, { p1: "post_2", p2: "Mutation" });
  assert.equal(typeof captured.options.idempotencyKey, "string");
  assert.deepEqual(events, [["query", "insert"], ["result", "insert"]]);
  await rawDb.destroy();
});

test("policyMutation supports update and delete with caller execution options", async () => {
  const calls = [];
  const client = {
    async execute(sql, params, options) {
      calls.push({ sql, params, options });
      return { rows: [{ id: "post_3" }], meta: {}, envelopeMeta: {} };
    },
  };
  const db = new Kysely({ dialect: new TestSqliteDialect() });
  const update = db.updateTable("posts").set({ title: "Updated" }).where("id", "=", "post_3").returning("id");
  const remove = db.deleteFrom("posts").where("id", "=", "post_3").returning("id");
  assert.equal(compilePolicyQuery(update).operation, "update");
  assert.equal(compilePolicyQuery(remove).operation, "delete");
  await policyMutation(update, { idempotencyKey: "update-post-3", expect: { affectedRows: 1 } }, client).execute();
  await policyMutation(remove, { idempotencyKey: "delete-post-3" }, client).execute();
  assert.equal(calls[0].options.idempotencyKey, "update-post-3");
  assert.deepEqual(calls[0].options.expect, { affectedRows: 1 });
  assert.equal(calls[1].options.idempotencyKey, "delete-post-3");
  await db.destroy();
});

test("executeTakeFirst helpers use PolicySQL rows", async () => {
  const client = { async execute() { return { rows: [{ id: "one" }], meta: {}, envelopeMeta: {} }; } };
  const rawDb = new Kysely({ dialect: new TestSqliteDialect() });
  const db = bindPolicyKysely(rawDb, client);
  assert.deepEqual(await db.selectFrom("posts").select("id").executeTakeFirst(), { id: "one" });
  assert.deepEqual(await db.selectFrom("posts").select("id").executeTakeFirstOrThrow(), { id: "one" });
  await rawDb.destroy();
});
