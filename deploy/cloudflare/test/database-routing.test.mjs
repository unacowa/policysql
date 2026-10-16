import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { initSync, PolicySqlRuntime } from "../pkg/policysql_cloudflare.js";
import { createApp } from "../src/app.ts";
import { TransactionOwnerCore } from "../src/transaction-owner.ts";
import { TursoHttpTransport } from "../src/turso-http.ts";
import { createDatabaseRegistry } from "../../../examples/database-routing/provider.ts";
import { validateDatabaseBinding, databaseTransportFactory } from "../src/database.ts";
import { requestIdempotency, authFingerprint } from "../src/idempotency.ts";

initSync({ module: readFileSync(new URL("../pkg/policysql_cloudflare_bg.wasm", import.meta.url)) });
const example = (name) => readFileSync(new URL(`../../../examples/database-routing/${name}`, import.meta.url), "utf8");
const schemaVersion = "schema_routing_1";
const policyVersion = "policy_routing_1";
const limits = { maxRows: 100, maxResultBytes: 64_000, timeoutMs: 1_000, maxStatements: 8 };
const read = { sql: "SELECT id, name FROM projects ORDER BY id", params: {} };
const insert = (id, name = id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name } });
const envelope = (...statements) => ({ statements });
const encode = (value) => value === null ? { type: "null" } : typeof value === "number"
  ? { type: "integer", value: String(value) } : { type: "text", value };

