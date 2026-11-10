import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { digestPath, sourceDigest, sourceFiles } from "../scripts/source-digest.mjs";

// The committed module must be built from the Rust sources in this tree (PR #117 review).
test("the committed WASM in pkg/ is built from the current Rust sources", () => {
  let recorded;
  try {
    recorded = readFileSync(digestPath, "utf8").trim();
  } catch {
    assert.fail("pkg/source-digest.txt is missing: run `npm run build:wasm` and commit pkg/");
  }
  assert.equal(
    recorded,
    sourceDigest(),
    "pkg/ is stale for the Rust sources: run `npm --prefix deploy/cloudflare run build:wasm` and commit pkg/",
  );
});

test("the source digest covers the policy compiler and the WASM crate, not test-only crates", () => {
  const files = sourceFiles();
  for (const required of [
    "Cargo.lock",
    "crates/policysql-wasm/src/lib.rs",
    "crates/policysql-policy/src/lib.rs",
    "crates/policysql-parser/src/lib.rs",
    "crates/policysql-sqlite/src/lib.rs",
  ]) {
    assert.ok(files.includes(required), required);
  }
  assert.ok(!files.some((file) => file.startsWith("crates/policysql-testkit/")));
});
