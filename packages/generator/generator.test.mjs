import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { generate } from "./index.js";
import { createHttpTransport } from "../transport/http.js";
import { mockGateway, makeClient, testToken } from "../client/test-fixture.mjs";

const versions = { schemaVersion: "schema_1", policyVersion: "policy_1" };
const fixture = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "policysql-generator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "queries");
  const output = join(root, "generated");
  await mkdir(input);
  await writeFile(join(input, "get-posts.sql"), "SELECT id FROM posts WHERE status = :status");
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, headers: new Headers(init.headers), body: init.body && JSON.parse(init.body) });
    if (["/v1/catalog", "/v1/capabilities"].includes(path)) return Response.json(versions);
    return Response.json({ statements: [{
      parameters: [{ name: "status", type: "string", representation: "string", nullable: false }],
      result: { columns: [{ name: "id", type: ["integer", "string"], representation: "string", nullable: false }] },
    }] });
  };
  return {
    calls, output,
    fetchImpl,
    config: { role: "author", input, output, transport: createHttpTransport({ endpoint: "https://gateway.example.com", token: testToken, fetchImpl }) },
    source: () => readFile(join(output, "index.ts"), "utf8"),
  };
};

test("generator uses the canonical role header and version-pinned Explain descriptors", async (t) => {
  const h = await fixture(t);
  await generate(h.config);
  const source = await h.source();
  assert.match(source, /interface GetPostsParams/);
  assert.match(source, /status: string/);
  assert.match(source, /id: number \| string/);
  assert.match(source, /schemaVersion: "schema_1"/);
  assert.match(source, /@unacowa\/policysql\/client/);
  assert.ok(h.calls.every(c => c.headers.get("policysql-role") === "author" && !c.headers.has("x-policysql-role")));
  assert.deepEqual(h.calls.find(c => c.path.endsWith(":explain")).body.expected, versions);
});

test("generated query requires matching client versions and actually sends those preconditions", async (t) => {
  const h = await fixture(t);
  await generate(h.config);
  const { outputText } = ts.transpileModule(await h.source(), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const { getPosts } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
  const gateway = mockGateway();
  const config = { endpoint: "https://gateway.example.com", token: "token", fetchImpl: gateway.fetchImpl };
  for (const version of [{}, { ...versions, policyVersion: "old" }]) {
    await assert.rejects(getPosts.execute(makeClient({ ...config, ...version }), { status: "draft" }), /POLICYSQL_STALE_OPERATION/);
  }
  assert.equal(gateway.calls.length, 0);
  const rows = await getPosts.execute(makeClient({ ...config, ...versions }), { status: "draft" });
  assert.equal(rows[0].id, "post_1");
  assert.deepEqual(gateway.calls[0].body.expected, versions);
  assert.deepEqual(gateway.calls[0].body.statements[0].params, { status: "draft" });
});

test("catalog/capability mismatch or stale Explain preserves existing generated files", async (t) => {
  const h = await fixture(t);
  await generate(h.config);
  const previous = await h.source();
  for (const failedPath of ["/v1/capabilities", "/v1/transactions:explain"]) {
    await assert.rejects(generate({ ...h.config, transport: createHttpTransport({ endpoint: "https://gateway.example.com", token: testToken, fetchImpl: async (url, init) => {
      if (new URL(url).pathname !== failedPath) return h.fetchImpl(url, init);
      if (failedPath.endsWith("capabilities")) return Response.json({ ...versions, policyVersion: "changed" });
      return Response.json({ error: { code: "POLICYSQL_STALE_OPERATION" } }, { status: 409 });
    } }) }), error => error.code === "POLICYSQL_STALE_OPERATION" || error.message === "POLICYSQL_STALE_OPERATION");
    assert.equal(await h.source(), previous);
  }
});

test("generator rejects an invalid role before fetching or changing output", async (t) => {
  const h = await fixture(t);
  for (const role of [null, "", "ADMIN", "member,admin"]) await assert.rejects(generate({ ...h.config, role }), TypeError);
  assert.equal(h.calls.length, 0);
});