// Exercise real SQL, rollback, and transaction visibility through the real HTTP transport.
// Only the remote HTTP server and Cloudflare storage/routing are simulated.
const harness = async (t, { hooks = true, idempotencyTable = true, customizeProvider = (provider) => provider, customizeBinding = (binding) => binding } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "policysql-routing-"));
  const runtime = PolicySqlRuntime.newWithPhysicalSchema(
    example("catalog.yaml"), hooks ? example("policy.yaml") : example("policy.yaml").split("commit_checks:")[0],
    schemaVersion, policyVersion,
    JSON.stringify({ max_rows: 100, max_result_bytes: 64_000, timeout_ms: 1_000, max_statements: 8 }),
    example("physical-schema.json"),
  );
  const databases = new Map();
  for (const tenant of ["a", "b"]) {
    const path = join(directory, `${tenant}.sqlite`);
    const database = new DatabaseSync(path);
    database.exec(example("schema.sql"));
    if (idempotencyTable) database.exec(example("idempotency.sql"));
    database.prepare("INSERT INTO projects VALUES (?, ?, ?)").run("seed", `tenant_${tenant}`, `database_${tenant}`);
    database.prepare("INSERT INTO projects VALUES (?, ?, ?)").run("hidden", "another_tenant", "hidden");
    databases.set(tenant, { path, database });
  }
  const events = [];
  const connections = new Map();
  const acceptedTokens = new Map(["a", "b"].map((tenant) => [tenant, new Set([`token_${tenant}`])]));
  const remote = async (url, options) => {
    const tenant = new URL(url).hostname.split(".")[0];
    assert.ok(databases.has(tenant), "no fallback or unregistered network destination");
    if (!acceptedTokens.get(tenant).has(options.headers.authorization.replace(/^Bearer /, ""))) {
      return Response.json({ error: "Credential rejected" }, { status: 401 });
    }
    assert.equal(options.redirect, "error");
    const input = JSON.parse(options.body);
    let baton = input.baton;
    if (!baton) {
      assert.match(input.requests[0].stmt.sql, /^BEGIN /);
      baton = crypto.randomUUID();
      connections.set(baton, { tenant, database: new DatabaseSync(databases.get(tenant).path) });
    }
    const connection = connections.get(baton);
    assert.equal(connection?.tenant, tenant, "transaction baton never crosses a database boundary");
    const results = [];
    for (const request of input.requests) {
      if (request.type === "close") {
        connection.database.close();
        connections.delete(baton);
        baton = null;
        results.push({ type: "ok", response: { type: "close" } });
        continue;
      }
      const { sql, named_args: args } = request.stmt;
      events.push({ tenant, sql, baton, credential: options.headers.authorization });
      try {
        const statement = connection.database.prepare(sql);
        statement.setReturnArrays(true);
        const params = Object.fromEntries(args.map(({ name, value }) => [name, value.type === "null" ? null : value.type === "integer" ? Number(value.value) : value.value]));
        const rows = args.length ? statement.all(params) : statement.all();
        const columns = statement.columns().map((column) => ({ name: column.name, decltype: column.type ?? "TEXT" }));
        const affected = /^(INSERT|UPDATE|DELETE)\b/i.test(sql)
          ? connection.database.prepare("SELECT changes() AS n").get().n : 0;
        results.push({ type: "ok", response: { type: "execute", result: {
          cols: columns, rows: rows.map((row) => row.map(encode)), affected_row_count: affected,
          rows_read: rows.length, rows_written: affected, query_duration_ms: 1,
        } } });
      } catch {
        results.push({ type: "error", error: { message: "SQL rejected" } });
      }
    }
    return Response.json({ baton, results });
  };
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: "test-key", alg: "ES256" });
  const env = {
    POLICYSQL_ENVIRONMENT: "test",
    POLICYSQL_JWT_ISSUER: "https://issuer.test", POLICYSQL_JWT_AUDIENCE: "routing",
    POLICYSQL_JWKS_JSON: JSON.stringify({ keys: [jwk] }),
    POLICYSQL_RATE_LIMITER: { limit: async () => ({ success: true }) },
    POLICYSQL_PUBLIC_BASE_URL: "https://worker.test",
    POLICYSQL_COST_CATALOG_JSON: JSON.stringify({ maxEstimatedRowsRead: 1000, maxEstimatedRowsWritten: 1000, resources: { 1: { upperRows: 100 } } }),
    TENANT_A_TOKEN: "token_a", TENANT_B_TOKEN: "token_b", TENANT_A_ENABLED: "true", TENANT_B_ENABLED: "true",
    VALIDATOR_URL: "https://validator.test", VALIDATOR_SECRET: "test-validator-secret-0001",
  };
  let checks = 0;
  let connects = 0;
  const registry = createDatabaseRegistry(["a", "b"].map((tenant) => ({
    environment: "test", tenant: `tenant_${tenant}`, databaseId: `db_${tenant}`, generation: "1",
    url: `https://${tenant}.test`, tokenEnv: `TENANT_${tenant.toUpperCase()}_TOKEN`, enabledEnv: `TENANT_${tenant.toUpperCase()}_ENABLED`,
  })), () => runtime.snapshot, (credentials, id) => new TursoHttpTransport(credentials, id, remote));
  const provider = registry.provider;
  const database = customizeProvider({
    ...provider,
    check(binding, bindings) { checks++; return provider.check(binding, bindings); },
    connect(...args) { connects++; return provider.connect(...args); },
  });
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const owners = new Map();
  const hooksSeen = [];
  const state = () => {
    const data = new Map();
    return { ...ctx, storage: {
      get: async (key) => structuredClone(data.get(key)),
      put: async (key, value) => { data.set(key, structuredClone(value)); },
      setAlarm: async () => {},
    } };
  };
  let app;
  let validator = async (hook) => {
    const query = await app.fetchCallback(new Request(hook.query.url, {
      method: "POST", headers: { authorization: `Bearer ${hook.query.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sequence: 1, ...read }),
    }), env, ctx);
    const result = await query.json();
    hooksSeen.push({ hook, result, status: query.status });
    return query.ok;
  };
  const makeOwner = (ownerState) => new TransactionOwnerCore(ownerState, env, () => runtime, database,
    async (_url, options) => Response.json({ version: "1", allowed: await validator(JSON.parse(options.body)) }));
  env.TRANSACTION_OWNER = {
    idFromName: (name) => name,
    get(name) {
      if (!owners.has(name)) {
        const ownerState = state();
        owners.set(name, { state: ownerState, owner: makeOwner(ownerState) });
      }
      return { fetch: (url, options) => owners.get(name).owner.fetch(new Request(url, options)) };
    },
  };
  app = createApp({ getRuntime: () => runtime, database, publicConfig: { schemaVersion, policyVersion, limits } });
  const token = (tenant, overrides = {}, jwt = {}) => new SignJWT({
    policysql: { roles: ["member"], default_role: "member", access: ["execute", "explain", "catalog"], session: { tenant_id: `tenant_${tenant}` } },
    ...overrides,
  }).setProtectedHeader({ alg: "ES256", kid: "test-key" }).setSubject("same_user")
    .setIssuer(jwt.issuer ?? "https://issuer.test").setAudience(jwt.audience ?? "routing").setIssuedAt().setExpirationTime(jwt.expires ?? "5m").sign(privateKey);
  const tokens = { a: await token("a"), b: await token("b") };
  const request = async (tenant, path, body, key = "same-idempotency-key", customToken = tokens[tenant], extraHeaders = {}) => {
    const input = new Request(`https://worker.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${customToken}`, "content-type": "application/json", ...(key === null ? {} : { "idempotency-key": key }), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response = path.startsWith("/v1/commit-checks/")
      ? await app.fetchCallback(input, env, ctx)
      : await app.fetch(input, env, ctx, customizeBinding(registry.binding(`db_${tenant}`, env)));
    return { status: response.status, body: await response.json() };
  };
  const flush = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  t.after(async () => {
    await flush();
    for (const { database: connection } of connections.values()) connection.close();
    for (const { database: db } of databases.values()) db.close();
    runtime.free();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    runtime, env, app, ctx, database, databases, events, owners, hooksSeen, token, request, flush,
    binding: (tenant) => registry.binding(`db_${tenant}`, env),
    setValidator(value) { validator = value; },
    counts: () => ({ checks, connects }),
    replaceOwner(id) { const entry = owners.get(id); entry.owner = makeOwner(entry.state); },
    rotateCredential(tenant, value) {
      env[`TENANT_${tenant.toUpperCase()}_TOKEN`] = value;
      acceptedTokens.get(tenant).add(value);
    },
    revokeCredential(tenant, value) { acceptedTokens.get(tenant).delete(value); },
    rows: (tenant) => databases.get(tenant).database.prepare("SELECT id, name FROM projects WHERE tenant_id = ? ORDER BY id").all(`tenant_${tenant}`).map((row) => ({ ...row })),
  };
};

test("parallel JWT/Wasm/HTTP reads and cost observations stay on their selected SQLite databases", async (t) => {
  const h = await harness(t);
  const results = await Promise.all(["a", "b"].map((tenant) => h.request(tenant, "/v1/transactions:execute", envelope(read))));
  for (const [index, tenant] of ["a", "b"].entries()) {
    assert.equal(results[index].status, 200, JSON.stringify(results[index].body));
    assert.deepEqual(results[index].body.results[0].rows, [{ id: "seed", name: `database_${tenant}` }]);
  }
  await h.flush();
  for (const tenant of ["a", "b"]) assert.ok(h.events.some((event) => event.tenant === tenant && event.sql.startsWith("EXPLAIN QUERY PLAN")));
  assert.equal(h.env.TURSO_DATABASE_URL, undefined, "injected transports do not require the fixed DB env");
  assert.ok(h.counts().checks >= 2);
});

test("invalid JWT and wrong endpoint access never connect or check a database", async (t) => {
  const h = await harness(t);
  for (const customToken of ["invalid", await h.token("a", { policysql: { roles: ["member"], default_role: "member", access: ["catalog"], session: { tenant_id: "tenant_a" } } })]) {
    assert.equal((await h.request("a", "/v1/transactions:execute", envelope(read), undefined, customToken)).status, 401);
  }
  assert.equal(h.counts().checks, 0);
  for (const jwt of [{ issuer: "https://other-issuer.test" }, { audience: "another-app" }, { expires: "-1h" }]) {
    assert.equal((await h.request("a", "/v1/transactions:execute", envelope(read), undefined, await h.token("a", {}, jwt))).status, 401);
  }
  assert.equal(h.counts().checks, 0);
  assert.equal(h.counts().connects, 0);
  assert.equal(h.events.length, 0);
});

test("Catalog and Explain validate the binding without opening a DB connection", async (t) => {
  const h = await harness(t);
  assert.equal((await h.request("a", "/v1/catalog")).status, 200);
  assert.equal((await h.request("a", "/v1/transactions:explain", envelope(read))).status, 200);
  h.env.TENANT_A_ENABLED = "false";
  assert.equal((await h.request("a", "/v1/catalog")).status, 403);
  assert.equal(h.counts().connects, 0);
});

test("a missing request database is detected even when legacy Turso env credentials exist", async (t) => {
  const h = await harness(t);
  const env = { ...h.env, TURSO_DATABASE_URL: "https://a.test", TURSO_AUTH_TOKEN: "token_a" };
  for (const database of [undefined, null]) {
    const response = await h.app.fetch(new Request("https://worker.test/v1/transactions:execute", {
      method: "POST", headers: { authorization: `Bearer ${await h.token("a")}`, "content-type": "application/json" },
      body: JSON.stringify(envelope(read)),
    }), env, h.ctx, database);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, "POLICYSQL_DATABASE_REQUIRED");
  }
  assert.equal(h.counts().checks, 0);
  assert.equal(h.counts().connects, 0);
});

test("DB injection is independent of JWT database claims, including absent or conflicting claims", async (t) => {
  const h = await harness(t);
  for (const claims of [{}, { database: { id: "db_b", generation: "old", url: "https://evil.test" } }, { database: "malformed" }]) {
    const result = await h.request("a", "/v1/transactions:execute", envelope(read), undefined, await h.token("a", claims));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.results[0].rows, [{ id: "seed", name: "database_a" }]);
  }
  await h.flush();
  assert.ok(h.events.every((event) => event.tenant === "a"));
});

test("the callback entrypoint cannot be used to bypass required DB injection", async (t) => {
  const h = await harness(t);
  for (const path of ["/v1/transactions:execute", "/v1/catalog", "/healthz"]) {
    const response = await h.app.fetchCallback(new Request(`https://worker.test${path}`, { method: "POST" }), h.env, h.ctx);
    assert.equal(response.status, 404);
  }
  assert.equal(h.counts().connects, 0);
});

test("missing DB binding in an internal DO request fails before a connection is opened", async (t) => {
  const h = await harness(t);
  const owner = new TransactionOwnerCore({ storage: {} }, h.env, () => h.runtime, h.database);
  const response = await owner.fetch(new Request("https://owner/begin", { method: "POST", body: JSON.stringify({
    transactionId: `tx_${"a".repeat(32)}`, authFingerprint: "b".repeat(64), startFingerprint: "c".repeat(64),
    mode: "read", auth: {}, snapshot: h.runtime.snapshot,
  }) }));
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "POLICYSQL_DATABASE_REQUIRED");
  assert.equal(h.counts().connects, 0);
});

test("client headers, body fields, and SQL cannot replace the wrapper-selected database", async (t) => {
  const h = await harness(t);
  const result = await h.request("a", "/v1/transactions:execute", envelope(read), undefined, undefined, {
    "x-database-id": "db_b", "turso-database-url": "https://b.test", "policysql-database": "db_b",
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.results[0].rows, [{ id: "seed", name: "database_a" }]);
  await h.flush();
  const before = h.counts().connects;
  const injected = await h.request("a", "/v1/transactions:execute", { ...envelope(read), databaseBinding: { databaseId: "db_b" } });
  assert.equal(injected.status, 400);
  const attach = await h.request("a", "/v1/transactions:execute", envelope({ sql: "ATTACH DATABASE :url AS other", params: { url: "https://b.test" } }));
  assert.ok(attach.status >= 400);
  assert.equal(h.counts().connects, before);
  assert.ok(h.events.every((event) => event.tenant === "a"));
});

test("ordinary atomic writes isolate identical keys, replay once, and roll back all items on a late failure", async (t) => {
  const h = await harness(t, { hooks: false });
  const body = envelope(insert("new"));
  const results = await Promise.all(["a", "b"].map((tenant) => h.request(tenant, "/v1/transactions:execute", body)));
  assert.deepEqual(results.map((result) => result.status), [200, 200]);
  assert.notEqual(results[0].body.transactionId, results[1].body.transactionId);
  await h.flush();
  const replay = await h.request("a", "/v1/transactions:execute", body);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.transactionId, results[0].body.transactionId);
  assert.equal((await h.request("a", "/v1/transactions:execute", envelope(insert("different")))).status, 409);
  assert.equal((await h.request("a", "/v1/transactions:execute", envelope(insert("rollback"), insert("seed")), "late-failure-key-001")).status, 503);
  assert.equal(h.rows("a").some((row) => row.id === "rollback"), false);
  assert.equal(h.rows("b").some((row) => row.id === "rollback"), false);
  for (const tenant of ["a", "b"]) assert.equal(h.databases.get(tenant).database.prepare("SELECT count(*) AS n FROM policysql_idempotency").get().n, 1);
});

for (const hooks of [false, true]) {
  for (const idempotencyTable of [false, true]) {
    test(`unkeyed writes never access idempotency storage and run independently (DO=${hooks}, table=${idempotencyTable})`, async (t) => {
      const h = await harness(t, { hooks, idempotencyTable });
      if (idempotencyTable) h.databases.get("a").database.exec("INSERT INTO policysql_idempotency VALUES ('untouched', 'fingerprint', '{}')");
      const update = envelope({ sql: "UPDATE projects SET name = :name WHERE id = :id RETURNING id, name", params: { id: "seed", name: "changed" } });
      const first = await h.request("a", "/v1/transactions:execute", update, null);
      const second = await h.request("a", "/v1/transactions:execute", update, null);
      assert.equal(first.status, 200, JSON.stringify(first));
      assert.equal(second.status, 200, JSON.stringify(second));
      assert.notEqual(first.body.transactionId, second.body.transactionId);
      assert.deepEqual(second.body.results[0].rows, [{ id: "seed", name: "changed" }]);
      // Separate databases allow real concurrent writers in the SQLite test server.
      const parallel = await Promise.all(["a", "b"].map((tenant) => h.request(tenant, "/v1/transactions:execute", envelope(insert("unkeyed")), null)));
      assert.deepEqual(parallel.map((result) => result.status), [200, 200]);
      await h.flush();
      assert.equal(h.events.filter(({ sql }) => sql.startsWith("UPDATE")).length, 2);
      assert.equal(h.events.some(({ sql }) => /policysql_idempotency/i.test(sql)), false);
      if (hooks) {
        assert.equal(h.owners.size, 4);
        assert.equal(h.hooksSeen.length, 4);
        assert.equal(new Set(h.hooksSeen.map(({ hook }) => hook.query.url)).size, 4);
        for (const { result, status } of h.hooksSeen) assert.equal(status, 200, JSON.stringify(result));
        assert.ok(h.hooksSeen.slice(2).every(({ result }) => result.rows.some((row) => row.id === "unkeyed")));
      }
      if (idempotencyTable) assert.deepEqual(
        h.databases.get("a").database.prepare("SELECT * FROM policysql_idempotency").all().map((row) => ({ ...row })),
        [{ key_hash: "untouched", fingerprint: "fingerprint", response_json: "{}" }],
      );
    });
  }

  test(`keyed writes still fail before mutation when the table is missing (DO=${hooks})`, async (t) => {
    const h = await harness(t, { hooks, idempotencyTable: false });
    const result = await h.request("a", "/v1/transactions:execute", envelope(insert("must_not_run")));
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, "POLICYSQL_DATABASE_UNAVAILABLE");
    assert.equal(h.events.some(({ sql }) => sql.startsWith("INSERT INTO projects")), false);
    assert.ok(h.events.some(({ sql }) => sql === "ROLLBACK"));
    assert.equal(h.hooksSeen.length, 0);
  });

  test(`unkeyed requests roll back on late SQL errors (DO=${hooks})`, async (t) => {
    const h = await harness(t, { hooks, idempotencyTable: false });
    const result = await h.request("a", "/v1/transactions:execute", envelope(insert("rollback"), insert("seed")), null);
    assert.equal(result.status, 503);
    assert.equal(h.rows("a").some((row) => row.id === "rollback"), false);
    assert.equal(h.events.some(({ sql }) => /policysql_idempotency/i.test(sql)), false);
    assert.ok(h.events.some(({ sql }) => sql === "ROLLBACK"));
  });
}

