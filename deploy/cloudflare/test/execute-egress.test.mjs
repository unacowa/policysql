import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { initSync, PolicySqlRuntime } from "../pkg/policysql_cloudflare.js";
import { createApp as createHandlerCore } from "../src/app.ts";
import { LIMITS, POLICY_VERSION, SCHEMA_VERSION } from "../src/config.ts";
import { TursoHttpTransport } from "../src/turso-http.ts";

const issuer = "https://issuer.test";
const audience = "policysql-test";
let runtime;

const runtimeFrom = (catalogYaml, policyYaml) => new PolicySqlRuntime(
  catalogYaml,
  policyYaml,
  SCHEMA_VERSION,
  POLICY_VERSION,
  JSON.stringify({
    max_rows: LIMITS.maxRows,
    max_result_bytes: LIMITS.maxResultBytes,
    timeout_ms: LIMITS.timeoutMs,
    max_statements: LIMITS.maxStatements,
  }),
);

const ensureWasm = () => {
  if (!runtime) {
    initSync({
      module: readFileSync(new URL("../pkg/policysql_cloudflare_bg.wasm", import.meta.url)),
    });
  }
};

const getRuntime = () => {
  if (!runtime) {
    ensureWasm();
    runtime = runtimeFrom(
      readFileSync(new URL("../config/catalog.yaml", import.meta.url), "utf8"),
      readFileSync(new URL("../config/policy.compiled.yaml", import.meta.url), "utf8"),
    );
  }
  return runtime;
};

const fixturePath = (fixture, file) =>
  new URL(`../../../tests/fixtures/sqlite-turso-v1/${fixture}/${file}`, import.meta.url);

const readFixture = (fixture, file) => readFileSync(fixturePath(fixture, file), "utf8").trim();

const runtimeForFixture = (fixture) => {
  ensureWasm();
  return runtimeFrom(
    readFixture(fixture, "catalog-manifest.yaml"),
    readFixture(fixture, "policy.yaml"),
  );
};

const runtimeForFixturePolicy = (fixture, policyYaml) => {
  ensureWasm();
  return runtimeFrom(readFixture(fixture, "catalog-manifest.yaml"), policyYaml);
};

const encodeTursoValue = (value) => {
  if (value === null) return { type: "null" };
  if (typeof value === "number") return Number.isInteger(value)
    ? { type: "integer", value: String(value) }
    : { type: "float", value };
  if (typeof value === "boolean") return { type: "integer", value: value ? "1" : "0" };
  return { type: "text", value };
};

const result = (columns, rows, usage = {}) => ({
  type: "ok",
  response: {
    type: "execute",
    result: {
      cols: columns.map((name) => ({ name, decltype: "TEXT" })),
      rows: rows.map((row) => row.map(encodeTursoValue)),
      affected_row_count: usage.affectedRows ?? 0,
      rows_read: usage.rowsRead ?? rows.length,
      rows_written: usage.rowsWritten ?? 0,
      query_duration_ms: usage.queryDurationMs ?? 1,
    },
  },
});

const tokenFixture = async (access = ["execute"]) => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "ES256";
  const token = await new SignJWT({
    policysql: {
      roles: ["member"],
      default_role: "member",
      access,
      session: { tenant_id: "tenant_1" },
    },
  })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("user_1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return {
    token,
    authEnv: {
      POLICYSQL_JWKS_JSON: JSON.stringify({ keys: [publicJwk] }),
      POLICYSQL_JWT_ISSUER: issuer,
      POLICYSQL_JWT_AUDIENCE: audience,
    },
  };
};

test("Explain exposes role-visible resource names instead of internal identities", async () => {
  const { token, authEnv } = await tokenFixture(["explain"]);
  const handler = createHandlerCore({ getRuntime });
  const response = await handler.fetch(
    new Request("https://worker.test/v1/transactions:explain", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "cf-ray": "req_explain",
      },
      body: JSON.stringify({
        statements: [{ sql: "SELECT id FROM projects", params: {} }],
      }),
    }),
    {
      ...authEnv,
      POLICYSQL_RATE_LIMITER: { async limit() { return { success: true }; } },
    },
    {},
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.statements[0].resources, [{
    name: "projects",
    columns: ["id"],
    policy: "projects.member.select",
  }]);
  assert.equal(JSON.stringify(body).includes('"resource":1'), false);
  assert.equal(JSON.stringify(body).includes("appliedPolicies"), false);
});

