import { harness } from "./helpers/routing.mjs";
import assert from "node:assert/strict";
import test from "node:test";

// Regression (#39): client SQL string literals are bound with quotes and ''
// escapes removed. Runs the real WASM, JWT and Turso HTTP transport against SQLite.
const execute = (h, tenant, statements, key) =>
  h.request(tenant, "/v1/transactions:execute", { statements }, key);

test("SELECT string literals match the stored row through the HTTP transport", async (t) => {
  const h = await harness(t, { hooks: false });
  for (const [sql, rows] of [
    ["SELECT id, name FROM projects WHERE id = 'seed'", [{ id: "seed", name: "database_a" }]],
    ["SELECT id, name FROM projects WHERE id LIKE 'se%'", [{ id: "seed", name: "database_a" }]],
    ["SELECT id, name FROM projects WHERE id IN ('seed', 'it''s')", [{ id: "seed", name: "database_a" }]],
    ["SELECT id, name FROM projects WHERE name > 'database_'", [{ id: "seed", name: "database_a" }]],
    ["SELECT id, name FROM projects WHERE id != 'seed'", []],
    ["SELECT id, name FROM projects WHERE id = '''seed'''", []],
    ["SELECT id, name FROM projects WHERE id = 'hidden'", []],
  ]) {
    const response = await execute(h, "a", [{ sql, params: {} }], null);
    assert.equal(response.status, 200, `${sql}: ${JSON.stringify(response.body)}`);
    assert.deepEqual(response.body.results[0].rows, rows, sql);
  }
  const literal = h.events.find((event) => event.sql.startsWith("SELECT") && event.args.some(({ name }) => name.includes("__policysql_literal_")));
  assert.ok(literal, "string literals travel as server-owned parameters");
  assert.ok(literal.args.every(({ value }) => !(value.type === "text" && value.value === "'seed'")), "no raw token is bound");
});

test("UPDATE with string literals affects the decoded row only", async (t) => {
  const h = await harness(t, { hooks: false });
  const update = await execute(h, "a", [{
    sql: "UPDATE projects SET name = 'it''s' WHERE id = 'seed' RETURNING id, name",
    params: {}, expect: { affectedRows: 1 },
  }], "string-literal-update-1");
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.equal(update.body.results[0].affectedRows, 1);
  assert.deepEqual(update.body.results[0].rows, [{ id: "seed", name: "it's" }]);
  assert.deepEqual(h.rows("a"), [{ id: "seed", name: "it's" }]);

  const excluded = await execute(h, "a", [{
    sql: "UPDATE projects SET name = 'changed' WHERE id <> 'seed' RETURNING id",
    params: {}, expect: { affectedRows: 0 },
  }], "string-literal-update-2");
  assert.equal(excluded.status, 200, JSON.stringify(excluded.body));
  assert.equal(excluded.body.results[0].affectedRows, 0);
  assert.deepEqual(h.rows("a"), [{ id: "seed", name: "it's" }]);
  // The other tenant's database and the cross-tenant row are untouched.
  assert.deepEqual(h.rows("b"), [{ id: "seed", name: "database_b" }]);
  assert.deepEqual(
    h.databases.get("a").database.prepare("SELECT name FROM projects WHERE id = 'hidden'").all().map((row) => ({ ...row })),
    [{ name: "hidden" }],
  );
});

test("double-quoted, unterminated and blob literals are rejected before any database call", async (t) => {
  const h = await harness(t, { hooks: false });
  for (const sql of [
    "SELECT id FROM projects WHERE id = \"seed\"",
    "SELECT id FROM projects WHERE id = 'seed",
    "SELECT id FROM projects WHERE id = X'73656564'",
    // SQLite rejects NUL inside a literal as an unrecognized token.
    "SELECT id FROM projects WHERE id = 'se\0ed'",
    "SELECT id FROM projects WHERE id LIKE 'seed\0%'",
  ]) {
    const response = await execute(h, "a", [{ sql, params: {} }], null);
    assert.ok(response.status >= 400 && response.status < 500, `${sql}: ${response.status}`);
  }
  assert.equal(h.events.length, 0);
});
