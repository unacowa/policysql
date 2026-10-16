import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { initSync, PolicySqlRuntime } from "../../pkg/policysql_cloudflare.js";
import { createApp } from "../../src/app.ts";
import { TransactionOwnerCore } from "../../src/transaction-owner.ts";
import { TursoHttpTransport } from "../../src/turso-http.ts";
import { createDatabaseRegistry } from "../../../../examples/database-routing/provider.ts";

initSync({ module: readFileSync(new URL("../../pkg/policysql_cloudflare_bg.wasm", import.meta.url)) });
const example = (name) => readFileSync(new URL(`../../../../examples/database-routing/${name}`, import.meta.url), "utf8");
const schemaVersion = "schema_routing_1";
const policyVersion = "policy_routing_1";
const limits = { maxRows: 100, maxResultBytes: 64_000, timeoutMs: 1_000, maxStatements: 8 };
const read = { sql: "SELECT id, name FROM projects ORDER BY id", params: {} };
const encode = (value) => value === null ? { type: "null" } : typeof value === "number"
  ? { type: "integer", value: String(value) } : { type: "text", value };

// Exercise real SQL, rollback, and transaction visibility through the real HTTP transport.
// Only the remote HTTP server and Cloudflare storage/routing are simulated.
export const harness = async (t, { hooks = true, idempotencyTable = true, customizeProvider = (provider) => provider, customizeBinding = (binding) => binding, customizePolicy = (policy) => policy } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "policysql-routing-"));
  const runtime = PolicySqlRuntime.newWithPhysicalSchema(
    example("catalog.yaml"), customizePolicy(hooks ? example("policy.yaml") : example("policy.yaml").split("commit_checks:")[0]),
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
