import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { connect } from "@tursodatabase/serverless";
import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
import { buildPhysicalSchema } from "./catalog-build.mjs";

const directory = fileURLToPath(new URL("..", import.meta.url));
const deploymentDirectory = new URL("../.deployment/", import.meta.url);
const privateKeyPath = new URL("dev-issuer-private.jwk", deploymentDirectory);
const reportPath = new URL("release.json", deploymentDirectory);
const secretsPath = new URL("deploy-secrets.json", deploymentDirectory);
const databaseName = "policysql-dev";
const workerName = "policysql-sqlite-turso-dev";
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

const smoke = async (baseUrl, token) => {
  const headers = { authorization: `Bearer ${token}` };
  const health = await fetch(`${baseUrl}/healthz`).then((response) => response.json());
  const capabilitiesResponse = await fetch(`${baseUrl}/v1/capabilities`, { headers });
  const capabilities = await capabilitiesResponse.json();
  const catalogResponse = await fetch(`${baseUrl}/v1/catalog`, { headers });
  const roleCatalog = await catalogResponse.json();
  const request = {
    expected: { schemaVersion: "schema_dev_2", policyVersion: "policy_dev_2" },
    statements: [{
      sql: "SELECT id, name, status FROM projects WHERE status = :status ORDER BY id",
      params: { status: "active" },
    }],
  };
  const explainResponse = await fetch(`${baseUrl}/v1/transactions:explain`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const explain = await explainResponse.json();
  const executeResponse = await fetch(`${baseUrl}/v1/transactions:execute`, {
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
    body.expected = { schemaVersion: "schema_dev_2", policyVersion: "policy_dev_2" };
    const response = await fetch(`${baseUrl}/v1/transactions:execute`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    surfaceResponses.push({ response, body: await response.json() });
  }
  const rollbackProbe = `rollback_probe_${Date.now()}`;
  const rollbackResponse = await fetch(`${baseUrl}/v1/transactions:execute`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      "idempotency-key": `rollback-surface-${Date.now()}`,
    },
    body: JSON.stringify({
      expected: { schemaVersion: "schema_dev_2", policyVersion: "policy_dev_2" },
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
  const rollbackVerificationResponse = await fetch(`${baseUrl}/v1/transactions:execute`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ statements: [{ sql: "SELECT id FROM posts WHERE id = :id", params: { id: rollbackProbe }, expect: { rowCount: 0 } }] }),
  });
  const rollbackVerification = await rollbackVerificationResponse.json();
  const deniedResponse = await fetch(`${baseUrl}/v1/transactions:execute`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ statements: [{ sql: "SELECT tenant_id FROM projects", params: {} }] }),
  });
  const bombResponse = await fetch(`${baseUrl}/v1/transactions:execute`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      statements: [{
        sql: "SELECT a.id FROM projects AS a JOIN projects AS b ON a.id = b.id",
        params: {},
      }],
    }),
  });
  const unauthenticatedResponse = await fetch(`${baseUrl}/v1/capabilities`);
  const interactiveHeaders = {
    ...headers,
    "content-type": "application/json",
    "idempotency-key": `release-interactive-${Date.now()}`,
  };
  const interactiveResponse = await fetch(`${baseUrl}/v1/transactions`, {
    method: "POST",
    headers: interactiveHeaders,
    body: JSON.stringify({
      mode: "read",
      expected: { schemaVersion: "schema_dev_2", policyVersion: "policy_dev_2" },
    }),
  });
  const interactiveBegin = await interactiveResponse.json();
  const interactiveStatementResponse = await fetch(
    `${baseUrl}/v1/transactions/${interactiveBegin.transactionId}/statements`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sequence: 1, sql: "SELECT id, name FROM projects WHERE id = :id", params: { id: "project_a" } }),
    },
  );
  const interactiveStatement = await interactiveStatementResponse.json();
  const interactiveReplayResponse = await fetch(
    `${baseUrl}/v1/transactions/${interactiveBegin.transactionId}/statements`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sequence: 1, sql: "SELECT id, name FROM projects WHERE id = :id", params: { id: "project_a" } }),
    },
  );
  const interactiveReplay = await interactiveReplayResponse.json();
  const interactiveCommitResponse = await fetch(
    `${baseUrl}/v1/transactions/${interactiveBegin.transactionId}/commit`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sequence: 2 }),
    },
  );
  const interactiveCommit = await interactiveCommitResponse.json();
  const mutation = async (sql, params, key) => {
    const response = await fetch(`${baseUrl}/v1/transactions:execute`, {
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
  const visibleRows = execute.results?.[0]?.rows ?? [];
  if (
    !health.ready ||
    !capabilitiesResponse.ok ||
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
    throw new Error(`release smoke failed: ${JSON.stringify({
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
  }
  return {
    health: { ready: health.ready, snapshot: health.snapshot, profile: health.profile },
    capabilities: { status: capabilitiesResponse.status, id: capabilities.id },
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
  };
};

const waitForActiveRelease = async (baseUrl, token) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/v1/capabilities?release=${Date.now()}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await response.json();
      if (response.ok && body.transactions?.interactive === true) return;
    } catch { /* retry until the bounded release deadline */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("deployed Worker did not become active before the release deadline");
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
    "CREATE TABLE IF NOT EXISTS policysql_idempotency (key_hash TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  ], "write", { queryTimeout: 5_000 });
  const catalogYaml = await readFile(new URL("../config/catalog.yaml", import.meta.url), "utf8");
  const physicalSchema = await buildPhysicalSchema(connection, catalogYaml);
  await writeFile(
    new URL("../config/schema-introspection.json", import.meta.url),
    `${JSON.stringify(physicalSchema, null, 2)}\n`,
  );
  await connection.close();

  const issuerKey = await loadOrCreateIssuer();
  const publicJwk = { ...issuerKey.privateJwk };
  delete publicJwk.d;
  await writeFile(
    secretsPath,
    JSON.stringify({
      POLICYSQL_JWKS_JSON: JSON.stringify({ keys: [publicJwk] }),
      POLICYSQL_JWT_ISSUER: issuer,
      POLICYSQL_JWT_AUDIENCE: audience,
      TURSO_DATABASE_URL: databaseUrl,
      TURSO_AUTH_TOKEN: databaseToken,
    }),
    { mode: 0o600 },
  );
  let deployed;
  try {
    deployed = await run("wrangler", [
      "deploy",
      "--name",
      workerName,
      "--message",
      "PolicySQL operational development release",
      "--secrets-file",
      fileURLToPath(secretsPath),
    ]);
  } finally {
    await unlink(secretsPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  const combined = `${deployed.stdout}\n${deployed.stderr}`;
  const baseUrl = combined.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
  if (!baseUrl) throw new Error("Worker URL missing from deploy output");
  const upload = combined.match(/Total Upload:\s+([0-9.]+) KiB\s+\/ gzip:\s+([0-9.]+) KiB/);
  const startup = combined.match(/Worker Startup Time:\s+(\d+) ms/);
  const version = combined.match(/Current Version ID:\s+([0-9a-f-]{36})/);
  const jwt = await new SignJWT({
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
  await waitForActiveRelease(baseUrl, jwt);
  const acceptance = await smoke(baseUrl, jwt);
  const report = {
    deployedAt: new Date().toISOString(),
    worker: workerName,
    url: baseUrl,
    database: databaseName,
    schemaVersion: "schema_dev_2",
    policyVersion: "policy_dev_2",
    workerVersion: version?.[1] ?? null,
    runtime: {
      uploadKiB: upload ? Number(upload[1]) : null,
      gzipKiB: upload ? Number(upload[2]) : null,
      startupMs: startup ? Number(startup[1]) : null,
      cpuLimitMs: 50,
      cloudflarePlanRequirement: "paid",
      reason: "Measured Execute CPU exceeds the Workers Free 10 ms request CPU limit.",
    },
    acceptance,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
