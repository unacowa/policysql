import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect as connectEmbedded } from "@tursodatabase/database";
import { createClient } from "@tursodatabase/serverless/compat";

const directory = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));
const artifacts = new URL(".artifacts/", import.meta.url);
const reportPath = new URL("report.json", artifacts);

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    if (options.input) child.stdin.end(options.input);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || options.allowFailure) {
        resolve({ code, stdout, stderr });
      } else {
        reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
      }
    });
  });
}

async function platformRequest(path, init = {}) {
  const response = await fetch(`https://api.turso.tech${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${requireEnvironment("TURSO_API_TOKEN")}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(`Turso Platform API ${response.status}: ${body?.error ?? text}`);
  }
  return body;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForDatabase(client) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await client.execute("SELECT 1");
      return;
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  throw lastError;
}

function safeError(error) {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  };
}

function makeBarrier(parties) {
  let arrivals = 0;
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  return async () => {
    arrivals += 1;
    if (arrivals === parties) release();
    await promise;
  };
}

async function runEmbeddedPair(firstDatabase, secondDatabase, useGuard) {
  const barrier = makeBarrier(2);
  const transaction = (database, accountId) =>
    database.transactionAsync(async (tx) => {
      const before = await tx.get("SELECT sum(balance) AS total FROM accounts");
      await barrier();
      if (useGuard) await tx.run("UPDATE invariant_guard SET version = version + 1 WHERE id = 1");
      await tx.run("UPDATE accounts SET balance = balance - 100 WHERE id = ?", accountId);
      return { observedTotal: before.total, accountId };
    }).concurrent;

  const outcomes = await Promise.allSettled([
    transaction(firstDatabase, 1)(),
    transaction(secondDatabase, 2)(),
  ]);
  const final = await firstDatabase.get("SELECT sum(balance) AS total FROM accounts");
  return {
    outcomes: outcomes.map((outcome) =>
      outcome.status === "fulfilled"
        ? { status: "committed", ...outcome.value }
        : { status: "rejected", error: safeError(outcome.reason) },
    ),
    finalTotal: final.total,
  };
}

async function runEmbeddedTests() {
  const databasePath = fileURLToPath(new URL("embedded-mvcc.db", artifacts));
  await rm(databasePath, { force: true });
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-mvcc`, { force: true });
  await rm(`${databasePath}-log`, { force: true });
  let firstDatabase;
  let secondDatabase;
  try {
    firstDatabase = await connectEmbedded(databasePath);
    await firstDatabase.exec("PRAGMA journal_mode = mvcc");
    await firstDatabase.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL);
      CREATE TABLE invariant_guard (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO accounts (id, balance) VALUES (1, 70), (2, 80);
      INSERT INTO invariant_guard (id, version) VALUES (1, 0);
    `);
    secondDatabase = await connectEmbedded(databasePath);

    const journalMode = await firstDatabase.get("PRAGMA journal_mode");
    const expression = await firstDatabase.batch(
      ["SELECT 1 AS one, datetime('now') AS today, CASE WHEN 1 = 1 THEN 1 ELSE 'x' END AS mixed"],
      "read",
    );
    const writeSkew = await runEmbeddedPair(firstDatabase, secondDatabase, false);

    await firstDatabase.exec("UPDATE accounts SET balance = CASE id WHEN 1 THEN 70 ELSE 80 END");
    const guarded = await runEmbeddedPair(firstDatabase, secondDatabase, true);

    return {
      packageVersion: "0.7.2",
      journalMode: journalMode.journal_mode,
      expressionMetadata: {
        columns: expression[0].columns,
        columnTypes: expression[0].columnTypes,
        values: expression[0].rows[0],
      },
      writeSkew,
      guarded,
    };
  } finally {
    if (secondDatabase) await secondDatabase.close();
    if (firstDatabase) await firstDatabase.close();
    await rm(databasePath, { force: true });
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-mvcc`, { force: true });
    await rm(`${databasePath}-log`, { force: true });
  }
}

