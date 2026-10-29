import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORM_NAMES, scanPlatformNames } from "./helpers/platform-scan.mjs";

// Regression guard (#31, ADR 0022): routes and TransactionOwnerCore use only the
// TransactionOwner port. Durable Objects, their storage and alarm, `waitUntil`, and the
// `cloudflare:workers` module appear only in the Durable Objects adapter module.
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const library = "deploy/cloudflare/src";
const ADAPTER = "deploy/cloudflare/src/adapters/durable-objects.ts";

const sources = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return sources(path);
  return entry.name.endsWith(".ts") ? [path] : [];
});
const files = sources(join(repository, library)).map((path) => relative(repository, path));
const scan = (file) => scanPlatformNames(file, readFileSync(join(repository, file), "utf8"));

test("Durable Object, storage, alarm, waitUntil, and cloudflare:workers names appear only in the adapter", () => {
  for (const required of ["app.ts", "routes/execute.ts", "routes/transactions.ts", "routes/commit-checks.ts",
    "transaction-owner.ts", "transaction-owner-port.ts", "worker.ts", "package.ts", "middleware/request-context.ts", "types.ts"]) {
    assert.ok(files.includes(`${library}/${required}`), `the scan covers ${required}`);
  }
  const outside = files.filter((file) => file !== ADAPTER).flatMap(scan);
  assert.deepEqual(outside, [], "use the TransactionOwner port (src/transaction-owner-port.ts)");
});

test("the adapter is where those names live, so the scan sees real code", () => {
  const names = new Set(scan(ADAPTER).map((finding) => finding.name));
  for (const name of ["DurableObjectNamespace", "DurableObjectState", "idFromName", "storage", "setAlarm", "waitUntil"]) {
    assert.ok(names.has(name), `${name} is used by the adapter`);
  }
});

test("the scan matches syntax, not comments", () => {
  const caught = [
    "const f = (namespace: DurableObjectNamespace) => namespace;",
    "const id = namespace.idFromName(name);",
    "const stub = namespace.getByName(name);",
    "const stub = namespace.get(namespace.idFromString(hex));",
    "const stub = namespace.get(namespace.newUniqueId());",
    "const eu = namespace.jurisdiction('eu');",
    "state.storage.get('transaction');",
    "state['storage'].put('k', 1);",
    "const { storage } = state;",
    "await this.state.storage.setAlarm(1);",
    "context.executionCtx.waitUntil(task);",
    "executionContext?.waitUntil?.(task);",
    'import { DurableObject } from "cloudflare:workers";',
    'const m = await import("cloudflare:workers");',
    "class Owner { storage = new Map(); }",
    "type S = DurableObjectState;",
  ];
  for (const text of caught) assert.notDeepEqual(scanPlatformNames("sample.ts", text), [], text);
  const allowed = [
    "// state.storage.setAlarm and waitUntil live in the adapter",
    "/* DurableObjectNamespace */ const store = facilities.store;",
    "await this.facilities.timer.schedule(atMs);",
    "runInBackground(background, task, requestId);",
    'const message = "Durable Object";',
  ];
  for (const text of allowed) assert.deepEqual(scanPlatformNames("sample.ts", text), [], text);
  assert.ok(PLATFORM_NAMES.has("cloudflare:workers"));
});