test("unkeyed commit-check rejection rolls back the update", async (t) => {
  const h = await harness(t, { idempotencyTable: false });
  h.setValidator(async () => false);
  const result = await h.request("a", "/v1/transactions:execute", envelope(insert("denied")), null);
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "POLICYSQL_COMMIT_CHECK_REJECTED");
  assert.equal(h.rows("a").some((row) => row.id === "denied"), false);
  assert.ok(h.events.some(({ sql }) => sql === "ROLLBACK"));
  assert.equal(h.events.some(({ sql }) => /policysql_idempotency/i.test(sql)), false);
});

test("interactive starts without keys are distinct and retain command retries without a table", async (t) => {
  const h = await harness(t, { idempotencyTable: false });
  // Two simultaneous read transactions on the same database must have separate owners.
  const starts = await Promise.all([1, 2].map(() => h.request("a", "/v1/transactions", { mode: "read" }, null)));
  assert.deepEqual(starts.map((result) => result.status), [201, 201], JSON.stringify(starts));
  assert.notEqual(starts[0].body.transactionId, starts[1].body.transactionId);
  for (const start of starts) {
    const path = `/v1/transactions/${start.body.transactionId}`;
    const command = { sequence: 1, ...read };
    const first = await h.request("a", `${path}/statements`, command, null);
    assert.equal(first.status, 200);
    assert.deepEqual((await h.request("a", `${path}/statements`, command, null)).body, first.body);
    assert.equal((await h.request("a", `${path}/rollback`, { sequence: 2 }, null)).status, 200);
  }
  const write = await h.request("a", "/v1/transactions", { mode: "write" }, null);
  assert.equal(write.status, 201);
  const path = `/v1/transactions/${write.body.transactionId}`;
  assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert("interactive_unkeyed") }, null)).status, 200);
  const committed = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
  assert.equal(committed.status, 200);
  assert.deepEqual((await h.request("a", `${path}/commit`, { sequence: 2 }, null)).body, committed.body);
  await h.flush();
  assert.equal(h.hooksSeen.length, 1);
  assert.ok(h.rows("a").some((row) => row.id === "interactive_unkeyed"));
  assert.equal(h.events.some(({ sql }) => /policysql_idempotency/i.test(sql)), false);
});