const executeRequest = async ({
  runtime,
  token,
  authEnv,
  body,
  fetchImpl,
  idempotencyKey = undefined,
  requestId = "req_egress",
}) => {
  const handler = createHandlerCore({
    getRuntime: () => runtime,
    transportFactory: (env, id) => new TursoHttpTransport(env, id, fetchImpl),
  });
  return handler.fetch(
    new Request("https://worker.test/v1/transactions:execute", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "cf-ray": requestId,
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    }),
    {
      ...authEnv,
      TURSO_DATABASE_URL: "https://db.test",
      TURSO_AUTH_TOKEN: "secret",
      POLICYSQL_RATE_LIMITER: { async limit() { return { success: true }; } },
    },
    {},
  );
};

test("captures the Turso egress SQL and transaction envelope for an HTTP execute request", async () => {
  const expectedProtectedSql = 'SELECT "__policysql_t0"."id" AS "id", "__policysql_t0"."name" AS "name" FROM "projects" AS "__policysql_t0" WHERE (("__policysql_t0"."status" = :status) AND ("__policysql_t0"."tenant_id" = :__policysql_session_tenant_id)) LIMIT MIN (:limit, 100)';
  const { token, authEnv } = await tokenFixture();
  const pipelineBodies = [];
  const fetchImpl = async function (_url, init) {
    assert.equal(this, undefined, "host fetch must not be invoked as a transport method");
    const body = JSON.parse(init.body);
    pipelineBodies.push(body);
    const sql = body.requests[0]?.stmt?.sql;
    if (sql === "BEGIN DEFERRED") {
      return new Response(JSON.stringify({ baton: "baton_1", results: [result([], [])] }));
    }
    if (sql !== "BEGIN DEFERRED" && sql !== "COMMIT") {
      return new Response(JSON.stringify({
        baton: "baton_2",
        results: body.requests.map((_request, index) =>
          result(["id", "name"], [[`project_${index + 1}`, `Visible ${index + 1}`]], { rowsRead: 1, queryDurationMs: 0.5 }),
        ),
      }));
    }
    if (sql === "COMMIT") {
      return new Response(JSON.stringify({
        baton: null,
        results: [result([], []), { type: "ok", response: { type: "close" } }],
      }));
    }
    throw new Error(`unexpected database SQL: ${sql}`);
  };
  const response = await executeRequest({
    runtime: getRuntime(),
    token,
    authEnv,
    fetchImpl,
    body: {
        statements: [{
          sql: "SELECT id, name FROM projects WHERE status = :status LIMIT :limit",
          params: { status: "active", limit: 200 },
        }, {
          sql: "SELECT id, name FROM projects WHERE status = :status LIMIT :limit",
          params: { status: "archived", limit: 5 },
        }],
      },
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.results.map((item) => item.rows), [
    [{ id: "project_1", name: "Visible 1" }],
    [{ id: "project_2", name: "Visible 2" }],
  ]);
  assert.deepEqual(body.results[0].meta.result.columns, [
    { name: "id", type: "string", representation: "string", nullable: false },
    { name: "name", type: "string", representation: "string", nullable: false },
  ]);
  assert.equal("logicalType" in body.results[0].meta.result.columns[0], false);
  assert.equal(pipelineBodies.length, 3);
  assert.deepEqual(pipelineBodies.map((item) => item.requests.length), [1, 2, 2]);
  assert.equal(pipelineBodies[0].baton, undefined);
  assert.equal(pipelineBodies[0].requests[0].stmt.sql, "BEGIN DEFERRED");
  assert.equal(pipelineBodies[1].baton, "baton_1");
  assert.equal(pipelineBodies[1].requests[0].stmt.sql, expectedProtectedSql);
  assert.equal(pipelineBodies[1].requests[1].stmt.sql, expectedProtectedSql);
  assert.equal(pipelineBodies[2].baton, "baton_2");
  assert.equal(pipelineBodies[2].requests[0].stmt.sql, "COMMIT");
  assert.equal(pipelineBodies[2].requests[1].type, "close");
  assert.equal(
    pipelineBodies[1].requests[0].stmt.sql.includes("LIMIT :limit"),
    false,
    "user-provided limit must not pass through unclamped at the egress boundary",
  );
  assert.equal(pipelineBodies[1].requests[0].stmt.sql.includes("LIMIT MIN (:limit, 100)"), true);
  assert.deepEqual(
    Object.fromEntries(pipelineBodies[1].requests[0].stmt.named_args.map((item) => [item.name, item.value])),
    {
      status: { type: "text", value: "active" },
      limit: { type: "integer", value: "200" },
      __policysql_session_tenant_id: { type: "text", value: "tenant_1" },
    },
  );
  assert.deepEqual(
    Object.fromEntries(pipelineBodies[1].requests[1].stmt.named_args.map((item) => [item.name, item.value])),
    {
      status: { type: "text", value: "archived" },
      limit: { type: "integer", value: "5" },
      __policysql_session_tenant_id: { type: "text", value: "tenant_1" },
    },
  );
});

const selectVariations = [
  {
    name: "LEFT JOIN reaches Turso only as policy-protected SQL",
    fixture: "select/joins",
    rows: [["project_1", "Task 1"]],
    columns: ["id", "title"],
    assertSql(sql) {
      assert.match(sql, /LEFT JOIN "tasks" AS "__policysql_t1" ON/);
      assert.match(sql, /"__policysql_t1"."tenant_id" = :__policysql_session_tenant_id\)\) WHERE/);
    },
  },
  {
    name: "transparent CTE is flattened before egress",
    fixture: "select/transparent-sources",
    rows: [["project_1", "Visible"]],
    columns: ["id", "name"],
    assertSql(sql) {
      assert.equal(sql.includes("WITH visible"), false);
      assert.match(sql, /FROM "projects" AS "__policysql_t0"/);
    },
  },
  {
    name: "correlated EXISTS reaches Turso with both resource policies",
    fixture: "select/correlated-exists",
    rows: [["project_1"]],
    columns: ["id"],
    assertSql(sql) {
      assert.match(sql, /EXISTS \(SELECT/);
      assert.match(sql, /"__policysql_t1"."tenant_id" = :__policysql_session_tenant_id/);
      assert.match(sql, /"__policysql_t0"."tenant_id" = :__policysql_session_tenant_id/);
    },
  },
  {
    name: "policy-gated aggregate GROUP BY/HAVING reaches Turso",
    fixture: "select/aggregate-group",
    rows: [["tenant_1", 1]],
    columns: ["tenant_id", "item_count"],
    assertSql(sql) {
      assert.match(sql, /COUNT\s*\(\*\) AS "item_count"/);
      assert.match(sql, /GROUP BY "__policysql_t0"."tenant_id" HAVING \(COUNT\s*\(\*\) > :minimum\)/);
    },
  },
  {
    name: "policy-gated window ROW_NUMBER reaches Turso",
    fixture: "select/window-row-number",
    rows: [["project_1", 1]],
    columns: ["id", "row_number"],
    assertSql(sql) {
      assert.match(sql, /ROW_NUMBER\s*\(\) OVER/);
      assert.match(sql, /PARTITION BY "__policysql_t0"."tenant_id"/);
    },
  },
];