async function testHold(client, holdMs, commit) {
  const id = `node-hold-${holdMs}-${randomBytes(5).toString("hex")}`;
  const startedAt = Date.now();
  let transaction;
  try {
    transaction = await client.transaction("write");
    await transaction.execute({
      sql: "INSERT INTO spike_events (id, source) VALUES (:id, :source)",
      args: { id, source: `hold-${holdMs}` },
    });
    const ownWrite = await transaction.execute({
      sql: "SELECT source FROM spike_events WHERE id = :id",
      args: { id },
    });
    await sleep(holdMs);
    if (commit) await transaction.commit();
    else await transaction.rollback();
    transaction = undefined;
    return {
      ok: true,
      requestedHoldMs: holdMs,
      elapsedMs: Date.now() - startedAt,
      readYourWrites: ownWrite.rows[0]?.source === `hold-${holdMs}`,
      terminalAction: commit ? "commit" : "rollback",
    };
  } catch (error) {
    if (transaction) {
      try {
        await transaction.rollback();
      } catch {
        // The first failure is reported below.
      }
    }
    return {
      ok: false,
      requestedHoldMs: holdMs,
      elapsedMs: Date.now() - startedAt,
      error: safeError(error),
    };
  }
}

async function testConcurrentMode(clientConfig) {
  const firstClient = createClient(clientConfig);
  const secondClient = createClient(clientConfig);
  const startedAt = Date.now();
  let first;
  let second;
  try {
    const starts = await Promise.all([
      firstClient.transaction("concurrent").then((transaction) => {
        first = transaction;
        return Date.now() - startedAt;
      }),
      secondClient.transaction("concurrent").then((transaction) => {
        second = transaction;
        return Date.now() - startedAt;
      }),
    ]);
    await Promise.all([
      first.execute("INSERT INTO spike_events (id, source) VALUES ('concurrent-a', 'a')"),
      second.execute("INSERT INTO spike_events (id, source) VALUES ('concurrent-b', 'b')"),
    ]);
    await Promise.all([first.commit(), second.commit()]);
    first = undefined;
    second = undefined;
    return { ok: true, beginElapsedMs: starts, totalElapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, elapsedMs: Date.now() - startedAt, error: safeError(error) };
  } finally {
    for (const transaction of [first, second]) {
      if (transaction) {
        try {
          await transaction.rollback();
        } catch {
          // Preserve the first failure.
        }
      }
    }
  }
}

async function runNodeTests(client, clientConfig) {
  await client.executeMultiple(`
    CREATE TABLE spike_events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL
    );
    CREATE TABLE spike_posts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      private_note TEXT
    );
    INSERT INTO spike_posts (id, owner_id, tenant_id, private_note) VALUES
      ('visible', 'user-1', 'tenant-1', 'visible-note'),
      ('denied', 'user-2', 'tenant-1', 'denied-note')
  `);

  const expression = await client.execute(
    "SELECT 1 AS one, datetime('now') AS today, CASE WHEN 1 = 1 THEN 1 ELSE 'x' END AS mixed",
  );

  const rollbackId = `rollback-${randomBytes(5).toString("hex")}`;
  let batchError;
  try {
    await client.batch(
      [
        {
          sql: "INSERT INTO spike_events (id, source) VALUES (:id, 'batch')",
          args: { id: rollbackId },
        },
        "INSERT INTO missing_spike_table (id) VALUES ('fail')",
      ],
      "write",
    );
  } catch (error) {
    batchError = safeError(error);
  }
  const rollbackCheck = await client.execute({
    sql: "SELECT count(*) AS count FROM spike_events WHERE id = :id",
    args: { id: rollbackId },
  });

  const redaction = await client.execute({
    sql: `
      SELECT
        id,
        CASE WHEN owner_id = :subject_id THEN private_note ELSE NULL END AS private_note,
        owner_id = :subject_id AS __policysql_visible_private_note
      FROM spike_posts
      ORDER BY id DESC
    `,
    args: { subject_id: "user-1" },
  });

  const operationCheckId = `operation-check-${randomBytes(5).toString("hex")}`;
  const operationTransaction = await client.transaction("write");
  const postState = await operationTransaction.execute({
    sql: `
      INSERT INTO spike_posts (id, owner_id, tenant_id, private_note)
      VALUES (:id, :owner_id, :tenant_id, NULL)
      RETURNING id, tenant_id
    `,
    args: { id: operationCheckId, owner_id: "user-1", tenant_id: "wrong-tenant" },
  });
  const operationCheckPassed = postState.rows.every((row) => row.tenant_id === "tenant-1");
  if (operationCheckPassed) await operationTransaction.commit();
  else await operationTransaction.rollback();
  const operationCheckPersisted = await client.execute({
    sql: "SELECT count(*) AS count FROM spike_posts WHERE id = :id",
    args: { id: operationCheckId },
  });

  let returningCteError;
  try {
    await client.execute(`
      WITH changed AS (
        INSERT INTO spike_events (id, source) VALUES ('cte', 'test') RETURNING id
      )
      SELECT id FROM changed
    `);
  } catch (error) {
    returningCteError = safeError(error);
  }

  const firstClient = client;
  const secondClient = createClient(clientConfig);
  let firstTransaction;
  const concurrencyStarted = Date.now();
  let secondResult;
  try {
    firstTransaction = await firstClient.transaction("write");
    const secondPromise = secondClient
      .transaction("write")
      .then(async (transaction) => {
        await transaction.rollback();
        return { ok: true, elapsedMs: Date.now() - concurrencyStarted };
      })
      .catch((error) => ({ ok: false, elapsedMs: Date.now() - concurrencyStarted, error: safeError(error) }));
    await sleep(750);
    await firstTransaction.rollback();
    firstTransaction = undefined;
    secondResult = await secondPromise;
  } catch (error) {
    secondResult = { ok: false, elapsedMs: Date.now() - concurrencyStarted, error: safeError(error) };
  } finally {
    if (firstTransaction) {
      try {
        await firstTransaction.rollback();
      } catch {
        // Result is already captured.
      }
    }
  }

  return {
    expressionMetadata: {
      columns: expression.columns,
      columnTypes: expression.columnTypes,
      jsTypes: expression.columns.map((_, index) => {
        const value = expression.rows[0][index];
        return value === null ? "null" : typeof value;
      }),
      values: expression.columns.map((_, index) => expression.rows[0][index]),
    },
    batchRollback: {
      failed: Boolean(batchError),
      insertedRowsAfterFailure: Number(rollbackCheck.rows[0].count),
      error: batchError,
    },
    conditionalProjection: {
      columns: redaction.columns,
      columnTypes: redaction.columnTypes,
      rows: redaction.rows.map((row) => redaction.columns.map((_, index) => row[index])),
    },
    operationCheck: {
      postStateRows: postState.rows.map((row) => postState.columns.map((_, index) => row[index])),
      checkPassed: operationCheckPassed,
      rolledBack: !operationCheckPassed,
      persistedRows: Number(operationCheckPersisted.rows[0].count),
    },
    returningCte: {
      rejected: Boolean(returningCteError),
      error: returningCteError,
    },
    transactionHolds: process.env.POLICYSQL_SPIKE_FAST
      ? [await testHold(client, 1500, true)]
      : [
          await testHold(client, 1500, true),
          await testHold(client, 3500, false),
          await testHold(client, 5500, false),
          await testHold(client, 15000, false),
        ],
    concurrentWriteStart: secondResult,
    concurrentMode: process.env.POLICYSQL_SPIKE_FAST
      ? { skipped: true }
      : await testConcurrentMode(clientConfig),
  };
}

