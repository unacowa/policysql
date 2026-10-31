import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { connect } from "@tursodatabase/serverless";
import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
import { buildPhysicalSchema } from "./catalog-build.mjs";
import { readFileSync } from "node:fs";
import { initSync, PolicySqlRuntime } from "../pkg/policysql_wasm.js";
import { POLICY_VERSION, SCHEMA_VERSION } from "../src/config.ts";
import { runtimeLimits, runtimeLimitsJson } from "../src/limits.ts";
import { RUNTIME_LIMITS } from "../wrapper/limits.ts";
import { DEPLOYMENT_VERSION_HEADER, versionTracker, waitForRelease } from "./release-readiness.mjs";
import { bytesNullSmoke, commitCheckSmoke } from "./smoke-sections.mjs";
import { sqlComplexitySmoke } from "./smoke-complexity.mjs";
import { COMPLEXITY_ALLOWLIST, SqlComplexityError } from "../src/database-complexity.ts";
import { TursoHttpTransport } from "../src/turso-http.ts";
import { SHAPE_TARGET_BYTES, cpuSmoke, referenceScenarioId } from "./smoke-cpu.mjs";
import { SMOKE_SHAPES } from "./lib/cpu-shapes.mjs";
import { measureNodeReference } from "./lib/node-reference.mjs";
import { parse } from "yaml";
import { parseJsonc } from "./lib/jsonc.mjs";

const directory = fileURLToPath(new URL("..", import.meta.url));
const deploymentDirectory = new URL("../.deployment/", import.meta.url);
const privateKeyPath = new URL("dev-issuer-private.jwk", deploymentDirectory);
const reportPath = new URL("release.json", deploymentDirectory);
const secretsPath = new URL("deploy-secrets.json", deploymentDirectory);
// The dev validator's HMAC key, kept (mode 0600, gitignored) so a Worker of the previous
// release and a validator of this one still agree during the rollout.
const validatorKeyPath = new URL("dev-validator-hmac.key", deploymentDirectory);
const validatorSecretsPath = new URL("validator-secrets.json", deploymentDirectory);
const databaseName = "policysql-dev";
const workerName = "policysql-sqlite-turso-dev";
const validatorName = "policysql-dev-validator";
const expectedVersions = { schemaVersion: SCHEMA_VERSION, policyVersion: POLICY_VERSION };
const issuer = "https://policysql.local/development";
const audience = "policysql-development";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const run = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      env: process.env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    if (input !== undefined) child.stdin.end(input);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} failed (${code}): ${stderr || stdout}`));
    });
  });

const platform = async (path, init = {}, allowNotFound = false) => {
  const response = await fetch(`https://api.turso.tech${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${required("TURSO_API_TOKEN")}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  if (allowNotFound && response.status === 404) return null;
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`Turso API ${response.status}: ${body?.error ?? "request failed"}`);
  return body;
};

const loadOrCreateIssuer = async () => {
  try {
    const privateJwk = JSON.parse(await readFile(privateKeyPath, "utf8"));
    return { privateJwk, privateKey: await importJWK(privateJwk, "ES256") };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const pair = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = await exportJWK(pair.privateKey);
    privateJwk.kid = "policysql-dev-1";
    privateJwk.alg = "ES256";
    await writeFile(privateKeyPath, `${JSON.stringify(privateJwk)}\n`, { mode: 0o600 });
    return { privateJwk, privateKey: pair.privateKey };
  }
};