test("explicit invalid keys remain errors before database execution", async (t) => {
  const h = await harness(t);
  for (const key of ["", "short", "a".repeat(129), "request-key-0001,request-key-0002", "invalid key with spaces"]) {
    for (const [path, body] of [["/v1/transactions:execute", envelope(insert("invalid"))], ["/v1/transactions", { mode: "read" }]]) {
      const result = await h.request("a", path, body, key);
      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, "POLICYSQL_IDEMPOTENCY_KEY_REQUIRED");
    }
  }
  assert.equal(h.events.length, 0);
  assert.equal(h.owners.size, 0);
});

test("DO atomic callbacks see uncommitted rows on the initiating database and replay without another hook", async (t) => {
  const h = await harness(t);
  const results = await Promise.all(["a", "b"].map((tenant) => h.request(tenant, "/v1/transactions:execute", envelope(insert("pending")))));
  assert.deepEqual(results.map((result) => result.status), [200, 200], JSON.stringify(results));
  assert.equal(h.hooksSeen.length, 2);
  for (const { hook, result, status } of h.hooksSeen) {
    assert.equal(status, 200);
    const tenant = hook.session.tenant_id.slice(-1);
    assert.deepEqual(result.rows, [{ id: "pending", name: "pending" }, { id: "seed", name: `database_${tenant}` }]);
    assert.equal(JSON.stringify(hook).includes("token_a"), false);
  }
  await h.flush();
  assert.equal((await h.request("a", "/v1/transactions:execute", envelope(insert("pending")))).status, 200);
  assert.equal(h.hooksSeen.length, 2);
  for (const entry of h.owners.values()) assert.equal(JSON.stringify(await entry.state.storage.get("transaction")).includes("token_"), false);
});