for (const variation of selectVariations) {
  test(variation.name, async () => {
    const expectedProtectedSql = variation.unsupported
      ? null
      : readFixture(variation.fixture, "expected/protected.sql");
    const inputSql = readFixture(variation.fixture, "input.sql");
    const clientParams = JSON.parse(readFixture(variation.fixture, "client-params.json"));
    const { token, authEnv } = await tokenFixture();
    const pipelineBodies = [];
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      pipelineBodies.push(body);
      const sql = body.requests[0]?.stmt?.sql;
      if (sql === "BEGIN DEFERRED") {
        return new Response(JSON.stringify({ baton: "baton_1", results: [result([], [])] }));
      }
      if (sql === "COMMIT") {
        return new Response(JSON.stringify({
          baton: null,
          results: [result([], []), { type: "ok", response: { type: "close" } }],
        }));
      }
      return new Response(JSON.stringify({
        baton: "baton_2",
        results: [result(variation.columns, variation.rows, { rowsRead: variation.rows.length, queryDurationMs: 0.5 })],
      }));
    };
    const response = await executeRequest({
      runtime: runtimeForFixture(variation.fixture),
      token,
      authEnv,
      fetchImpl,
      body: { statements: [{ sql: inputSql, params: clientParams }] },
    });
    if (variation.unsupported) {
      const body = await response.json();
      assert.equal(response.status, 403);
      assert.equal(body.error.code, "POLICYSQL_STATEMENT_REJECTED");
      assert.equal(pipelineBodies.length, 0);
      return;
    }
    assert.equal(response.status, 200);
    await response.json();
    assert.equal(pipelineBodies.length, 3);
    assert.equal(pipelineBodies[0].requests[0].stmt.sql, "BEGIN DEFERRED");
    assert.equal(pipelineBodies[1].baton, "baton_1");
    assert.equal(pipelineBodies[1].requests[0].stmt.sql, expectedProtectedSql);
    variation.assertSql(pipelineBodies[1].requests[0].stmt.sql);
    assert.equal(pipelineBodies[2].baton, "baton_2");
    assert.equal(pipelineBodies[2].requests[0].stmt.sql, "COMMIT");
  });
}

