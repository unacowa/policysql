import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanOutboundFetch } from "./helpers/outbound-fetch-scan.mjs";

// Regression guard (#36): Cloudflare Workers (workerd) throws
// `TypeError: Invalid redirect value, must be one of "follow" or "manual"` when fetch
// gets the "error" redirect mode. Node supports that mode, so fake-fetch tests
// cannot catch it. Worker-executed code therefore sends outbound HTTP only through
// fetchNoFollow (src/redirects.ts), which forces "manual" and rejects redirects
// unread. This guard is structural: only redirects.ts may name `redirect` or use
// the global fetch, whatever value or spelling another file would use.
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const workerTrees = ["deploy/cloudflare/src", "deploy/cloudflare/wrapper", "examples"];
const exit = "deploy/cloudflare/src/redirects.ts";

const sources = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return sources(path);
  return /\.[cm]?[jt]s$/u.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
});

const files = workerTrees.flatMap((tree) => sources(join(repository, tree)))
  .map((path) => relative(repository, path));

test("only redirects.ts sets a redirect mode or calls the global fetch in Worker source", () => {
  for (const required of [exit, "deploy/cloudflare/src/turso-http.ts", "deploy/cloudflare/src/commit-checks.ts",
    "deploy/cloudflare/wrapper/index.ts", "examples/database-routing/worker.ts"]) {
    assert.ok(files.includes(required), `the scan covers ${required}`);
  }
  const findings = files
    .filter((file) => file !== exit)
    .flatMap((file) => scanOutboundFetch(file, readFileSync(join(repository, file), "utf8")));
  assert.deepEqual(findings, [], "use fetchNoFollow from src/redirects.ts; workerd rejects the \"error\" redirect mode");

  const own = scanOutboundFetch(exit, readFileSync(join(repository, exit), "utf8"));
  assert.ok(own.some(({ kind }) => kind === "redirect"), "redirects.ts sets the redirect mode");
  assert.ok(own.some(({ kind }) => kind === "global-fetch"), "redirects.ts owns the host fetch");
});

test("the scan catches every spelling of a redirect option and every global fetch", () => {
  const caught = [
    ["redirect", 'const MODE = "error"; fetch2(url, { redirect: MODE });'],
    ["redirect", 'const redirect = "error"; fetch2(url, { redirect });'],
    ["redirect", 'fetch2(url, { "redirect": "error" });'],
    ["redirect", "fetch2(url, { 'redirect': \"manual\" });"],
    ["redirect", 'fetch2(url, { ["redirect"]: "error" });'],
    ["redirect", 'fetch2(url, { redirect: ("error") });'],
    ["redirect", 'init.redirect = "error";'],
    ["redirect", 'init["redirect"] = "error";'],
    ["redirect", 'new Request(url, { redirect: "follow" });'],
    ["global-fetch", "await fetch(url, init);"],
    ["global-fetch", "const impl = fetch; await impl(url);"],
    ["global-fetch", "const run = ({ fetchImpl = fetch }) => fetchImpl(url);"],
    ["global-fetch", "await globalThis.fetch(url);"],
    ["global-fetch", 'await self["fetch"](url);'],
    ["global-fetch", "send({ fetch });"],
  ];
  for (const [kind, code] of caught) {
    const findings = scanOutboundFetch("probe.ts", code);
    assert.ok(findings.some((finding) => finding.kind === kind), `${kind}: ${code}`);
  }
});

test("the scan ignores comments, strings, type positions and documented fetch members", () => {
  const allowed = [
    '// never use redirect: "error"; fetch(url) is forbidden here',
    '/* { redirect: "error" } and globalThis.fetch */ const x = 1;',
    'const message = "redirect: error and fetch(url)";',
    'const kind = "opaqueredirect";',
    "await owner.fetch(\"https://owner/atomic\", { method: \"POST\" });",
    "await app.fetch(request, env, context);",
    "await env.SERVICE.fetch(request);",
    "export default { fetch: handler };",
    "export default { async fetch(request) { return handler(request); } };",
    "class Owner { fetch(request) { return request; } }",
    "let impl: typeof fetch | undefined;",
    "interface App { fetch(request: Request): Promise<Response> }",
  ];
  for (const code of allowed) assert.deepEqual(scanOutboundFetch("probe.ts", code), [], code);
});