async function deployAndTestWorker(databaseUrl, databaseToken, workerName) {
  const requestToken = randomBytes(32).toString("hex");
  const secretsPath = new URL("worker-secrets.env", artifacts);
  await writeFile(
    secretsPath,
    `TURSO_DATABASE_URL=${databaseUrl}\nTURSO_AUTH_TOKEN=${databaseToken}\nSPIKE_REQUEST_TOKEN=${requestToken}\n`,
    { mode: 0o600 },
  );

  const deployment = await run("wrangler", [
    "deploy",
    "--config",
    `${directory}/wrangler.jsonc`,
    "--name",
    workerName,
    "--secrets-file",
    fileURLToPath(secretsPath),
  ]);
  const combined = `${deployment.stdout}\n${deployment.stderr}`;
  const workerUrl = combined.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0];
  if (!workerUrl) throw new Error(`Could not find deployed Worker URL in Wrangler output: ${combined}`);

  const request = async (path) => {
    const response = await fetch(`${workerUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${requestToken}` },
    });
    const text = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      text,
    };
  };

  let lastResponse;
  let health;
  let attempts;
  const maxAttempts = 120;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await request("/health");
    if (response.contentType.includes("application/json")) {
      health = { status: response.status, body: JSON.parse(response.text) };
      attempts = attempt + 1;
      break;
    }
    lastResponse = {
      status: response.status,
      contentType: response.contentType,
      bodyPreview: response.text.slice(0, 240).replaceAll(/\s+/g, " "),
    };
    await sleep(1000);
  }
  if (!health) {
    throw new Error(
      `Worker route did not become ready after ${maxAttempts} attempts: ${JSON.stringify(lastResponse)}`,
    );
  }

  const startedAt = Date.now();
  const start = await request("/start");
  await sleep(1500);
  const read = await request("/read");
  const finish = await request("/finish");
  const verify = await request("/verify");
  const crossRequestElapsedMs = Date.now() - startedAt;
  const parse = (response) => ({ status: response.status, body: JSON.parse(response.text) });
  const firstStart = parse(start);

  const lossStart = await request("/start");
  const lostRowId = parse(lossStart).body.rowId;
  let abortResult;
  try {
    const response = await request("/abort");
    abortResult = response.contentType.includes("application/json")
      ? parse(response)
      : {
          status: response.status,
          contentType: response.contentType,
          nonJsonResponse: true,
        };
  } catch (error) {
    abortResult = { connectionTerminated: true, error: safeError(error) };
  }
  let resetHealth;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const candidate = await request("/health");
      if (candidate.status === 200) {
        resetHealth = { attempts: attempt + 1, ...parse(candidate) };
        break;
      }
    } catch {
      // A replacement Durable Object instance is not necessarily ready immediately.
    }
    await sleep(500);
  }
  if (!resetHealth) throw new Error("Durable Object did not recover after abort");
  const lostRead = parse(await request("/read"));
  const lostVerify = parse(await request(`/verify?id=${encodeURIComponent(lostRowId)}`));
  const replacementStart = parse(await request("/start"));
  const replacementFinish = parse(await request("/finish"));
  return {
    urlHost: new URL(workerUrl).host,
    attempts,
    health,
    crossRequestTransaction: {
      elapsedMs: crossRequestElapsedMs,
      start: firstStart,
      read: parse(read),
      finish: parse(finish),
      verify: parse(verify),
    },
    ownerLoss: {
      start: parse(lossStart),
      abort: abortResult,
      resetHealth,
      readAfterReset: lostRead,
      verifyUncommittedRow: lostVerify,
      replacementTransaction: {
        start: replacementStart,
        finish: replacementFinish,
      },
    },
  };
}

