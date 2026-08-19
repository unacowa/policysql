import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { initSync, PolicySqlRuntime } from "../pkg/policysql_cloudflare.js";
import { LIMITS, POLICY_VERSION, SCHEMA_VERSION } from "../src/config.ts";

initSync({ module: readFileSync(new URL("../pkg/policysql_cloudflare_bg.wasm", import.meta.url)) });

const runtime = PolicySqlRuntime.newWithPhysicalSchema(
  readFileSync(new URL("../config/catalog.yaml", import.meta.url), "utf8"),
  readFileSync(new URL("../config/policy.compiled.yaml", import.meta.url), "utf8"),
  SCHEMA_VERSION,
  POLICY_VERSION,
  JSON.stringify({
    max_rows: LIMITS.maxRows,
    max_result_bytes: LIMITS.maxResultBytes,
    timeout_ms: LIMITS.timeoutMs,
    max_statements: LIMITS.maxStatements,
  }),
  readFileSync(new URL("../config/schema-introspection.json", import.meta.url), "utf8"),
);

const auth = JSON.stringify({
  subject: "user_1",
  role: "member",
  roles: ["member"],
  access: ["execute", "explain", "catalog"],
  session: { tenant_id: "tenant_a" },
});

const accepted = [
  {
    name: "documented inner join order and limit",
    sql: "SELECT p.id, p.title, a.name AS author_name FROM posts AS p JOIN authors AS a ON a.id = p.author_id WHERE p.status = :status ORDER BY p.published_at DESC LIMIT :limit",
    params: { status: "published", limit: 20 },
  },
  {
    name: "documented filtered CTE feeding a join",
    sql: "WITH published_posts AS (SELECT id, author_id, title FROM posts WHERE status = :status) SELECT p.id, p.title, a.name FROM published_posts AS p JOIN authors AS a ON a.id = p.author_id",
    params: { status: "published" },
  },
  {
    name: "documented qualified correlated exists",
    sql: "SELECT p.id FROM posts AS p WHERE EXISTS (SELECT c.id FROM comments AS c WHERE c.post_id = p.id)",
    params: {},
  },
  {
    name: "documented correlated exists with constant projection",
    sql: "SELECT p.id FROM posts AS p WHERE EXISTS (SELECT 1 FROM comments AS c WHERE c.post_id = p.id)",
    params: {},
  },
  {
    name: "documented group count and having",
    sql: "SELECT status, COUNT(*) AS post_count FROM posts GROUP BY status HAVING COUNT(*) >= :minimum ORDER BY post_count DESC",
    params: { minimum: 1 },
  },
  {
    name: "documented row number window",
    sql: "SELECT id, title, ROW_NUMBER() OVER (PARTITION BY author_id ORDER BY published_at DESC) AS author_post_number FROM posts",
    params: {},
  },
  {
    name: "documented searched case concat and cast",
    sql: "SELECT CASE WHEN status = :status THEN CAST(title AS TEXT) ELSE title || :suffix END AS display_title FROM posts",
    params: { status: "published", suffix: "-other" },
  },
  {
    name: "registered scalar functions predicates and offset",
    sql: "SELECT LOWER(title) AS lower_title, UPPER(title) AS upper_title, JSON_EXTRACT(metadata, :path) AS selected_metadata FROM posts WHERE title GLOB :pattern AND title LIKE :prefix ORDER BY lower_title LIMIT :limit OFFSET :offset",
    params: { path: "$.label", pattern: "*", prefix: "%", limit: 10, offset: 0 },
  },
  {
    name: "policy filtered JSON collection",
    sql: "SELECT json_group_array(j.value) AS items FROM posts AS p, json_each(p.metadata, :path) AS j WHERE p.id = :id",
    params: { path: "$.tags", id: "post_1" },
  },
  {
    name: "recursive JSON traversal within the finite Catalog schema",
    sql: "SELECT json_group_array(j.value) AS items FROM posts AS p, json_tree(p.metadata, :path) AS j WHERE p.id = :id",
    params: { path: "$.tags", id: "post_1" },
  },
  {
    name: "transparent derived table",
    sql: "SELECT p.id, p.title FROM (SELECT id, title FROM posts) AS p ORDER BY p.id",
    params: {},
  },
  {
    name: "conditional output projection",
    sql: "SELECT id, private_note AS note FROM posts ORDER BY id",
    params: {},
  },
  {
    name: "constant select",
    sql: "SELECT 1 AS value",
    params: {},
  },
  {
    name: "documented minimal insert relying on defaults and presets",
    sql: "INSERT INTO posts (title, status) VALUES (:title, :status) RETURNING id, title, status",
    params: { title: "Generated identity", status: "draft" },
  },
  {
    name: "insert with presets check and returning",
    sql: "INSERT INTO posts (id, title, status, published_at, metadata, view_count) VALUES (:id, :title, :status, :published_at, :metadata, :view_count) RETURNING id, title, status",
    params: {
      id: "post_probe",
      title: "Probe",
      status: "draft",
      published_at: "2026-08-12T00:00:00Z",
      metadata: { label: "probe", score: 1, tags: ["test"] },
      view_count: 0,
    },
  },
  {
    name: "update with filter preset check and returning",
    sql: "UPDATE posts SET title = :title, status = :status WHERE id = :id RETURNING id, title, status",
    params: { id: "post_probe", title: "Updated", status: "published" },
  },
  {
    name: "delete with filter and returning",
    sql: "DELETE FROM posts WHERE id = :id RETURNING id",
    params: { id: "post_probe" },
  },
];

test("development Catalog and policy compile every advertised SQL family", () => {
  for (const fixture of accepted) {
    const compiled = JSON.parse(runtime.compile_json(
      auth,
      JSON.stringify({ statements: [{ sql: fixture.sql, params: fixture.params }] }),
      "execute",
    ));
    assert.equal(compiled.error, undefined, `${fixture.name}: ${JSON.stringify(compiled)}`);
    assert.equal(compiled.statements.length, 1, fixture.name);
    assert.equal(typeof compiled.statements[0].protectedSql, "string", fixture.name);
    assert.notEqual(compiled.statements[0].protectedSql.length, 0, fixture.name);
    runtime.release_execution(BigInt(compiled.executionHandle));
  }
});

const rejected = [
  "SELECT * FROM posts",
  "SELECT id FROM posts WHERE internal_notes IS NOT NULL",
  "SELECT id FROM posts WHERE private_note IS NOT NULL",
  "SELECT custom_function(title) AS value FROM posts",
  "SELECT posts.id, authors.id FROM posts JOIN authors ON authors.id = posts.author_id",
  "WITH posts AS (SELECT id, title FROM archived_posts) SELECT id, title FROM posts",
  "SELECT p.id FROM posts AS p WHERE EXISTS (SELECT c.id FROM comments AS p WHERE p.post_id = p.id)",
];

test("development Catalog and policy still reject documented bypass shapes", () => {
  for (const sql of rejected) {
    const compiled = JSON.parse(runtime.compile_json(
      auth,
      JSON.stringify({ statements: [{ sql, params: {} }] }),
      "execute",
    ));
    assert.equal(typeof compiled.error?.code, "string", sql);
  }
});
