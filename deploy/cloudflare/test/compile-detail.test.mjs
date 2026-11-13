// #145 pull request C: `error.detail` of the refusals a compile returns, as the whole Worker
// answers them (Execute direct and owner, an interactive statement, Explain, a keyed execute's
// `cause.detail`), and the log event `rejection_reason` that holds the reason behind each one.
import assert from "node:assert/strict";
import test from "node:test";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";

const EXECUTE = "/v1/transactions:execute";
const EXPLAIN = "/v1/transactions:explain";
const one = (statement) => ({ statements: [statement] });

for (const ownerAdapter of OWNER_ADAPTERS) {
  const setup = async (t, hooks) => {
    const logs = [];
    t.mock.method(console, "log", (line) => { logs.push(String(line)); });
    const h = await harness(t, { ownerAdapter, hooks });
    h.setValidator?.(async () => true);
    return Object.assign(h, { logs });
  };
  const records = (h, event) => h.logs.flatMap((line) => { try { const record = JSON.parse(line); return record.event === event ? [record] : []; } catch { return []; } });
  const reasonsOf = (h, response) => records(h, "rejection_reason").filter((record) => record.requestId === response.body.error.requestId);

  const CASES = [
    ["an unsupported construct", { sql: "SELECT * FROM projects", params: {} }, 400, "POLICYSQL_UNSUPPORTED_SQL", { feature: "star" }, "bind.Unsupported"],
    ["an unsupported statement", { sql: "PRAGMA table_info(projects)", params: {} }, 400, "POLICYSQL_UNSUPPORTED_SQL", { feature: "statement" }, "bind.Unsupported"],
    ["a positional parameter", { sql: "SELECT id FROM projects WHERE id = ?", params: {} }, 400, "POLICYSQL_INVALID_PARAMETER", { reason: "positional" }, "bind.PositionalParameter"],
    ["a name that is not the SQL's", { sql: "SELECT id FROM projects WHERE id = :x", params: {} }, 400, "POLICYSQL_INVALID_PARAMETER", { reason: "names" }, "compile.ClientParameterMismatch"],
    ["a value of the wrong type", { sql: "SELECT id FROM projects WHERE id = :x", params: { x: 1 } }, 400, "POLICYSQL_INVALID_PARAMETER", { reason: "value" }, "compile.ClientParameterTypeMismatch"],
    ["a parse error with a position", { sql: "SELECT id FROM projects WHERE name = 'abc", params: {} }, 400, "POLICYSQL_INVALID_SQL", { span: { start: 37, end: 41 } }, "bind.InvalidSql"],
    ["a parse error without a position", { sql: "SELECT", params: {} }, 400, "POLICYSQL_INVALID_SQL", undefined, "bind.InvalidSql"],
    ["a column that does not exist", { sql: "SELECT nope FROM projects", params: {} }, 403, "POLICYSQL_FORBIDDEN_COLUMN", undefined, "bind.UnknownColumn"],
    ["an expectation that cannot hold", { sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id", params: { id: "e", name: "e" }, expect: { affectedRows: 2 } }, 422, "POLICYSQL_EXPECTATION_FAILED", { expectation: "affectedRows" }, "gateway.ExpectationMismatch"],
  ];

  for (const [placement, hooks] of [["direct", false], ["owner", true]]) {
    for (const [label, statement, status, code, detail, reason] of CASES) {
      test(`${ownerAdapter}: ${label} is ${code} with its detail on Execute (${placement}), Explain, and a keyed retry`, async (t) => {
        const h = await setup(t, hooks);
        const executed = await h.request("a", EXECUTE, one(statement), null);
        assert.equal(executed.status, status, JSON.stringify(executed.body));
        assert.equal(executed.body.error.code, code);
        assert.deepEqual(executed.body.error.detail, detail);
        assert.equal(Object.hasOwn(executed.body.error, "detail"), detail !== undefined, "the key is absent, not undefined");
        assert.equal(executed.body.error.path, "/statements/0");
        // The reason behind it is in the log, once, with the same request id and no identifier.
        const [record, ...rest] = reasonsOf(h, executed);
        assert.equal(rest.length, 0, "one record per refusal");
        assert.ok(record, `the reason is logged: ${h.logs.join("\n").slice(0, 600)}`);
        assert.equal(record.code, code);
        assert.equal(record.reason, reason);
        assert.equal(record.statementIndex, 0);
        assert.equal(record.abiVersion, 26);
        assert.deepEqual(Object.keys(record).sort(), ["abiVersion", "code", "event", "policyVersion", "reason", "requestId", "schemaVersion", "shape", "statementIndex"]);
        assert.ok(/^[a-z]+\.[A-Za-z]+$/u.test(record.reason), record.reason);
        // The reason is never in the answer.
        assert.ok(!JSON.stringify(executed.body).includes(reason), "the internal reason is not returned");

        // Explain compiles in the engine and answers the same detail (parameters it is given or
        // that it fills in are the only difference, so only the shapes Explain refuses alike are
        // compared).
        if (statement.expect === undefined && !["a name that is not the SQL's", "a value of the wrong type"].includes(label)) {
          const explained = await h.request("a", EXPLAIN, one(statement), null);
          assert.equal(explained.status, status, JSON.stringify(explained.body));
          assert.equal(explained.body.error.code, code);
          assert.deepEqual(explained.body.error.detail, detail);
          const explainReasons = reasonsOf(h, explained);
          assert.equal(explainReasons.length, 1, "Explain logs the compile's reason too");
          assert.equal(explainReasons[0].reason, reason);
          assert.equal(explainReasons[0].code, code);
        }

        // With a key the same refusal is the unknown outcome, whose cause carries the detail
        // (null where the code has none), and the log keeps the original reason.
        const keyed = await h.request("a", EXECUTE, one(statement), `keyed-detail-${placement}-0001`);
        assert.equal(keyed.status, 500, JSON.stringify(keyed.body));
        assert.equal(keyed.body.error.code, "POLICYSQL_OUTCOME_UNKNOWN");
        assert.deepEqual(keyed.body.error.detail, { cause: { code, path: "/statements/0", detail: detail ?? null } });
        const keyedReasons = reasonsOf(h, keyed);
        assert.equal(keyedReasons.length, 1);
        assert.equal(keyedReasons[0].reason, reason, "the cause's reason is logged before the answer is rewritten");
        assert.equal(keyedReasons[0].code, code, "with the code of the compile, not the unknown outcome");
      });
    }
  }

  // #145 pull request D: a resource the role has no policy on is a name that does not exist. The
  // example policy's `projects` is given to another role, so `member` has no policy at all (the
  // example has one resource): this goes through the empty Catalog a role without a policy binds
  // against. The roles that each have a policy on a different resource are in
  // `crates/policysql-wasm/src/resource_tests.rs`.
  const hidden = (policy) => policy.replace("      member:", "      other:");
  const HIDDEN_CASES = [
    ["SELECT id FROM {R}", {}],
    ["SELECT nope FROM {R}", {}],
    ["SELECT * FROM {R}", {}],
    ["INSERT INTO {R} (id) VALUES (:v)", { v: "x" }],
    ["UPDATE {R} SET name = :v WHERE id = :id", { v: "x", id: "y" }],
    ["DELETE FROM {R} WHERE id = :v", { v: "x" }],
  ];
  for (const [placement, hooks] of [["direct", false], ["owner", true]]) {
    test(`${ownerAdapter}: a resource without a policy and a name that does not exist are one answer (${placement})`, async (t) => {
      const h = await harness(t, { ownerAdapter, hooks, customizePolicy: hidden });
      h.setValidator?.(async () => true);
      let key = 0;
      for (const [template, params] of HIDDEN_CASES) {
        for (const [endpoint, keyed] of [[EXECUTE, false], [EXPLAIN, false], [EXECUTE, true]]) {
          const answer = async (name) => {
            const statement = { sql: template.replaceAll("{R}", name), params: endpoint === EXPLAIN ? {} : params };
            return h.request("a", endpoint, one(statement), keyed ? `hidden-resource-${placement}-${++key}` : null);
          };
          const [seen, missing] = [await answer("projects"), await answer("no_such_table")];
          const label = `${template} ${endpoint} ${keyed ? "keyed" : "unkeyed"}`;
          assert.equal(seen.status, keyed ? 500 : 403, `${label}: ${JSON.stringify(seen.body)}`);
          assert.equal(missing.status, seen.status, label);
          const without = ({ requestId, ...error }) => error;
          assert.deepEqual(without(seen.body.error), without(missing.body.error), label);
          if (keyed) {
            assert.equal(seen.body.error.code, "POLICYSQL_OUTCOME_UNKNOWN", label);
            assert.deepEqual(seen.body.error.detail, { cause: { code: "POLICYSQL_MISSING_POLICY", path: "/statements/0", detail: null } }, label);
          } else {
            assert.equal(seen.body.error.code, "POLICYSQL_MISSING_POLICY", label);
            assert.equal(seen.body.error.message, "No policy permits this operation, or the resource does not exist.", label);
            assert.equal(seen.body.error.path, "/statements/0", label);
            assert.equal(Object.hasOwn(seen.body.error, "detail"), false, label);
          }
        }
      }
    });
  }

  test(`${ownerAdapter}: an interactive statement answers the same detail and logs its reason`, async (t) => {
    const h = await setup(t, true);
    const started = await h.request("a", "/v1/transactions", { mode: "read" }, null);
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const base = `/v1/transactions/${started.body.transactionId}`;
    const refused = await h.request("a", `${base}/statements`, { sequence: 1, sql: "SELECT * FROM projects", params: {} }, null);
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "POLICYSQL_UNSUPPORTED_SQL");
    assert.deepEqual(refused.body.error.detail, { feature: "star" });
    const [record] = reasonsOf(h, refused);
    assert.equal(record?.reason, "bind.Unsupported");
    assert.equal(record?.shape, "star projection");
  });

  test(`${ownerAdapter}: a result that misses its expectation names it, and the log says which`, async (t) => {
    const h = await setup(t, false);
    const rows = await h.request("a", EXECUTE, one({ sql: "SELECT id FROM projects", params: {}, expect: { rowCount: 999 } }), null);
    assert.equal(rows.status, 422, JSON.stringify(rows.body));
    assert.equal(rows.body.error.code, "POLICYSQL_EXPECTATION_FAILED");
    assert.deepEqual(rows.body.error.detail, { expectation: "rowCount" });
    assert.equal(rows.body.error.path, "/statements/0");
    assert.equal(reasonsOf(h, rows)[0]?.reason, "result.RowCount");
  });

  test(`${ownerAdapter}: the answers and the logs of a refusal hold no identifier, parameter name, or value`, async (t) => {
    const h = await setup(t, false);
    const secret = "zzz_secret_value_7";
    for (const sql of [
      `SELECT zzz_column FROM projects WHERE name = '${secret}'`,
      `SELECT id FROM zzz_table WHERE id = :zzz_param`,
      `SELECT * FROM projects WHERE name = '${secret}'`,
      `SELECT id FROM projects WHERE zzz_param_name = :zzz_param`,
      `SELECT id FROM projects WHERE name = '${secret}`,
      `WITH zzz_cte AS (SELECT id FROM projects) SELECT * FROM zzz_cte WHERE id = '${secret}'`,
    ]) {
      h.logs.length = 0;
      const response = await h.request("a", EXECUTE, one({ sql, params: { zzz_param: secret } }), null);
      assert.ok(response.status >= 400, sql);
      const own = h.logs.filter((line) => line.includes(response.body.error.requestId));
      const everything = `${JSON.stringify(response.body)}\n${own.join("\n")}`;
      for (const leaked of ["zzz_", secret, "tenant_id", "__policysql"]) assert.ok(!everything.includes(leaked), `${leaked} in ${everything.slice(0, 500)}`);
    }
  });

  // A column the role cannot read (`tenant_id` is only in the policy's filter) and one that does
  // not exist are answered alike, whole, wherever the name is resolved. The Rust test of the
  // same name covers more templates and lists the places where the code already differs.
  for (const [placement, hooks] of [["direct", false], ["owner", true]]) {
    test(`${ownerAdapter}: a hidden column and a missing one are the same answer on Execute and Explain (${placement})`, async (t) => {
      const h = await setup(t, hooks);
      const templates = [
        "SELECT {C} FROM projects",
        "SELECT id FROM projects WHERE {C} = :v",
        "SELECT id FROM projects ORDER BY {C}",
        "SELECT upper({C}) FROM projects",
        "SELECT id FROM projects WHERE lower({C}) = :v",
        "INSERT INTO projects ({C}) VALUES (:v)",
        "UPDATE projects SET {C} = :v WHERE id = :id",
      ];
      // Not here: `DELETE FROM projects WHERE {C} = :v`. This policy has no delete, so a column that
      // exists reaches `MISSING_POLICY` and one that does not is `FORBIDDEN_COLUMN` (#154: the binder
      // resolves every column against the whole Catalog before the policy is looked at).
      for (const template of templates) {
        for (const path of [EXECUTE, EXPLAIN]) {
          const answer = async (name) => {
            const sql = template.replace("{C}", name);
            const params = path === EXPLAIN ? {} : Object.fromEntries([...sql.matchAll(/:([a-z_]+)/gu)].map((match) => [match[1], "x"]));
            const { requestId: _ignored, ...error } = (await h.request("a", path, one({ sql, params }), null)).body.error;
            return error;
          };
          const [hidden, missing] = [await answer("tenant_id"), await answer("no_such_column")];
          assert.equal(hidden.code, missing.code, `${path} ${template}`);
          assert.deepEqual(hidden, missing, `${path} ${template}`);
        }
      }
    });
  }

  // Explain compiles outside the step machine; a complexity refusal there is logged with its own
  // event and the request id, as it is on Execute.
  test(`${ownerAdapter}: a too-complex Explain logs sql_too_complex with its cause and the request id`, async (t) => {
    const h = await setup(t, false);
    const statement = { sql: "SELECT id FROM projects WHERE name LIKE :q", params: { q: "a".repeat(50_001) } };
    for (const path of [EXPLAIN, EXECUTE]) {
      h.logs.length = 0;
      const response = await h.request("a", path, one(statement), null);
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.deepEqual(response.body.error.detail, { complexity: "like_pattern" });
      const logged = records(h, "sql_too_complex").filter((record) => record.requestId === response.body.error.requestId);
      assert.equal(logged.length, 1, `${path}: one record`);
      assert.equal(logged[0].cause, "like_pattern");
      assert.equal(logged[0].statementIndex, 0);
      assert.equal(reasonsOf(h, response).length, 0, "a complexity refusal has no rejection_reason");
    }
  });
}