test("interactive transactions pin DB and snapshot, reject cross-tenant commands, and preserve commit/rollback replay", async (t) => {
  const h = await harness(t);
  const starts = await Promise.all(["a", "b"].map((tenant) => h.request(tenant, "/v1/transactions", { mode: "write", expected: { schemaVersion, policyVersion } })));
  assert.deepEqual(starts.map((result) => result.status), [201, 201], JSON.stringify(starts));
  const [a, b] = starts.map((result) => result.body.transactionId);
  assert.notEqual(a, b);
  const command = { sequence: 1, ...insert("interactive") };
  assert.equal((await h.request("a", `/v1/transactions/${a}/statements`, command)).status, 200);
  assert.equal((await h.request("b", `/v1/transactions/${a}/statements`, command)).status, 409);
  assert.equal((await h.request("a", `/v1/transactions/${a}/statements`, command)).status, 200);
  assert.equal((await h.request("b", `/v1/transactions/${b}/statements`, command)).status, 200);
  const committed = await h.request("a", `/v1/transactions/${a}/commit`, { sequence: 2 });
  assert.equal(committed.body.status, "committed", JSON.stringify(committed));
  assert.deepEqual((await h.request("a", `/v1/transactions/${a}/commit`, { sequence: 2 })).body, committed.body);
  assert.equal((await h.request("b", `/v1/transactions/${b}/rollback`, { sequence: 2 })).body.status, "rolled_back");
  assert.equal(h.rows("a").some((row) => row.id === "interactive"), true);
  assert.equal(h.rows("b").some((row) => row.id === "interactive"), false);
  assert.equal(h.hooksSeen.length, 1);
});

