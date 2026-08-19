import { spawn } from "node:child_process";

const version = process.argv[2];
if (!version || !/^[0-9a-f-]{36}$/.test(version)) {
  throw new Error("Usage: npm run rollback -- <worker-version-uuid>");
}

const child = spawn(
  "npx",
  [
    "wrangler",
    "rollback",
    version,
    "--name",
    "policysql-sqlite-turso-dev",
    "--message",
    `PolicySQL operator rollback to ${version}`,
  ],
  { cwd: new URL("..", import.meta.url), env: process.env, stdio: "inherit" },
);
const code = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", resolve);
});
if (code !== 0) process.exitCode = code;
