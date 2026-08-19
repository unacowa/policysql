import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generate } from "./index.js";

test("generator treats Explain as authoritative and atomically emits role-specific TypeScript", async () => {
  const root = await mkdtemp(join(tmpdir(), "policysql-generator-"));
  try {
    const input = join(root, "queries");
    const output = join(root, "generated");
    await mkdir(input);
    await writeFile(join(input, "get-posts.sql"), "SELECT id FROM posts WHERE status = :status");
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/v1/catalog") return new Response(JSON.stringify({ schemaVersion: "schema_1", policyVersion: "policy_1" }));
      if (path === "/v1/capabilities") return new Response(JSON.stringify({ schemaVersion: "schema_1", policyVersion: "policy_1" }));
      return new Response(JSON.stringify({ statements: [{
        parameters: [{ name: "status", type: "string", representation: "string", nullable: false }],
        result: { columns: [{ name: "id", type: ["integer", "string"], representation: "string", nullable: false }] },
      }] }));
    };
    await generate({ endpoint: "https://gateway.example.com", role: "author", input, output, token: "token", fetchImpl });
    const generated = await readFile(join(output, "index.ts"), "utf8");
    assert.match(generated, /interface GetPostsParams/);
    assert.match(generated, /status: string/);
    assert.match(generated, /id: number \| string/);
    assert.match(generated, /schemaVersion: "schema_1"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