// What the deployed Capabilities must advertise: exactly the wrapper's configured limits
// (ADR 0024). A mismatch means an advertised value is not the enforced one.
const advertisedLimits = (capabilities) => ({
  "limits.maxRows": capabilities.limits?.maxRows,
  "limits.maxResultBytes": capabilities.limits?.maxResultBytes,
  "limits.timeoutMs": capabilities.limits?.timeoutMs,
  "limits.maxStatements": capabilities.limits?.maxStatements,
  "limits.maxRequestBytes": capabilities.limits?.maxRequestBytes,
  "limits.maxJsonValues": capabilities.limits?.maxJsonValues,
  "limits.maxSqlBytes": capabilities.limits?.maxSqlBytes,
  "limits.maxBytesPerValue": capabilities.limits?.maxBytesPerValue,
  "limits.maxParameters": capabilities.limits?.maxParameters,
  "limits.maxExpressionDepth": capabilities.limits?.maxExpressionDepth,
  "limits.maxProjections": capabilities.limits?.maxProjections,
  "limits.maxJoins": capabilities.limits?.maxJoins,
  "transactions.maxInteractiveDurationMs": capabilities.transactions?.maxInteractiveDurationMs,
  "transactions.maxStatements": capabilities.transactions?.maxStatements,
  "transactions.maxResultBytes": capabilities.transactions?.maxResultBytes,
  "transactions.maxCallbackQueriesPerCheck": capabilities.transactions?.maxCallbackQueriesPerCheck,
  "transactions.maxCallbackRowsPerCheck": capabilities.transactions?.maxCallbackRowsPerCheck,
  "transactions.maxCallbackBytesPerCheck": capabilities.transactions?.maxCallbackBytesPerCheck,
});
// The release being deployed, from the runtime it bundles: the effective limits
// (`RUNTIME_LIMITS` as the runtime fills and validates them, so a key the wrapper omits is
// expected at its runtime default, not as `undefined`), its snapshot, and its ABI version.
let release;
const localRelease = () => {
  if (release) return release;
  initSync({ module: readFileSync(new URL("../pkg/policysql_wasm_bg.wasm", import.meta.url)) });
  const config = (name) => readFileSync(new URL(`../config/${name}`, import.meta.url), "utf8");
  const runtime = PolicySqlRuntime.newWithPhysicalSchema(
    config("catalog.yaml"), config("policy.compiled.yaml"), SCHEMA_VERSION, POLICY_VERSION,
    runtimeLimitsJson(RUNTIME_LIMITS), config("schema-introspection.json"),
  );
  try {
    release = { limits: runtimeLimits(runtime), snapshot: runtime.snapshot, abiVersion: runtime.abi_version };
  } finally { runtime.free(); }
  return release;
};
const configuredLimits = () => {
  const { limits } = localRelease();
  return {
    "limits.maxRows": limits.maxRows,
    "limits.maxResultBytes": limits.maxResultBytes,
    "limits.timeoutMs": limits.timeoutMs,
    "limits.maxStatements": limits.maxStatements,
    "limits.maxRequestBytes": limits.maxRequestBytes,
    "limits.maxJsonValues": limits.maxJsonValues,
    "limits.maxSqlBytes": limits.maxSqlBytes,
    "limits.maxBytesPerValue": limits.maxBytesPerValue,
    "limits.maxParameters": limits.maxParameters,
    "limits.maxExpressionDepth": limits.maxExpressionDepth,
    "limits.maxProjections": limits.maxProjections,
    "limits.maxJoins": limits.maxJoins,
    "transactions.maxInteractiveDurationMs": limits.transactionMs,
    "transactions.maxStatements": limits.maxTransactionStatements,
    "transactions.maxResultBytes": limits.maxTransactionResultBytes,
    "transactions.maxCallbackQueriesPerCheck": limits.maxTransactionStatements,
    "transactions.maxCallbackRowsPerCheck": limits.maxCallbackRows,
    "transactions.maxCallbackBytesPerCheck": limits.maxTransactionResultBytes,
  };
};

// The configured per-invocation CPU limit of the reference wrapper (wrangler.jsonc, ADR 0027).
const configuredCpuMs = () => {
  const limit = parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")).limits?.cpu_ms;
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("wrangler.jsonc limits.cpu_ms must be a positive integer");
  return limit;
};

// The reference-machine times of the smoke's request shapes, warm and cold (the same shapes
// through the Node harness in fresh processes, scripts/lib/node-reference.mjs), measured once per
// run, before any request is sent.
let nodeReference;
const nodeReferenceTimes = () => {
  nodeReference ??= measureNodeReference({ shapes: SMOKE_SHAPES, scenarioId: referenceScenarioId, target: SHAPE_TARGET_BYTES });
  return nodeReference;
};

// The tables the deployed policy's commit checks trigger on (they decide whether an Atomic Execute
// uses the Durable Object owner).
const commitCheckTables = () => {
  const policy = parse(readFileSync(new URL("../config/policy.compiled.yaml", import.meta.url), "utf8"));
  return Object.values(policy.commit_checks ?? {}).flatMap((check) => check.triggered_by ?? []);
};