test("owner replacement never reconnects or resumes an interactive transaction", async (t) => {
  const h = await harness(t);
  const start = await h.request("a", "/v1/transactions", { mode: "read" });
  assert.equal(start.status, 201);
  h.replaceOwner(start.body.transactionId);
  const connects = h.counts().connects;
  const response = await h.request("a", `/v1/transactions/${start.body.transactionId}/statements`, { sequence: 1, ...read });
  assert.equal(response.status, 409);
  assert.equal(h.counts().connects, connects);
});

test("revocation during validation rejects the callback and rolls back the original DB", async (t) => {
  const h = await harness(t);
  h.setValidator(async (hook) => {
    h.env.TENANT_A_ENABLED = "false";
    const response = await h.request("a", new URL(hook.query.url).pathname, { sequence: 1, ...read }, undefined, hook.query.token);
    assert.equal(response.status, 403);
    return true;
  });
  const result = await h.request("a", "/v1/transactions:execute", envelope(insert("revoked")));
  assert.ok(result.status >= 400);
  assert.equal(h.rows("a").some((row) => row.id === "revoked"), false);
  assert.equal(h.events.some((event) => event.tenant === "b"), false);
});

test("wrapper failures are bounded safe errors without fallback or credential leakage", async (t) => {
  const h = await harness(t, { customizeProvider: (provider) => ({ ...provider, connect() { throw new Error("secret-token-private-url"); } }) });
  const result = await h.request("a", "/v1/transactions:execute", envelope(read));
  assert.equal(result.status, 503);
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
  assert.equal(h.events.length, 0);
});

test("DO cost observations use the selected database after updates", async (t) => {
  const h = await harness(t);
  const update = { sql: "UPDATE projects SET name = :name WHERE id = :id RETURNING id, name", params: { id: "seed", name: "updated" } };
  for (const tenant of ["a", "b"]) {
    assert.equal((await h.request(tenant, "/v1/transactions:execute", envelope(update))).status, 200);
  }
  await h.flush();
  for (const tenant of ["a", "b"]) {
    assert.ok(h.events.some((event) => event.tenant === tenant && event.sql.startsWith("EXPLAIN QUERY PLAN")));
    assert.deepEqual(h.rows(tenant), [{ id: "seed", name: "updated" }]);
  }
});

test("callback capability from another database cannot read the active transaction", async (t) => {
  const h = await harness(t);
  let firstToken;
  h.setValidator(async (hook) => { firstToken = hook.query.token; return true; });
  assert.equal((await h.request("a", "/v1/transactions:execute", envelope(insert("a_only")))).status, 200);
  h.setValidator(async (hook) => {
    const before = h.events.length;
    const wrong = await h.request("b", new URL(hook.query.url).pathname, { sequence: 1, ...read }, undefined, firstToken);
    assert.equal(wrong.status, 409);
    assert.equal(h.events.slice(before).some((event) => event.sql.startsWith("SELECT") && event.sql.includes("projects")), false);
    return true;
  });
  assert.equal((await h.request("b", "/v1/transactions:execute", envelope(insert("b_only")))).status, 409);
  assert.equal(h.rows("b").some((row) => row.id === "b_only"), false);
});

test("a changed runtime snapshot fails before another statement and rolls back", async (t) => {
  const h = await harness(t);
  const start = await h.request("a", "/v1/transactions", { mode: "write" });
  const id = start.body.transactionId;
  assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("stale") })).status, 200);
  h.owners.get(id).owner.getRuntime = () => ({ snapshot: "new_snapshot" });
  assert.equal((await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 })).status, 409);
  assert.equal(h.rows("a").some((row) => row.id === "stale"), false);
});

