import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard (#36): Cloudflare Workers (workerd) throws
// `TypeError: Invalid redirect value, must be one of "follow" or "manual"` for
// `fetch(url, { redirect: "error" })`. Node supports "error", so fake-fetch tests
// cannot catch it. Worker-executed code must use `redirect: "manual"` and reject
// redirect responses itself (src/redirects.ts).
const root = fileURLToPath(new URL("..", import.meta.url));
const workerDirectories = ["src", "wrapper"];

const sources = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return sources(path);
  return /\.(?:[cm]?[jt]s)$/u.test(entry.name) ? [path] : [];
});

test("Worker-executed source never passes redirect: \"error\" to fetch", () => {
  const files = workerDirectories.flatMap((directory) => sources(join(root, directory)));
  assert.ok(files.some((file) => file.endsWith("turso-http.ts")), "the scan covers the Turso transport");
  assert.ok(files.some((file) => file.endsWith("commit-checks.ts")), "the scan covers the commit-check hook");
  const pattern = /redirect\s*:\s*["'`]error["'`]/u;
  const offenders = files.filter((file) => pattern.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, [], "workerd does not support redirect: \"error\"; use \"manual\"");
});
