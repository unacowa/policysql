import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = new URL(".", import.meta.url).pathname;
const repository = new URL("../../", import.meta.url).pathname;
const wranglerConfig = join(directory, "wrangler.jsonc");
const workerName = `policysql-policy-bench-${Date.now().toString(36)}`;
const token = randomBytes(32).toString("hex");
const temporary = await mkdtemp(join(tmpdir(), "policysql-cf-bench-"));
const secrets = join(temporary, "secrets.env");
await writeFile(secrets, `BENCH_TOKEN=${token}\n`, { mode: 0o600 });

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repository, env: process.env, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

let deployed = false;
const report = { workerName, cases: {} };
try {
  const deployment = await run("npx", [
    "wrangler",
    "deploy",
    "--config",
    wranglerConfig,
    "--name",
    workerName,
    "--secrets-file",
    secrets,
  ]);
  if (deployment.code !== 0) throw new Error(`${deployment.stdout}\n${deployment.stderr}`);
  deployed = true;
  const combined = `${deployment.stdout}\n${deployment.stderr}`;
  report.deployment = {
    upload: combined.match(/Total Upload:\s*([^\n]+)/)?.[1]?.trim(),
    startup: combined.match(/Worker Startup Time:\s*([^\n]+)/)?.[1]?.trim(),
  };
  const url = combined.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0];
  if (!url) throw new Error(`Worker URL missing: ${combined}`);

  const request = async (caseName, iterations) => {
    const response = await fetch(`${url}/?case=${caseName}&iterations=${iterations}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json();
    if (!response.ok || !String(body.result).startsWith("ok:")) {
      throw new Error(`${caseName}/${iterations}: ${response.status} ${JSON.stringify(body)}`);
    }
    return body;
  };

  let ready = false;
  let readinessError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await request("simple", 1);
      ready = true;
      break;
    } catch (error) {
      readinessError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!ready) throw readinessError;

  for (const caseName of ["simple", "join", "exists", "aggregate", "window", "update"]) {
    const failures = [];
    for (let sample = 0; sample < 5; sample += 1) {
      try {
        await request(caseName, 1);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    report.cases[caseName] = {
      requests: 5,
      successes: 5 - failures.length,
      failures,
    };
  }
} finally {
  if (deployed) {
    const deletion = await run("npx", [
      "wrangler",
      "delete",
      workerName,
      "--force",
      "--config",
      wranglerConfig,
    ]);
    report.cleanup = { exitCode: deletion.code };
  }
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