test("Worker/DO provider configuration mismatch fails before connecting", async (t) => {
  const h = await harness(t);
  const start = await h.request("a", "/v1/transactions", { mode: "read" });
  const entry = h.owners.get(start.body.transactionId);
  const message = await entry.state.storage.get("transaction");
  const ownerWithoutProvider = new TransactionOwnerCore(entry.state, h.env, () => h.runtime, {
    check: () => false,
    connect: () => { assert.fail("No default database is available"); },
  });
  const response = await ownerWithoutProvider.fetch(new Request("https://owner/begin", { method: "POST", body: JSON.stringify({
    transactionId: message.transactionId, authFingerprint: message.authFingerprint, startFingerprint: message.startFingerprint,
    mode: "read", auth: message.auth, databaseBinding: message.databaseBinding, snapshot: message.snapshot,
  }) }));
  assert.equal(response.status, 403);
});

for (const hooks of [false, true]) {
  test(`generation changes conflict on retry without duplicating writes (DO=${hooks})`, async (t) => {
    let generation = "1";
    const h = await harness(t, { hooks, customizeBinding: (binding) => ({ ...binding, generation }), customizeProvider: (provider) => ({
      check: (binding, env) => provider.check({ ...binding, generation: "1" }, env),
      connect: (binding, ...args) => provider.connect({ ...binding, generation: "1" }, ...args),
    }) });
    const body = envelope(insert("one_write"));
    assert.equal((await h.request("a", "/v1/transactions:execute", body)).status, 200);
    generation = "2";
    assert.equal((await h.request("a", "/v1/transactions:execute", body)).status, 409);
    assert.equal(h.rows("a").filter((row) => row.id === "one_write").length, 1);
  });
}

test("a stalled provider times out without selecting a default database", async (t) => {
  const h = await harness(t, { customizeProvider: (provider) => ({ ...provider, check: () => new Promise(() => {}) }) });
  const result = await h.request("a", "/v1/transactions:execute", envelope(read));
  assert.equal(result.status, 503);
  assert.equal(h.counts().connects, 0);
});

test("credential rotation changes new connections while an interactive transaction keeps its connection", async (t) => {
  const h = await harness(t);
  const start = await h.request("a", "/v1/transactions", { mode: "write" });
  const id = start.body.transactionId;
  h.rotateCredential("a", "token_a_rotated");
  assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("rotated") })).status, 200);
  const write = h.events.find((event) => event.sql.startsWith('INSERT INTO "projects"'));
  assert.equal(write.credential, "Bearer token_a");
  assert.equal((await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 })).body.status, "committed");
  const afterCommit = h.events.length;
  assert.equal((await h.request("a", "/v1/transactions:execute", envelope(read))).status, 200);
  await h.flush();
  assert.ok(h.events.slice(afterCommit).every((event) => event.credential === "Bearer token_a_rotated"));
});

test("revoking an active connection credential fails without reconnecting", async (t) => {
  const h = await harness(t);
  const start = await h.request("a", "/v1/transactions", { mode: "write" });
  const id = start.body.transactionId;
  assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("uncommitted") })).status, 200);
  await h.flush();
  h.rotateCredential("a", "token_a_rotated");
  h.revokeCredential("a", "token_a");
  const connects = h.counts().connects;
  assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 2, ...read })).status, 503);
  assert.equal(h.counts().connects, connects);
  assert.equal(h.rows("a").some((row) => row.id === "uncommitted"), false);
  assert.equal((await h.owners.get(id).state.storage.get("transaction")).status, "failed");
});

test("DO atomic SQL failure rolls back every preceding item on the selected database", async (t) => {
  const h = await harness(t);
  const response = await h.request("b", "/v1/transactions:execute", envelope(insert("rolled_back"), insert("seed")));
  assert.equal(response.status, 503);
  assert.equal(h.rows("b").some((row) => row.id === "rolled_back"), false);
  assert.equal(h.hooksSeen.length, 0);
});

for (const scenario of JSON.parse(readFileSync(new URL("./fixtures/database-deadlines.json", import.meta.url), "utf8"))) {
  test(`atomic deadline: ${scenario.name}`, async (t) => {
    let now = Date.now();
    let connected = false;
    t.mock.method(Date, "now", () => now);
    const h = await harness(t, { hooks: false, customizeProvider: (provider) => ({
      check(...args) {
        if (connected) now += scenario.commitCheckMs;
        return provider.check(...args);
      },
      connect(...args) {
        now += scenario.connectMs;
        connected = true;
        return provider.connect(...args);
      },
    }) });
    const response = await h.request("a", "/v1/transactions:execute", envelope(insert("deadline")));
    assert.equal(response.status, scenario.status, JSON.stringify(response));
    const succeeds = scenario.status === 200;
    assert.equal(h.events.some(({ sql }) => sql.startsWith("BEGIN")), scenario.begins);
    assert.equal(h.events.some(({ sql }) => sql === "COMMIT"), succeeds);
    assert.equal(h.events.some(({ sql }) => sql === "ROLLBACK"), !succeeds && scenario.begins);
    assert.equal(h.rows("a").some(({ id }) => id === "deadline"), succeeds);
    assert.equal(h.databases.get("a").database.prepare("SELECT count(*) AS n FROM policysql_idempotency").get().n, succeeds ? 1 : 0);
    if (!succeeds) assert.equal(response.body.error.code, "POLICYSQL_DATABASE_TIMEOUT");
  });
}