test("documented function GLOB alias ordering and OFFSET reach protected Turso egress", async () => {
  const { token, authEnv } = await tokenFixture();
  const pipelineBodies = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    pipelineBodies.push(body);
    const sql = body.requests[0]?.stmt?.sql;
    if (sql === "BEGIN DEFERRED") {
      return new Response(JSON.stringify({ baton: "baton_1", results: [result([], [])] }));
    }
    if (sql === "COMMIT") {
      return new Response(JSON.stringify({
        baton: null,
        results: [result([], []), { type: "ok", response: { type: "close" } }],
      }));
    }
    return new Response(JSON.stringify({
      baton: "baton_2",
      results: [result(["normalized_name"], [["alpha"]], { rowsRead: 3 })],
    }));
  };
  const response = await executeRequest({
    runtime: getRuntime(),
    token,
    authEnv,
    fetchImpl,
    body: {
      statements: [{
        sql: "SELECT LOWER(name) AS normalized_name FROM projects WHERE name GLOB :pattern ORDER BY normalized_name LIMIT :limit OFFSET :offset",
        params: { pattern: "A*", limit: 10, offset: 1 },
      }],
    },
  });
  assert.equal(response.status, 200);
  await response.json();
  const sql = pipelineBodies[1].requests[0].stmt.sql;
  assert.match(sql, /LOWER\s*\("__policysql_t0"\."name"\) AS "normalized_name"/);
  assert.match(sql, /"name" GLOB :pattern/);
  assert.match(sql, /ORDER BY LOWER\s*\("__policysql_t0"\."name"\) ASC/);
  assert.match(sql, /LIMIT MIN\s*\(:limit, 100\) OFFSET :offset/);
});

test("denied SQL returns before any Turso egress call", async () => {
  const { token, authEnv } = await tokenFixture();
  let egressCalls = 0;
  const response = await executeRequest({
    runtime: runtimeForFixture("security/forbidden-order-column"),
    token,
    authEnv,
    fetchImpl: async () => {
      egressCalls += 1;
      throw new Error("forbidden SQL must not reach Turso");
    },
    body: {
      statements: [{
        sql: readFixture("security/forbidden-order-column", "input.sql"),
        params: JSON.parse(readFixture("security/forbidden-order-column", "client-params.json")),
      }],
    },
  });
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.error.code, "POLICYSQL_FORBIDDEN_COLUMN");
  assert.equal(body.error.path, "/statements/0");
  assert.equal(egressCalls, 0);
});

const policyDeniedSelects = [
  {
    name: "JOIN without a select policy for every resource performs zero Turso calls",
    expectedCode: "POLICYSQL_MISSING_POLICY",
    fixture: "select/joins",
    policy: `version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id, name]
          filter: { tenant_id: { eq: { session: tenant_id } } }`,
  },
  {
    name: "aggregate without allow_aggregations performs zero Turso calls",
    expectedCode: "POLICYSQL_FORBIDDEN_OPERATION",
    fixture: "select/aggregate-group",
    policy: `version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [tenant_id]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          allow_aggregations: false`,
  },
  {
    name: "window without allow_windows performs zero Turso calls",
    expectedCode: "POLICYSQL_FORBIDDEN_OPERATION",
    fixture: "select/window-row-number",
    policy: `version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id, tenant_id]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          allow_windows: false`,
  },
];

