import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { initSync, PolicySqlRuntime } from "../../pkg/policysql_wasm.js";
import { createApp } from "../../src/app.ts";
import { createWorkerEntrypoints } from "../../src/worker.ts";
import { createMemoryTransactionOwners } from "./memory-owner.mjs";
import { createSimulatedDurableObjects } from "./durable-object-owner.mjs";
import { TursoHttpTransport } from "../../src/turso-http.ts";
import { runtimeLimitsJson } from "../../src/limits.ts";
import { createErrorResponse } from "../../src/http/responses.ts";
import { createJwtSessionVerifier } from "../../src/adapters/jwt.ts";
import { createDatabaseRegistry } from "../../../../examples/database-routing/provider.ts";
import { authenticateRequest, createJwtAuthentication } from "../../../../examples/database-routing/auth.ts";
import { configFromEnv } from "../../../../examples/database-routing/config.ts";

initSync({ module: readFileSync(new URL("../../pkg/policysql_wasm_bg.wasm", import.meta.url)) });
const example = (name) => readFileSync(new URL(`../../../../examples/database-routing/${name}`, import.meta.url), "utf8");
const schemaVersion = "schema_routing_1";
const policyVersion = "policy_routing_1";
const limits = { maxRows: 100, maxResultBytes: 64_000, timeoutMs: 1_000, maxStatements: 8 };
const read = { sql: "SELECT id, name FROM projects ORDER BY id", params: {} };

// The adapter owns no copy of the per-value limit (#22); tests read it from the real WASM.
export const MAX_BYTES_PER_VALUE = (() => {
  const runtime = PolicySqlRuntime.newWithPhysicalSchema(
    example("catalog.yaml"), example("policy.yaml"), schemaVersion, policyVersion,
    runtimeLimitsJson(limits),
    example("physical-schema.json"),
  );
  try { return runtime.max_bytes_per_value; } finally { runtime.free(); }
})();
// A Hrana integer is a 64-bit decimal string: bind it exactly (beyond 2^53 as a BigInt).
const exactInteger = (digits) => (Number.isSafeInteger(Number(digits)) ? Number(digits) : BigInt(digits));
// Match Hrana's STANDARD_NO_PAD BLOB serializer, independently of the adapter codec.
const encode = (value) => value === null ? { type: "null" } : typeof value === "number"
  ? { type: "integer", value: String(value) } : value instanceof Uint8Array
    ? { type: "blob", base64: Buffer.from(value).toString("base64").replace(/=+$/, "") } : { type: "text", value };

/** A request body sent as this exact text (numbers JavaScript cannot hold, such as `1e400`). */
export class RawJson {
  constructor(text) { this.text = text; }
}

/**
 * A stored owner record as tests read it. The step machine stores its durable state as JSON
 * text (ADR 0024); the view adds the field names the TypeScript owner used, so assertions read
 * alike: `status` (the phase), `mode`, `authFingerprint`, `databaseBinding`, and `statementCount`. Anything else
 * (a TypeScript-owner object, nothing) is returned as stored.
 */
export const recordView = (value) => {
  if (typeof value !== "string") return value;
  const record = JSON.parse(value);
  return {
    ...record,
    status: record.phase,
    mode: record.identity?.mode,
    authFingerprint: record.identity?.authFingerprint,
    databaseBinding: record.binding,
    statementCount: record.counters?.statements,
  };
};

// The TransactionOwner adapters the harness can run on (ADR 0022). The default is the
// production Durable Objects adapter over a simulated platform.
export const OWNER_ADAPTERS = ["durable-objects", "memory"];

/** Wraps a TransactionOwner port and counts every owner lookup through it. */
export const countingOwners = (port) => {
  const counts = { lookups: 0 };
  return { counts, port: { route(name) { counts.lookups++; return port.route(name); } } };
};

