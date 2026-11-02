import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ESLint } from "eslint";

// Regression guard for issue #44: the Worker tree is type-checked with `strict: true`, and no
// module declares `any`. Both are checked here as a test as well as in `npm run verify`, so a
// change that turns either off fails a named test rather than a bare script.
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("deploy/cloudflare is type-checked with strict on", () => {
  const tsconfig = JSON.parse(read("../tsconfig.json").replace(/^\s*\/\/.*$/gmu, ""));
  assert.equal(tsconfig.compilerOptions.strict, true, "strict must stay on (issue #44)");
});

test("no module may declare `any` (issue #44)", async () => {
  const eslint = new ESLint({ cwd: new URL("..", import.meta.url).pathname });
  const [result] = await eslint.lintText("const value: any = 1;\n", { filePath: "src/probe.ts" });
  assert.deepEqual(result.messages.map((message) => message.ruleId), ["@typescript-eslint/no-explicit-any"]);

  // The repository itself is clean, so the rule above is not hiding behind an ignore.
  const results = await eslint.lintFiles(["src", "wrapper", "dev-validator"]);
  const offences = results.flatMap((file) => file.messages.filter((message) => message.ruleId === "@typescript-eslint/no-explicit-any"));
  assert.deepEqual(offences.map((message) => `${message.file}:${message.line}`), []);
});

test("the one `any` the language forces is a mixin constructor, with its reason", () => {
  const text = read("../wrapper/deployment-version.ts");
  // TS2545 requires a mixin base's constructor to be `(...args: any[])`.
  assert.match(text, /eslint-disable-next-line @typescript-eslint\/no-explicit-any\s*\ntype OwnerClass/u);
  assert.equal((text.match(/: any\b/gu) ?? []).length, 2, "the mixin type and its constructor only");
});
