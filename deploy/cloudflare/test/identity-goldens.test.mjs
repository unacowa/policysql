import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { identityRuntime as runtime } from "./helpers/identity.mjs";

// ADR 0025, Follow-up 1: identity goldens captured from main before the canonical form became
// core-defined (`tests/fixtures/identity-goldens.json`). The runtime the engine and the owner
// load must compute every one of them byte for byte; they must never change.
const { goldens } = JSON.parse(readFileSync(new URL("../../../tests/fixtures/identity-goldens.json", import.meta.url), "utf8"));

test("the deployed runtime computes every identity golden unchanged", () => {
  assert.ok(goldens.length >= 40);
  for (const { name, input, output } of goldens) {
    assert.deepEqual(JSON.parse(runtime.identity_json(JSON.stringify(input))), output, name);
  }
});