test("a slow commit authorization cannot extend the transaction deadline", async () => {
  const binding = { version: 1, scope: "test:a", databaseId: "a", generation: "1", snapshot: "snapshot" };
  let committed = false;
  let rolledBack = false;
  let slow = false;
  const provider = {
    check: async () => { if (slow) await new Promise((resolve) => setTimeout(resolve, 150)); return true; },
    connect: () => ({ begin: async () => ({ open: true, usage: [], execute: async () => [],
      commit: async () => { committed = true; }, rollback: async () => { rolledBack = true; },
    }) }),
  };
  const transport = await databaseTransportFactory(provider, binding)({}, "request");
  const transaction = await transport.begin("write", 100);
  slow = true;
  await assert.rejects(transaction.commit(), (error) => error.code === "POLICYSQL_DATABASE_TIMEOUT");
  assert.equal(committed, false);
  assert.equal(rolledBack, true);
});

test("database identity scopes retries while generation/snapshot changes conflict instead of making a fresh key", async () => {
  const binding = { version: 1, scope: "test:tenant_a", databaseId: "db_a", generation: "1", snapshot: "snapshot_1" };
  const auth = { subject: "u", role: "member", session: { tenant_id: "a" } };
  const env = { POLICYSQL_JWT_ISSUER: "issuer" };
  const request = new Request("https://worker.test", { headers: { "idempotency-key": "same-idempotency-key" } });
  const digest = (value) => requestIdempotency(request, env, auth, envelope(read), "execute", value);
  const first = await digest(binding);
  for (const changed of [{ ...binding, generation: "2" }, { ...binding, snapshot: "snapshot_2" }]) {
    const next = await digest(changed);
    assert.equal(next.keyHash, first.keyHash);
    assert.notEqual(next.fingerprint, first.fingerprint);
    assert.notEqual(await authFingerprint(env, auth, binding), await authFingerprint(env, auth, changed));
  }
  assert.notEqual((await digest({ ...binding, databaseId: "db_b" })).keyHash, first.keyHash);
});

test("binding validation rejects extra credentials and snapshots and captures an immutable copy", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/database-bindings.json", import.meta.url), "utf8"));
  assert.deepEqual(validateDatabaseBinding(fixture.valid, "snapshot_1"), fixture.valid);
  for (const fields of fixture.invalidOverrides) {
    assert.throws(() => validateDatabaseBinding({ ...fixture.valid, ...fields }, "snapshot_1"));
  }
  const original = { version: 1, scope: "test:a", databaseId: "a", generation: "1", snapshot: "snapshot" };
  const captured = validateDatabaseBinding(original, "snapshot");
  original.databaseId = "b";
  assert.equal(captured.databaseId, "a");
  assert.ok(Object.isFrozen(captured));
  assert.throws(() => validateDatabaseBinding({ ...original, token: "secret" }, "snapshot"));
  assert.throws(() => validateDatabaseBinding(original, "different"));
});

test("malformed database configuration cannot enable a legacy fixed-DB fallback", () => {
  for (const database of [undefined, null, false, {}, { connect() {} }]) {
    assert.throws(() => createApp({ getRuntime: () => ({}), database }), TypeError);
    assert.throws(() => new TransactionOwnerCore({}, {}, () => ({}), database), TypeError);
  }
  const database = { check() {}, connect() {} };
  assert.throws(() => createApp({ getRuntime: () => ({}), database, transportFactory() {} }), TypeError);
  assert.throws(() => createApp({ getRuntime: () => ({}), database, costTransportFactory() {} }), TypeError);
});

test("revocation before direct commit rolls back without opening a replacement connection", async () => {
  const binding = { version: 1, scope: "test:a", databaseId: "a", generation: "1", snapshot: "snapshot" };
  let allowed = true;
  let commits = 0;
  let rollbacks = 0;
  const provider = { check: () => allowed, connect: () => ({ begin: async () => ({
    open: true, usage: [], execute: async () => [],
    commit: async () => { commits++; }, rollback: async () => { rollbacks++; },
  }) }) };
  const transport = await databaseTransportFactory(provider, binding)({}, "request");
  const transaction = await transport.begin("write", 1000);
  allowed = false;
  await assert.rejects(transaction.commit(), (error) => error.code === "POLICYSQL_DATABASE_BINDING_REJECTED");
  assert.equal(commits, 0);
  assert.equal(rollbacks, 1);
});
