import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { generate } from "./index.js";
import { PolicySqlClient, createHttpTransport } from "../client/index.js";
import { mockGateway, errorBody } from "../client/test-fixture.mjs";

const versions = { schemaVersion: "schema_1", policyVersion: "policy_1" };
const fixture = async t => {
  const root = await mkdtemp(join(tmpdir(), "policysql-generator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "queries");
  const output = join(root, "generated");
  await mkdir(input);
  await writeFile(join(input, "get-posts.sql"), "SELECT id FROM posts WHERE status = :status");
  const calls = [];
  const transport = async request => {
    calls.push(request);
    if (request.kind === "catalog") return { status: 200, body: { ...versions, role: "author", resources: [] } };
    if (request.kind === "capabilities") return { status: 200, body: { ...versions, sqlDialect: "sqlite", id: "snapshot_1", profile: "sqlite_turso_v1", abiVersion: 1 } };
    return { status: 200, body: { meta: { ...versions, role: "author" }, statements: [{
      parameters: [{ name: "status", type: "string", representation: "string", nullable: false }],
      result: { columns: [{ name: "id", type: ["integer", "string"], representation: "string", nullable: false }] },
    }] } };
  };
  return {
    calls, root, input, output,
    config: { endpoint: "https://gateway.example.com", role: "author", input, output, transport },
    source: () => readFile(join(output, "index.ts"), "utf8"),
    metadata: () => readFile(join(output, "metadata.json"), "utf8").then(JSON.parse),
  };
};
const load = async h => {
  const { outputText } = ts.transpileModule(await h.source(), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
};

test("generator uses only the injected function and retains discovery and query metadata", async t => {
  const h = await fixture(t);
  // A wrapper with no private properties or setup works unchanged.
  await generate({ ...h.config, transport: (...args) => h.config.transport(...args) });
  assert.deepEqual(h.calls.map(c => c.kind), ["catalog", "capabilities", "explain"]);
  assert.ok(h.calls.every(c => c.role === "author" && Object.isFrozen(c)));
  assert.deepEqual(JSON.parse(h.calls[2].body).expected, versions);
  const source = await h.source();
  assert.match(source, /interface GetPostsParams/);
  assert.match(source, /"status": string/);
  assert.match(source, /"id": string/);
  const meta = await h.metadata();
  assert.equal(meta.endpoint, h.config.endpoint);
  assert.equal(meta.role, "author");
  assert.equal(meta.capabilities.id, "snapshot_1");
  assert.equal(meta.capabilities.abiVersion, 1);
  assert.match(meta.queries[0].queryHash, /^[a-f0-9]{64}$/);
  const program = ts.createProgram([join(h.output, "index.ts")], {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    paths: { "@unacowa/policysql/client": [resolve("packages/client/index.d.ts")] },
  });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
});

test("generated SQL, role and versions are fixed, including detached execute calls", async t => {
  const h = await fixture(t);
  await generate(h.config);
  const { getPosts } = await load(h);
  assert.equal(Object.isFrozen(getPosts), true);
  for (const field of ["sql", "role", "schemaVersion", "policyVersion", "queryHash"]) assert.throws(() => { getPosts[field] = "changed"; }, TypeError);
  const gateway = mockGateway();
  const config = { transport: createHttpTransport({ endpoint: h.config.endpoint, fetchImpl: gateway.fetchImpl }), role: "author", ...versions };
  for (const patch of [{ role: undefined }, { role: "admin" }, { schemaVersion: undefined, policyVersion: undefined }, { policyVersion: "old" }]) {
    await assert.rejects(getPosts.execute(new PolicySqlClient({ ...config, ...patch }), { status: "draft" }), /POLICYSQL_STALE_OPERATION/);
  }
  assert.equal(gateway.calls.length, 0);
  const { execute } = getPosts;
  const rows = await execute.call({ sql: "DELETE FROM posts" }, new PolicySqlClient(config), { status: "draft" });
  assert.equal(rows[0].id, "post_1");
  assert.equal(gateway.calls[0].body.statements[0].sql, getPosts.sql);
  assert.deepEqual(gateway.calls[0].body.expected, versions);
});

test("discovery, Explain, descriptor and network failures preserve existing generated files", async t => {
  const h = await fixture(t);
  await generate(h.config);
  const previous = await h.source();
  const metadata = await h.metadata();
  await writeFile(join(h.input, "second.sql"), "SELECT id FROM posts");
  for (const change of [
    (request, response) => { if (request.kind === "catalog") response.body.role = "admin"; },
    (request, response) => { if (request.kind === "capabilities") response.body.schemaVersion = "changed"; },
    (request, response) => { if (request.kind === "explain") response.body.meta.policyVersion = "changed"; },
    (request, response) => { if (request.kind === "explain") delete response.body.statements[0].result; },
    (request, response) => { if (request.kind === "explain") response.body.statements[0].result.columns[0].representation = "unknown"; },
    (request, response) => { if (request.kind === "explain") response.body.statements[0].result.columns[0].nullable = "false"; },
    (request, response) => { if (request.kind === "explain") response.body.statements[0].result.columns.push({ ...response.body.statements[0].result.columns[0], name: "ID" }); },
    request => { if (request.kind === "explain" && JSON.parse(request.body).statements[0].sql === "SELECT id FROM posts") throw new Error("second query failed"); },
  ]) {
    await assert.rejects(generate({ ...h.config, transport: async (...args) => {
      const response = await h.config.transport(...args);
      change(args[0], response);
      return response;
    } }));
    assert.equal(await h.source(), previous);
    assert.deepEqual(await h.metadata(), metadata);
  }
});

test("generation propagates original Transport exceptions and server public errors", async t => {
  const h = await fixture(t);
  const cause = new Error("credential lookup failed");
  await assert.rejects(generate({ ...h.config, transport: async () => { throw cause; } }), error => error === cause);
  const body = errorBody("POLICYSQL_STALE_OPERATION", "Please regenerate.");
  await assert.rejects(generate({ ...h.config, transport: async () => ({ status: 409, body }) }), error => error.message === body.error.message && error.response.body.error.requestId === "req_test");
  assert.deepEqual(await readdir(h.root), ["queries"]);
});

test("invalid roles, missing transport and unsafe filenames fail without installing artifacts", async t => {
  const h = await fixture(t);
  for (const role of [null, "", "ADMIN", "member,admin"]) await assert.rejects(generate({ ...h.config, role }), TypeError);
  await assert.rejects(generate({ ...h.config, transport: undefined }), TypeError);
  assert.equal(h.calls.length, 0);
  await writeFile(join(h.input, "123.sql"), "SELECT id FROM posts");
  await assert.rejects(generate(h.config), TypeError);
  assert.deepEqual(await readdir(h.root), ["queries"]);
});

test("CLI reads an application configuration module without choosing authentication", async t => {
  const h = await fixture(t);
  const configFile = join(h.root, "config.mjs");
  await writeFile(configFile, `export default { ...${JSON.stringify(h.config)}, transport: async () => { throw new Error("application transport reached") } }`);
  await assert.rejects(promisify(execFile)(process.execPath, ["packages/generator/cli.js", "generate", "--config", configFile]), error => {
    assert.match(error.stderr, /application transport reached/);
    return true;
  });
});
