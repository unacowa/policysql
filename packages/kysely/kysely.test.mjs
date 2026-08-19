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
import { bindPolicyKysely, policySelect } from "./index.js";

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