const smoke = async (baseUrl, token, tracker, database) => {
  const headers = { authorization: `Bearer ${token}` };
  const call = tracker.call;
  const health = await call(`${baseUrl}/healthz`).then((response) => response.json());
  const capabilitiesResponse = await call(`${baseUrl}/v1/capabilities`, { headers });
  const capabilities = await capabilitiesResponse.json();
  const limitsMatch = JSON.stringify(advertisedLimits(capabilities)) === JSON.stringify(configuredLimits());
  const catalogResponse = await call(`${baseUrl}/v1/catalog`, { headers });
  const roleCatalog = await catalogResponse.json();
  const request = {
    expected: expectedVersions,
    statements: [{
      sql: "SELECT id, name, status FROM projects WHERE status = :status ORDER BY id",
      params: { status: "active" },
    }],
  };
  const explainResponse = await call(`${baseUrl}/v1/transactions:explain`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const explain = await explainResponse.json();
  const executeResponse = await call(`${baseUrl}/v1/transactions:execute`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const execute = await executeResponse.json();
  const surfaceBatches = [
    {
      statements: [
        {
          sql: "SELECT p.id, p.title, a.name AS author_name FROM posts AS p JOIN authors AS a ON a.id = p.author_id WHERE p.status = :status ORDER BY p.published_at DESC LIMIT :limit",
          params: { status: "published", limit: 20 },
        },
        {
          sql: "WITH published_posts AS (SELECT id, author_id, title FROM posts WHERE status = :status) SELECT p.id, p.title, a.name FROM published_posts AS p JOIN authors AS a ON a.id = p.author_id",
          params: { status: "published" },
        },
        {
          sql: "SELECT p.id FROM posts AS p WHERE EXISTS (SELECT 1 FROM comments AS c WHERE c.post_id = p.id)",
          params: {},
        },
        {
          sql: "SELECT status, COUNT(*) AS post_count FROM posts GROUP BY status HAVING COUNT(*) >= :minimum ORDER BY post_count DESC",
          params: { minimum: 1 },
        },
        {
          sql: "SELECT id, title, ROW_NUMBER() OVER (PARTITION BY author_id ORDER BY published_at DESC) AS author_post_number FROM posts",
          params: {},
        },
        {
          sql: "SELECT CASE WHEN status = :status THEN CAST(title AS TEXT) ELSE title || :suffix END AS display_title FROM posts",
          params: { status: "published", suffix: "-other" },
        },
        {
          sql: "SELECT LOWER(title) AS lower_title, UPPER(title) AS upper_title, JSON_EXTRACT(metadata, :path) AS selected_metadata FROM posts WHERE title GLOB :pattern AND title LIKE :prefix ORDER BY lower_title LIMIT :limit OFFSET :offset",
          params: { path: "$.label", pattern: "*", prefix: "%", limit: 10, offset: 0 },
        },
        {
          sql: "SELECT json_group_array(j.value) AS items FROM posts AS p, json_each(p.metadata, :path) AS j WHERE p.id = :id",
          params: { path: "$.tags", id: "post_1" },
        },
      ],
    },
    {
      statements: [
        {
          sql: "SELECT json_group_array(j.value) AS items FROM posts AS p, json_tree(p.metadata, :path) AS j WHERE p.id = :id",
          params: { path: "$.tags", id: "post_1" },
        },
        {
          sql: "SELECT p.id, p.title FROM (SELECT id, title FROM posts) AS p ORDER BY p.id",
          params: {},
        },
        {
          sql: "SELECT id, private_note AS note FROM posts ORDER BY id",
          params: {},
        },
        { sql: "SELECT 1 AS value", params: {} },
        {
          sql: "SELECT id, title FROM posts WHERE status IN (:published, :draft) AND status NOT IN (:archived) AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT :limit OFFSET :offset",
          params: { published: "published", draft: "draft", archived: "archived", limit: 20, offset: 0 },
        },
        {
          sql: "SELECT id, title FROM archived_posts ORDER BY id",
          params: {},
        },
      ],
    },
  ];
  const surfaceResponses = [];
  for (const body of surfaceBatches) {
    body.expected = expectedVersions;
    const response = await call(`${baseUrl}/v1/transactions:execute`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    surfaceResponses.push({ response, body: await response.json() });
  }
  const rollbackProbe = `rollback_probe_${Date.now()}`;
  const rollbackResponse = await call(`${baseUrl}/v1/transactions:execute`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      "idempotency-key": `rollback-surface-${Date.now()}`,
    },
    body: JSON.stringify({
      expected: expectedVersions,
      statements: [
        { sql: "SELECT id FROM posts WHERE id = :id", params: { id: "post_1" }, expect: { rowCount: 1 } },
        { sql: "INSERT INTO posts (title, status) VALUES (:title, :status) RETURNING id, title, status", params: { title: "Default probe", status: "draft" }, expect: { affectedRows: 1, rowCount: 1 } },
        { sql: "INSERT INTO posts (id, title, status, published_at, metadata, view_count) VALUES (:id, :title, :status, :published_at, :metadata, :view_count) RETURNING id, title, status", params: { id: rollbackProbe, title: "Probe", status: "draft", published_at: "2026-08-12T00:00:00Z", metadata: { label: "probe", score: 1, tags: ["test"] }, view_count: 0 }, expect: { affectedRows: 1, rowCount: 1 } },
        { sql: "UPDATE posts SET title = :title, status = :status WHERE id = :id RETURNING id, title, status", params: { id: rollbackProbe, title: "Updated", status: "published" }, expect: { affectedRows: 1, rowCount: 1 } },
        { sql: "SELECT id, title, status FROM posts WHERE id = :id", params: { id: rollbackProbe }, expect: { rowCount: 1 } },
        { sql: "DELETE FROM posts WHERE id = :id RETURNING id", params: { id: rollbackProbe }, expect: { affectedRows: 1, rowCount: 1 } },
        { sql: "SELECT id FROM posts WHERE id = :id", params: { id: rollbackProbe }, expect: { rowCount: 1 } },
      ],
    }),
  });
  const rollback = await rollbackResponse.json();
  const rollbackVerificationResponse = await call(`${baseUrl}/v1/transactions:execute`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ statements: [{ sql: "SELECT id FROM posts WHERE id = :id", params: { id: rollbackProbe }, expect: { rowCount: 0 } }] }),
  });
  const rollbackVerification = await rollbackVerificationResponse.json();
  const deniedResponse = await call(`${baseUrl}/v1/transactions:execute`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ statements: [{ sql: "SELECT tenant_id FROM projects", params: {} }] }),
  });
  const bombResponse = await call(`${baseUrl}/v1/transactions:execute`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      statements: [{
        sql: "SELECT a.id FROM projects AS a JOIN projects AS b ON a.id = b.id",
        params: {},
      }],
    }),
  });
  // Regression (#39): client SQL string literals must bind their decoded value
  // and match seeded rows; a raw-token binding returns no rows.
  const literalResponse = await call(`${baseUrl}/v1/transactions:execute`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      statements: [
        { sql: "SELECT id FROM projects WHERE id = 'project_a'", params: {}, expect: { rowCount: 1 } },
        { sql: "SELECT id, name FROM projects WHERE name LIKE 'Alph%'", params: {}, expect: { rowCount: 1 } },
        { sql: "SELECT id FROM projects WHERE id <> 'project_a' AND name = 'it''s'", params: {}, expect: { rowCount: 0 } },
      ],
    }),
  });
  const literal = await literalResponse.json();
  const literalRows = (literal.results ?? []).map((result) => result.rows?.map((row) => row.id) ?? []);
  const literalOk = literalResponse.ok
    && JSON.stringify(literalRows) === JSON.stringify([["project_a"], ["project_a"], []]);
  const unauthenticatedResponse = await call(`${baseUrl}/v1/capabilities`);
  const interactiveHeaders = {
    ...headers,
    "content-type": "application/json",
    "idempotency-key": `release-interactive-${Date.now()}`,
  };
  const interactiveResponse = await call(`${baseUrl}/v1/transactions`, {
    method: "POST",
    headers: interactiveHeaders,
    body: JSON.stringify({
      mode: "read",
      expected: expectedVersions,
    }),
  });
  const interactiveBegin = await interactiveResponse.json();
  const interactiveStatementResponse = await call(
    `${baseUrl}/v1/transactions/${interactiveBegin.transactionId}/statements`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sequence: 1, sql: "SELECT id, name FROM projects WHERE id = :id", params: { id: "project_a" } }),
    },
  );
  const interactiveStatement = await interactiveStatementResponse.json();
  const interactiveReplayResponse = await call(
    `${baseUrl}/v1/transactions/${interactiveBegin.transactionId}/statements`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sequence: 1, sql: "SELECT id, name FROM projects WHERE id = :id", params: { id: "project_a" } }),
    },
  );
  const interactiveReplay = await interactiveReplayResponse.json();
  const interactiveCommitResponse = await call(
    `${baseUrl}/v1/transactions/${interactiveBegin.transactionId}/commit`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sequence: 2 }),
    },
  );
  const interactiveCommit = await interactiveCommitResponse.json();
  const mutation = async (sql, params, key) => {
    const response = await call(`${baseUrl}/v1/transactions:execute`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({ statements: [{ sql, params, expect: { affectedRows: 1 } }] }),
    });
    return { response, body: await response.json() };
  };
  const probe = `release_probe_${Date.now()}`;
  const insertKey = `release-insert-${Date.now()}`;
  const insertSql = "INSERT INTO projects (id, name, status) VALUES (:id, :name, :status) RETURNING id, name, status";
  const insertParams = { id: probe, name: "Release probe", status: "active" };
  const inserted = await mutation(insertSql, insertParams, insertKey);
  const replayed = await mutation(insertSql, insertParams, insertKey);
  const conflict = await mutation(insertSql, { ...insertParams, name: "Conflict" }, insertKey);
  const updated = await mutation(
    "UPDATE projects SET name = :name, status = :status WHERE id = :id RETURNING id, name, status",
    { id: probe, name: "Updated probe", status: "archived" },
    `release-update-${Date.now()}`,
  );
  const deleted = await mutation(
    "DELETE FROM projects WHERE id = :id RETURNING id",
    { id: probe },
    `release-delete-${Date.now()}`,
  );
  // Development-only resources (#42): commit checks through the dev validator, then bytes
  // (ADR 0016) and NULL assignment (ADR 0017).
  const sectionContext = { call, baseUrl, headers, expected: expectedVersions };
  const commitChecks = await commitCheckSmoke(sectionContext, {
    hookTimeoutMs: capabilities.transactions?.maxHookDurationMs ?? null, atomicTimeoutMs: capabilities.limits?.timeoutMs ?? null,
  });
  const bytesNull = await bytesNullSmoke(sectionContext, { maxBytesPerValue: capabilities.limits?.maxBytesPerValue });
  // SQL complexity (ADR 0027): every allowlist entry real Turso can produce, sent to it directly
  // and classified by the transport (fatal when one stops matching), and the refusals through the
  // deployed Worker.
  const sqlComplexity = await sqlComplexitySmoke(sectionContext, {
    transport: new TursoHttpTransport({ url: database.url, authToken: database.token }, "release-smoke-complexity"),
    allowlist: COMPLEXITY_ALLOWLIST,
    classify: (error) => (error instanceof SqlComplexityError ? error.complexityCause : null),
  });
  // Real CPU time of the worst request shapes (#56, ADR 0027): fatal when a request exceeds
  // `cpu_ms`; an unreadable observability result is reported, not fatal.
  const cpu = await cpuSmoke(sectionContext, {
    cpuLimitMs: configuredCpuMs(), limits: localRelease().limits, nodeReferenceMs: nodeReferenceTimes().shapes, nodeReferenceInfo: nodeReferenceTimes().info, commitCheckTables: commitCheckTables(),
    observability: { accountId: required("CLOUDFLARE_ACCOUNT_ID"), token: required("CLOUDFLARE_API_TOKEN"), service: workerName },
  });
  const visibleRows = execute.results?.[0]?.rows ?? [];
  const expected = localRelease();
  if (
    tracker.skewed.length > 0 ||
    tracker.unversioned.length > 0 ||
    commitChecks.failures.length > 0 ||
    bytesNull.failures.length > 0 ||
    sqlComplexity.failures.length > 0 ||
    cpu.failures.length > 0 ||
    capabilities.transactions?.commitChecksConfigured !== true ||
    !health.ready ||
    // Every answer came from this release, not from the previous version still serving.
    health.snapshot !== expected.snapshot ||
    health.abiVersion !== expected.abiVersion ||
    capabilities.id !== expected.snapshot ||
    capabilities.abiVersion !== expected.abiVersion ||
    !capabilitiesResponse.ok ||
    !limitsMatch ||
    !catalogResponse.ok ||
    !explainResponse.ok ||
    !executeResponse.ok ||
    surfaceResponses.some(({ response, body }) => !response.ok || body.results?.length === 0) ||
    rollbackResponse.ok ||
    rollback.error?.code !== "POLICYSQL_EXPECTATION_FAILED" ||
    !rollbackVerificationResponse.ok ||
    rollbackVerification.results?.[0]?.rowCount !== 0 ||
    visibleRows.length !== 1 ||
    visibleRows[0].id !== "project_a" ||
    deniedResponse.status !== 403 ||
    bombResponse.status !== 400 ||
    !literalOk ||
    unauthenticatedResponse.status !== 401 ||
    interactiveResponse.status !== 201
    || !interactiveStatementResponse.ok
    || !interactiveReplayResponse.ok
    || !interactiveCommitResponse.ok
    || interactiveStatement.result?.rows?.[0]?.id !== "project_a"
    || JSON.stringify(interactiveStatement) !== JSON.stringify(interactiveReplay)
    || interactiveCommit.status !== "committed"
    || !inserted.response.ok
    || !replayed.response.ok
    || conflict.response.status !== 409
    || !updated.response.ok
    || !deleted.response.ok
    || inserted.body.transactionId !== replayed.body.transactionId
    || inserted.body.meta?.requestId !== replayed.body.meta?.requestId
  ) {
    const failure = new Error(`release smoke failed: ${JSON.stringify({
      versionSkew: tracker.skewed,
      // Responses without the version header did not come from the wrapper (Cloudflare error
      // page, e.g. 1101 or 52x): a failure of this release, never skew.
      unversioned: tracker.unversioned,
      rateLimited: tracker.rateLimited,
      commitChecks,
      bytesNull,
      sqlComplexity,
      cpu,
      health,
      capabilities,
      roleCatalog,
      explain,
      execute,
      sqlSurface: surfaceResponses.map(({ response, body }) => ({
        status: response.status,
        resultCount: body.results?.length,
        error: body.error,
      })),
      rollback: {
        status: rollbackResponse.status,
        body: rollback,
        verificationStatus: rollbackVerificationResponse.status,
        verification: rollbackVerification,
      },
      deniedStatus: deniedResponse.status,
      bombStatus: bombResponse.status,
      stringLiterals: { status: literalResponse.status, rows: literalRows, error: literal.error },
      unauthenticatedStatus: unauthenticatedResponse.status,
      interactive: {
        beginStatus: interactiveResponse.status,
        begin: interactiveBegin,
        statement: interactiveStatement,
        replay: interactiveReplay,
        commit: interactiveCommit,
      },
      mutation: {
        insert: inserted.body,
        replay: replayed.body,
        conflict: conflict.body,
        update: updated.body,
        delete: deleted.body,
      },
    })}`);
    // Only a straggler of the previous version or the client rate limit makes a rerun
    // meaningful; any other failure is a regression.
    failure.retryable = tracker.retryable;
    throw failure;
  }
  return {
    versions: { responses: tracker.responses, allFromRelease: tracker.skewed.length === 0 && tracker.unversioned.length === 0 },
    health: { ready: health.ready, snapshot: health.snapshot, abiVersion: health.abiVersion, profile: health.profile },
    capabilities: {
      status: capabilitiesResponse.status, id: capabilities.id, limitsMatch, limits: advertisedLimits(capabilities),
      commitChecksConfigured: capabilities.transactions?.commitChecksConfigured,
    },
    catalog: { status: catalogResponse.status, resources: roleCatalog.resources.length },
    explain: { status: explainResponse.status, statements: explain.statements.length },
    execute: {
      status: executeResponse.status,
      rowCount: execute.results[0].rowCount,
      operation: execute.results[0].meta.operation,
      commitChecks: execute.meta.commitChecks,
    },
    sqlSurface: {
      batches: surfaceResponses.length,
      statements: surfaceBatches.reduce((sum, batch) => sum + batch.statements.length, 0),
      rollbackCode: rollback.error.code,
      rollbackProbeRows: rollbackVerification.results[0].rowCount,
    },
    stringLiterals: {
      status: literalResponse.status,
      rowCounts: literal.results.map((result) => result.rowCount),
      matchedSeededRows: literalOk,
    },
    security: {
      forbiddenColumnStatus: deniedResponse.status,
      joinCostBombStatus: bombResponse.status,
      unauthenticatedStatus: unauthenticatedResponse.status,
      interactiveStatus: interactiveResponse.status,
      interactiveCommitted: interactiveCommit.status === "committed",
      interactiveExactRetry: JSON.stringify(interactiveStatement) === JSON.stringify(interactiveReplay),
    },
    mutations: {
      insertStatus: inserted.response.status,
      replayStatus: replayed.response.status,
      conflictStatus: conflict.response.status,
      updateStatus: updated.response.status,
      deleteStatus: deleted.response.status,
      replayStable: true,
    },
    commitChecks: commitChecks.report,
    bytesNull: bytesNull.report,
    sqlComplexity: sqlComplexity.report,
    cpu: cpu.report,
  };
};