async function main() {
  requireEnvironment("TURSO_ORG");
  requireEnvironment("TURSO_API_TOKEN");
  requireEnvironment("CLOUDFLARE_ACCOUNT_ID");
  requireEnvironment("CLOUDFLARE_API_TOKEN");
  await mkdir(artifacts, { recursive: true });

  const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const databaseName = `policysql-spike-${suffix}`;
  const workerName = `policysql-spike-${suffix}`;
  const organization = process.env.TURSO_ORG;
  let databaseCreated = false;
  let workerAttempted = false;
  const report = {
    startedAt: new Date().toISOString(),
    versions: {},
    resources: { databaseName, workerName, group: "default" },
  };

  try {
    const packageJson = JSON.parse(await readFile(new URL("package.json", import.meta.url), "utf8"));
    report.versions.serverless = packageJson.dependencies["@tursodatabase/serverless"];
    report.versions.embeddedDatabase = packageJson.dependencies["@tursodatabase/database"];
    report.versions.node = process.version;
    report.versions.wrangler = (await run("wrangler", ["--version"])).stdout.trim();

    report.embedded = await runEmbeddedTests();

    const created = await platformRequest(`/v1/organizations/${organization}/databases`, {
      method: "POST",
      body: JSON.stringify({ name: databaseName, group: "default" }),
    });
    databaseCreated = true;
    const hostname = created.database.Hostname ?? created.database.hostname;
    const tokenResponse = await platformRequest(
      `/v1/organizations/${organization}/databases/${databaseName}/auth/tokens?expiration=1h&authorization=full-access`,
      { method: "POST", body: "{}" },
    );
    const databaseUrl = `https://${hostname}`;
    const databaseToken = tokenResponse.jwt;
    const clientConfig = { url: databaseUrl, authToken: databaseToken };
    const client = createClient(clientConfig);
    await waitForDatabase(client);

    report.node = await runNodeTests(client, clientConfig);
    workerAttempted = true;
    report.cloudflare = await deployAndTestWorker(databaseUrl, databaseToken, workerName);
  } catch (error) {
    report.failure = safeError(error);
  } finally {
    if (workerAttempted) {
      const deletion = await run("wrangler", ["delete", workerName, "--force"], { allowFailure: true });
      report.cleanup = { workerDeleteExitCode: deletion.code };
    }
    if (databaseCreated) {
      try {
        await platformRequest(`/v1/organizations/${organization}/databases/${databaseName}`, {
          method: "DELETE",
        });
        report.cleanup = { ...report.cleanup, databaseDeleted: true };
      } catch (error) {
        report.cleanup = { ...report.cleanup, databaseDeleted: false, databaseDeleteError: safeError(error) };
      }
    }
    report.finishedAt = new Date().toISOString();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await rm(new URL("worker-secrets.env", artifacts), { force: true });
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.failure) process.exitCode = 1;
}

await main();