for (const variation of policyDeniedSelects) {
  test(variation.name, async () => {
    const { token, authEnv } = await tokenFixture();
    let egressCalls = 0;
    const response = await executeRequest({
      runtime: runtimeForFixturePolicy(variation.fixture, variation.policy),
      token,
      authEnv,
      fetchImpl: async () => {
        egressCalls += 1;
        throw new Error("policy-denied SQL must not reach Turso");
      },
      body: {
        statements: [{
          sql: readFixture(variation.fixture, "input.sql"),
          params: JSON.parse(readFixture(variation.fixture, "client-params.json")),
        }],
      },
    });
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.error.code, variation.expectedCode);
    assert.equal(body.error.path, "/statements/0");
    assert.equal(egressCalls, 0);
  });
}

test("write mutation egress stays inside one BEGIN IMMEDIATE transaction with idempotency", async () => {
  const fixture = "mutation/update-filtered";
  const expectedProtectedSql = readFixture(fixture, "expected/protected.sql");
  const { token, authEnv } = await tokenFixture();
  const pipelineBodies = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    pipelineBodies.push(body);
    const sql = body.requests[0]?.stmt?.sql;
    if (sql === "BEGIN IMMEDIATE") {
      return new Response(JSON.stringify({ baton: "baton_1", results: [result([], [])] }));
    }
    if (sql.startsWith("SELECT fingerprint, response_json FROM policysql_idempotency")) {
      return new Response(JSON.stringify({ baton: "baton_2", results: [result(["fingerprint", "response_json"], [])] }));
    }
    if (sql === expectedProtectedSql) {
      return new Response(JSON.stringify({
        baton: "baton_3",
        results: [result(["id", "name", "__policysql_check"], [["p1", "Renamed", 1]], { rowsRead: 1, rowsWritten: 1, queryDurationMs: 0.5 })],
      }));
    }
    if (sql.startsWith("INSERT INTO policysql_idempotency")) {
      return new Response(JSON.stringify({ baton: "baton_4", results: [result([], [], { rowsWritten: 1, affectedRows: 1 })] }));
    }
    if (sql === "COMMIT") {
      return new Response(JSON.stringify({
        baton: null,
        results: [result([], []), { type: "ok", response: { type: "close" } }],
      }));
    }
    throw new Error(`unexpected database SQL: ${sql}`);
  };
  const response = await executeRequest({
    runtime: runtimeForFixture(fixture),
    token,
    authEnv,
    fetchImpl,
    idempotencyKey: "write-egress-key-0001",
    body: {
      statements: [{
        sql: readFixture(fixture, "input.sql"),
        params: JSON.parse(readFixture(fixture, "client-params.json")),
        expect: { affectedRows: 1 },
      }],
    },
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.results[0].affectedRows, 1);
  assert.equal(pipelineBodies.length, 5);
  assert.deepEqual(pipelineBodies.map((item) => item.baton), [undefined, "baton_1", "baton_2", "baton_3", "baton_4"]);
  assert.equal(pipelineBodies[0].requests[0].stmt.sql, "BEGIN IMMEDIATE");
  assert.equal(pipelineBodies[1].requests[0].stmt.sql, "SELECT fingerprint, response_json FROM policysql_idempotency WHERE key_hash = :key_hash");
  assert.equal(pipelineBodies[2].requests[0].stmt.sql, expectedProtectedSql);
  assert.equal(pipelineBodies[3].requests[0].stmt.sql, "INSERT INTO policysql_idempotency (key_hash, fingerprint, response_json) VALUES (:key_hash, :fingerprint, :response_json)");
  assert.equal(pipelineBodies[4].requests[0].stmt.sql, "COMMIT");
  assert.equal(pipelineBodies[4].requests[1].type, "close");
  assert.deepEqual(
    Object.fromEntries(pipelineBodies[2].requests[0].stmt.named_args.map((item) => [item.name, item.value])),
    {
      id: { type: "text", value: "p1" },
      name: { type: "text", value: "Renamed" },
      __policysql_session_subject_id: { type: "text", value: "user_1" },
      __policysql_session_tenant_id: { type: "text", value: "tenant_1" },
    },
  );
});