// Exercise real SQL, rollback, and transaction visibility through the real HTTP transport.
// Only the remote HTTP server and the owner platform (Durable Object routing and state, or
// the in-memory owner adapter) are simulated.
export const harness = async (t, { hooks = true, idempotencyTable = true, customizeProvider = (provider) => provider, customizeBinding = (binding) => binding, customizePolicy = (policy) => policy, customizeConfig = (config) => config, fixture, runtimeLimits = limits, ownerAdapter = process.env.POLICYSQL_TEST_OWNER_ADAPTER ?? "durable-objects" } = {}) => {
  assert.ok(OWNER_ADAPTERS.includes(ownerAdapter), "known owner adapter");
  const directory = mkdtempSync(join(tmpdir(), "policysql-routing-"));
  const makeRuntime = (versions = {}) => PolicySqlRuntime.newWithPhysicalSchema(
    fixture?.catalog ?? example("catalog.yaml"), customizePolicy(hooks ? (fixture?.policy ?? example("policy.yaml")) : (fixture?.policy ?? example("policy.yaml")).split("commit_checks:")[0]),
    versions.schemaVersion ?? schemaVersion, versions.policyVersion ?? policyVersion,
    // The wrapper's `RuntimeLimits`, mapped exactly as `createRuntimeFactory` maps them.
    runtimeLimitsJson(runtimeLimits),
    fixture?.physicalSchema ?? example("physical-schema.json"),
  );
  // The deployed runtime; `redeploy` replaces it for the engine, every owner, and the registry.
  let runtime = makeRuntime();
  const extraRuntimes = [];
  const databases = new Map();
  for (const tenant of ["a", "b"]) {
    const path = join(directory, `${tenant}.sqlite`);
    const database = new DatabaseSync(path);
    database.exec(fixture?.schema ?? example("schema.sql"));
    if (idempotencyTable) database.exec(example("idempotency.sql"));
    if (fixture?.seed) fixture.seed(database, tenant);
    else {
      database.prepare("INSERT INTO projects VALUES (?, ?, ?)").run("seed", `tenant_${tenant}`, `database_${tenant}`);
      database.prepare("INSERT INTO projects VALUES (?, ?, ?)").run("hidden", "another_tenant", "hidden");
    }
    databases.set(tenant, { path, database });
  }
  const events = [];
  // Called after the remote database ran each statement; may lose the owner, or throw to
  // fail the transport after the statement took effect.
  let afterStatement = null;
  const connections = new Map();
  const acceptedTokens = new Map(["a", "b"].map((tenant) => [tenant, new Set([`token_${tenant}`])]));
  const remote = async (url, options) => {
    const tenant = new URL(url).hostname.split(".")[0];
    assert.ok(databases.has(tenant), "no fallback or unregistered network destination");
    if (!acceptedTokens.get(tenant).has(options.headers.authorization.replace(/^Bearer /, ""))) {
      return Response.json({ error: "Credential rejected" }, { status: 401 });
    }
    // workerd supports only "follow" and "manual" (#36); redirects are rejected by the transport.
    assert.equal(options.redirect, "manual");
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
      events.push({ tenant, sql, baton, args, credential: options.headers.authorization });
      try {
        const statement = connection.database.prepare(sql);
        statement.setReturnArrays(true);
        const params = Object.fromEntries(args.map(({ name, value }) => [name, value.type === "null" ? null : value.type === "integer" ? exactInteger(value.value) : value.type === "blob" ? Buffer.from(value.base64, "base64") : value.value]));
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
        continue;
      }
      if (afterStatement) await afterStatement({ tenant, sql });
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
  // The example wrapper's provider and configuration, built from its env the way its
  // `deployment(env)` does (ADR 0021). The library receives neither the env nor its names.
  const provider = registry.provider(env);
  const database = customizeProvider({
    ...provider,
    check(binding) { checks++; return provider.check(binding); },
    connect(...args) { connects++; return provider.connect(...args); },
  });
  const config = customizeConfig(configFromEnv(env));
  const pending = [];
  // Background work (cost observation) from the Worker and from owners; `flush` awaits it.
  const background = { run(promise) { pending.push(promise); } };
  // A Workers ExecutionContext, for tests that drive a wrapper's Worker-shaped entry point.
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const hooksSeen = [];
  let app;
  let validator = async (hook) => {
    const query = await app.fetchCallback(new Request(hook.query.url, {
      method: "POST", headers: { authorization: `Bearer ${hook.query.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sequence: 1, ...(fixture?.callbackQuery ?? read) }),
    }));
    const result = await query.json();
    hooksSeen.push({ hook, result, status: query.status });
    return query.ok;
  };
  // Each new owner gets the same ports a wrapper's deployment(env) builds (ADR 0021).
  const ownerDependencies = () => ({
    getRuntime: () => runtime, database, config,
    fetchImpl: async (_url, options) => Response.json({ version: "1", allowed: await validator(JSON.parse(options.body)) }),
  });
  const owners = ownerAdapter === "memory"
    ? createMemoryTransactionOwners(ownerDependencies, { background })
    : createSimulatedDurableObjects(ownerDependencies, { background });
  // Every input the engine forwarded, per owner name, as it left the engine.
  const forwarded = new Map();
  const note = (name, kind, input) => {
    if (!forwarded.has(name)) forwarded.set(name, []);
    forwarded.get(name).push({ kind, input: structuredClone(input) });
  };
  const transactionOwners = {
    route(name) {
      const handle = owners.port.route(name);
      return {
        begin: (input, requestId) => { note(name, "begin", input); return handle.begin(input, requestId); },
        atomic: (input, requestId) => { note(name, "atomic", input); return handle.atomic(input, requestId); },
        command: (kind, input, requestId) => { note(name, kind, input); return handle.command(kind, input, requestId); },
        callbackQuery: (input, requestId) => { note(name, "callbackQuery", input); return handle.callbackQuery(input, requestId); },
      };
    },
  };
  const publicConfig = { schemaVersion, policyVersion };
  const appWith = (ports) => createApp({ getRuntime: () => runtime, database, config, transactionOwners: ports, publicConfig });
  app = appWith(transactionOwners);
  // The Worker-shaped entry point a wrapper calls, built from a fixed deployment. Tests that
  // count runtime use pass their own `getRuntime`.
  const workerApp = (getRuntime = () => runtime, ports = transactionOwners) => createWorkerEntrypoints({
    getRuntime, publicConfig, deployment: () => ({ database, config, transactionOwners: ports }),
  }).app;
  const token = (tenant, overrides = {}, jwt = {}) => new SignJWT({
    policysql: { roles: ["member"], default_role: "member", access: ["execute", "explain", "catalog"], session: { tenant_id: `tenant_${tenant}` } },
    ...overrides,
  }).setProtectedHeader({ alg: "ES256", kid: "test-key" }).setSubject("same_user")
    .setIssuer(jwt.issuer ?? "https://issuer.test").setAudience(jwt.audience ?? "routing").setIssuedAt().setExpirationTime(jwt.expires ?? "5m").sign(privateKey);
  // The trusted session a wrapper passes after authentication (ADR 0019). Library tests
  // pass it directly; `overrides` replaces top-level fields.
  const session = (tenant, overrides = {}) => ({
    principal: "https://issuer.test:same_user", subject: "same_user", roles: ["member"], defaultRole: "member",
    access: ["execute", "explain", "catalog"], session: { tenant_id: `tenant_${tenant}` }, ...overrides,
  });
  // A string credential goes through the example wrapper's JWT authentication first, as in
  // a deployment: 401 from the wrapper, or the verified session passed to the library.
  const authenticate = createJwtAuthentication(createJwtSessionVerifier);
  const request = async (tenant, path, body, key = "same-idempotency-key", credential = session(tenant), extraHeaders = {}) => {
    const input = new Request(`https://worker.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(typeof credential === "string" ? { authorization: `Bearer ${credential}` } : {}),
        "content-type": "application/json", ...(key === null ? {} : { "idempotency-key": key }), ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: body instanceof RawJson ? body.text : JSON.stringify(body) }),
    });
    let response;
    if (path.startsWith("/v1/commit-checks/")) {
      response = await app.fetchCallback(input);
    } else {
      let trusted = credential;
      if (typeof credential === "string") {
        const outcome = await authenticateRequest(authenticate, input, env, "req_wrapper", createErrorResponse);
        if ("response" in outcome) return { status: outcome.response.status, body: await outcome.response.json() };
        trusted = outcome.session;
      }
      response = await app.fetch(input, { database: customizeBinding(registry.binding(`db_${tenant}`, env)), session: trusted }, background);
    }
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
    for (const extra of extraRuntimes) extra.free();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get runtime() { return runtime; },
    env, config, app, ctx, background, database, databases, events, hooksSeen, token, session, request, flush,
    ownerAdapter, transactionOwners, workerApp, appWith,
    /** Another runtime over the same catalog and policy, e.g. with another policy version (another snapshot). */
    makeRuntime(versions) { const extra = makeRuntime(versions); extraRuntimes.push(extra); return extra; },
    /**
     * A deployment that changes the snapshot (e.g. another policy version): the engine, every
     * owner, and the registry use the new runtime from now on. Returns it.
     */
    redeploy(versions) { extraRuntimes.push(runtime); runtime = makeRuntime(versions); return runtime; },
    binding: (tenant) => registry.binding(`db_${tenant}`, env),
    setValidator(value) { validator = value; },
    counts: () => ({ checks, connects }),
    // Port-level views of the owners, identical for both adapters.
    ownerNames: () => owners.names(),
    /**
     * The owner's stored record as a view (see `recordView`): the step machine's durable text
     * (ADR 0024) with `status` for its phase, or a TypeScript-owner object as stored.
     */
    ownerRecord: async (name) => recordView(await owners.record(name)),
    /** The stored value as it is (the machine's durable JSON text). */
    ownerRecordRaw: (name) => owners.record(name),
    /** Writes a stored value directly, as an earlier release would have (old-format records). */
    plantOwnerRecord: (name, value) => owners.plant(name, value),
    ownerCore: (name) => owners.core(name),
    /** The inputs the engine forwarded to `name`, in order: `{ kind, input }`. */
    ownerInputs: (name) => forwarded.get(name) ?? [],
    ownerTimerAt: (name) => owners.timerAt(name),
    loseOwner: (name) => owners.lose(name),
    /** Fault injection on owner store puts, for both adapters (see helpers/memory-owner.mjs). */
    // The hook sees `value` as a record view and `raw` as stored; a returned `value` is stored as is.
    interceptOwnerPut: (hook) => owners.interceptPut(hook && ((input) => hook({ ...input, raw: input.value, value: recordView(input.value) }))),
    /** Fault injection on owner store reads, for both adapters (see helpers/memory-owner.mjs). */
    interceptOwnerGet: (hook) => owners.interceptGet(hook),
    /** `hook({ tenant, sql })` runs after the remote database executed each statement. */
    afterDatabaseStatement(hook) { afterStatement = hook; },
    // A platform alarm fires at its time, not before: the owner's clock reads at least that
    // time while it runs (the step machine checks the deadline against it, ADR 0024).
    async fireTimer(name) {
      const at = owners.timerAt(name);
      const realNow = Date.now;
      if (at !== null) Date.now = () => Math.max(realNow.call(Date), at);
      try { return await owners.fireTimer(name); } finally { Date.now = realNow; }
    },
    delayNextOwnerBody: (ms) => owners.delayNextBody(ms),
    /** Durable Objects only: every raw reply the object sent over its wire. */
    ownerWire: () => owners.wire,
    /** Durable Objects only: the simulated namespace, for a Worker of another version. */
    ownerNamespace: () => owners.namespace,
    /** The ports a new owner gets (ADR 0021), for an owner of another version. */
    ownerDependencies,
    rotateCredential(tenant, value) {
      env[`TENANT_${tenant.toUpperCase()}_TOKEN`] = value;
      acceptedTokens.get(tenant).add(value);
    },
    revokeCredential(tenant, value) { acceptedTokens.get(tenant).delete(value); },
    rows: (tenant) => databases.get(tenant).database.prepare("SELECT id, name FROM projects WHERE tenant_id = ? ORDER BY id").all(`tenant_${tenant}`).map((row) => ({ ...row })),
  };
};