// The final Capabilities read of the readiness wait: this release's snapshot and ABI version
// (which change when the ABI does), its limits (the snapshot does not change when only limits
// do), and its configured commit check.
const capabilitiesMatch = (body) => {
  const { snapshot, abiVersion } = localRelease();
  return body?.transactions?.interactive === true && body.id === snapshot && body.abiVersion === abiVersion
    && body.transactions?.commitChecksConfigured === true
    && JSON.stringify(advertisedLimits(body)) === JSON.stringify(configuredLimits());
};

const cloudflare = async (path) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { authorization: `Bearer ${required("CLOUDFLARE_API_TOKEN")}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) throw new Error(`Cloudflare API ${response.status}`);
  return body.result;
};

const loadOrCreateValidatorKey = async () => {
  try {
    return (await readFile(validatorKeyPath, "utf8")).trim();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const key = randomBytes(32).toString("base64url");
    await writeFile(validatorKeyPath, `${key}\n`, { mode: 0o600 });
    return key;
  }
};

// Whether Turso's Hrana HTTP API pads base64 BLOB values. The Worker normalizes both forms
// (src/turso-http.ts); the bytes smoke proves the public result is canonical either way.
const hranaBlobPadding = async (databaseUrl, databaseToken) => {
  const response = await fetch(`${databaseUrl}/v2/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${databaseToken}`, "content-type": "application/json" },
    body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql: "SELECT X'000102FF' AS value" } }, { type: "close" }] }),
  });
  const body = await response.json().catch(() => null);
  const cell = body?.results?.[0]?.response?.result?.rows?.[0]?.[0];
  if (!response.ok || cell?.type !== "blob" || typeof cell.base64 !== "string") return { observed: false, status: response.status };
  return { observed: true, base64: cell.base64, padded: cell.base64.endsWith("=") };
};

const deployWorker = async (args, secrets, secretsFile) => {
  await writeFile(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
  let deployed;
  try {
    deployed = await run("wrangler", ["deploy", ...args, "--secrets-file", fileURLToPath(secretsFile)]);
  } finally {
    await unlink(secretsFile).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  const combined = `${deployed.stdout}\n${deployed.stderr}`;
  const version = combined.match(/Current Version ID:\s+([0-9a-f-]{36})/)?.[1];
  if (!version) throw new Error("Worker version missing from deploy output");
  return { combined, version, url: combined.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] };
};

async function main() {
  required("CLOUDFLARE_ACCOUNT_ID");
  required("CLOUDFLARE_API_TOKEN");
  const organization = required("TURSO_ORG");
  await mkdir(deploymentDirectory, { recursive: true, mode: 0o700 });
  let database = await platform(
    `/v1/organizations/${organization}/databases/${databaseName}`,
    {},
    true,
  );
  if (!database) {
    database = await platform(`/v1/organizations/${organization}/databases`, {
      method: "POST",
      body: JSON.stringify({ name: databaseName, group: "default" }),
    });
  }
  const descriptor = database.database ?? database;
  const hostname = descriptor.Hostname ?? descriptor.hostname;
  if (!hostname) throw new Error("Turso database hostname missing");
  const databaseUrl = `https://${hostname}`;
  const tokenResponse = await platform(
    `/v1/organizations/${organization}/databases/${databaseName}/auth/tokens?expiration=4w&authorization=full-access`,
    { method: "POST", body: "{}" },
  );
  const databaseToken = tokenResponse.jwt;
  const connection = connect({ url: databaseUrl, authToken: databaseToken, defaultQueryTimeout: 5_000 });
  await connection.batch([
    "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL)",
    "INSERT OR REPLACE INTO projects (id, tenant_id, name, status, created_by) VALUES ('project_a', 'tenant_a', 'Alpha', 'active', 'user_1')",
    "INSERT OR REPLACE INTO projects (id, tenant_id, name, status, created_by) VALUES ('project_b', 'tenant_b', 'Hidden', 'active', 'user_2')",
    "CREATE TABLE IF NOT EXISTS authors (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL) STRICT",
    "CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL, author_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, published_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{\"label\":\"untitled\",\"score\":0,\"tags\":[]}', view_count INTEGER NOT NULL DEFAULT 0, internal_notes TEXT, private_note TEXT NOT NULL DEFAULT '') STRICT",
    "CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY NOT NULL, post_id TEXT NOT NULL, tenant_id TEXT NOT NULL, parent_id TEXT, body TEXT NOT NULL) STRICT",
    "CREATE TABLE IF NOT EXISTS archived_posts (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, title TEXT NOT NULL) STRICT",
    "INSERT OR REPLACE INTO authors (id, tenant_id, name) VALUES ('user_1', 'tenant_a', 'Alice'), ('user_2', 'tenant_b', 'Hidden Author')",
    "INSERT OR REPLACE INTO posts (id, tenant_id, author_id, title, status, published_at, updated_by, metadata, view_count, internal_notes, private_note) VALUES ('post_1', 'tenant_a', 'user_1', 'Published Alpha', 'published', '2026-08-01T12:00:00Z', 'user_1', '{\"label\":\"alpha\",\"score\":10,\"tags\":[\"public\",\"featured\"]}', 10, 'operator-only', 'owner note'), ('post_2', 'tenant_a', 'user_1', 'Draft Beta', 'draft', '2026-08-02T12:00:00Z', 'user_1', '{\"label\":\"beta\",\"score\":3,\"tags\":[\"draft\"]}', 3, NULL, 'draft note'), ('post_hidden', 'tenant_b', 'user_2', 'Hidden Post', 'published', '2026-08-03T12:00:00Z', 'user_2', '{\"label\":\"hidden\",\"score\":99,\"tags\":[\"hidden\"]}', 99, 'hidden', 'hidden note')",
    "INSERT OR REPLACE INTO comments (id, post_id, tenant_id, parent_id, body) VALUES ('comment_1', 'post_1', 'tenant_a', NULL, 'Visible comment'), ('comment_hidden', 'post_hidden', 'tenant_b', NULL, 'Hidden comment')",
    "INSERT OR REPLACE INTO archived_posts (id, tenant_id, title) VALUES ('archived_1', 'tenant_a', 'Archived Visible'), ('archived_hidden', 'tenant_b', 'Archived Hidden')",
    // Development-only release-smoke tables (#42). Emptied on every release.
    "CREATE TABLE IF NOT EXISTS smoke_checks (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, verdict TEXT NOT NULL) STRICT",
    "CREATE TABLE IF NOT EXISTS smoke_values (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, label TEXT NOT NULL, note TEXT, payload BLOB, doc TEXT) STRICT",
    "DELETE FROM smoke_checks",
    "DELETE FROM smoke_values",
    "CREATE TABLE IF NOT EXISTS policysql_idempotency (key_hash TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  ], "write", { queryTimeout: 5_000 });
  // A smoke_values table created before the CPU probes (#56) has no `doc`; SQLite has no
  // ADD COLUMN IF NOT EXISTS.
  const smokeValueColumns = await connection.all('PRAGMA table_xinfo("smoke_values")');
  if (!smokeValueColumns.some((column) => column.name === "doc")) {
    await connection.batch(["ALTER TABLE smoke_values ADD COLUMN doc TEXT"], "write", { queryTimeout: 5_000 });
  }
  const catalogYaml = await readFile(new URL("../config/catalog.yaml", import.meta.url), "utf8");
  const physicalSchema = await buildPhysicalSchema(connection, catalogYaml);
  await writeFile(
    new URL("../config/schema-introspection.json", import.meta.url),
    `${JSON.stringify(physicalSchema, null, 2)}\n`,
  );
  await connection.close();
  const hrana = await hranaBlobPadding(databaseUrl, databaseToken);

  // The workers.dev origin of both Workers, known before either is deployed: the PolicySQL
  // Worker's public base URL (the commit-check callback origin) and the validator URL.
  const { subdomain } = await cloudflare(`/accounts/${required("CLOUDFLARE_ACCOUNT_ID")}/workers/subdomain`);
  if (!/^[a-z0-9-]+$/.test(subdomain ?? "")) throw new Error("workers.dev subdomain missing");
  const baseUrl = `https://${workerName}.${subdomain}.workers.dev`;
  const validatorUrl = `https://${validatorName}.${subdomain}.workers.dev`;
  const validatorKey = await loadOrCreateValidatorKey();
  const validator = await deployWorker([
    "--config", "dev-validator/wrangler.jsonc",
    "--message", "PolicySQL development commit-check validator",
    "--var", `POLICYSQL_ORIGIN:${baseUrl}`,
  ], { HOOK_SECRET: validatorKey }, validatorSecretsPath);
  if (validator.url !== validatorUrl) throw new Error("validator URL differs from the workers.dev subdomain");

  const issuerKey = await loadOrCreateIssuer();
  const publicJwk = { ...issuerKey.privateJwk };
  delete publicJwk.d;
  const deployed = await deployWorker([
    "--name", workerName,
    "--message", "PolicySQL operational development release",
    "--var", `POLICYSQL_PUBLIC_BASE_URL:${baseUrl}`,
    "--var", `SMOKE_VALIDATOR_URL:${validatorUrl}/check`,
  ], {
    POLICYSQL_JWKS_JSON: JSON.stringify({ keys: [publicJwk] }),
    POLICYSQL_JWT_ISSUER: issuer,
    POLICYSQL_JWT_AUDIENCE: audience,
    TURSO_DATABASE_URL: databaseUrl,
    TURSO_AUTH_TOKEN: databaseToken,
    SMOKE_VALIDATOR_HMAC_SECRET: validatorKey,
  }, secretsPath);
  if (deployed.url !== baseUrl) throw new Error("Worker URL differs from the workers.dev subdomain");
  const combined = deployed.combined;
  const upload = combined.match(/Total Upload:\s+([0-9.]+) KiB\s+\/ gzip:\s+([0-9.]+) KiB/);
  const startup = combined.match(/Worker Startup Time:\s+(\d+) ms/);
  // A fresh 10-minute token per attempt: one attempt (readiness wait of at most 180 s, a
  // possible 60 s rate-limit pause, the smoke) always ends before it expires.
  const mintToken = () => new SignJWT({
    policysql: {
      roles: ["member"],
      default_role: "member",
      access: ["catalog", "explain", "execute"],
      session: { tenant_id: "tenant_a" },
    },
  })
    .setProtectedHeader({ alg: "ES256", kid: publicJwk.kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("user_1")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(issuerKey.privateKey);
  // Wait until every answer comes from this release, then smoke. A rerun happens only when the
  // failed smoke saw a previous version's answer or the client rate limit, never otherwise.
  const readiness = [];
  let acceptance;
  for (let attempt = 1; ; attempt += 1) {
    const jwt = await mintToken();
    readiness.push(await waitForRelease({
      baseUrl, token: jwt, version: deployed.version,
      validator: { url: validatorUrl, version: validator.version }, capabilitiesMatch,
    }));
    const tracker = versionTracker(deployed.version);
    try {
      acceptance = await smoke(baseUrl, jwt, tracker, { url: databaseUrl, token: databaseToken });
      break;
    } catch (error) {
      if (!error.retryable || attempt >= 3) throw error;
      process.stderr.write(`release smoke attempt ${attempt} saw previous-version answers ${JSON.stringify(tracker.skewed)} / ${tracker.rateLimited} rate-limited answers; waiting again\n`);
      if (tracker.rateLimited > 0) await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }
  const report = {
    deployedAt: new Date().toISOString(),
    worker: workerName,
    url: baseUrl,
    database: databaseName,
    schemaVersion: SCHEMA_VERSION,
    policyVersion: POLICY_VERSION,
    workerVersion: deployed.version,
    validator: { worker: validatorName, url: validatorUrl, version: validator.version },
    readiness: { header: DEPLOYMENT_VERSION_HEADER, attempts: readiness },
    hranaBlobs: hrana,
    runtime: {
      uploadKiB: upload ? Number(upload[1]) : null,
      gzipKiB: upload ? Number(upload[2]) : null,
      startupMs: startup ? Number(startup[1]) : null,
      cpuLimitMs: configuredCpuMs(),
      cloudflarePlanRequirement: "paid",
      reason: "Measured Execute CPU exceeds the Workers Free 10 ms request CPU limit.",
    },
    acceptance,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
