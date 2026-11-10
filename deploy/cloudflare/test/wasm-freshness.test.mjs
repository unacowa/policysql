import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ARTIFACTS, artifactDigest, digestPath, sourceDigest, sourceFiles, workspaceLayoutProblems,
} from "../scripts/source-digest.mjs";

const REBUILD = "run `npm --prefix deploy/cloudflare run build:wasm` and commit pkg/";

function recorded() {
  let text;
  try {
    text = readFileSync(digestPath, "utf8");
  } catch {
    assert.fail(`pkg/source-digest.txt is missing: ${REBUILD}`);
  }
  return new Map(text.trim().split("\n").map((line) => {
    const [name, digest, ...rest] = line.trim().split(/\s+/);
    assert.equal(rest.length, 0, `malformed record line: ${line}`);
    return [name, digest];
  }));
}

// The committed module must be built from the Rust sources in this tree (PR #117 review).
test("the committed WASM in pkg/ is built from the current Rust sources", () => {
  const record = recorded();
  assert.equal(record.get("sources"), sourceDigest(), `pkg/ is stale for the Rust sources: ${REBUILD}`);
  for (const name of ARTIFACTS) {
    assert.equal(record.get(name), artifactDigest(name), `pkg/${name} is not the recorded build: ${REBUILD}`);
  }
  assert.deepEqual([...record.keys()].sort(), ["sources", ...ARTIFACTS].sort());
});

test("the source digest covers every non-test crate and fails closed", () => {
  // Every input of the build must be inside the scanned set (PR #117 review).
  assert.deepEqual(workspaceLayoutProblems(), []);
  const files = sourceFiles();
  for (const required of [
    "Cargo.lock",
    "Cargo.toml",
    "rust-toolchain.toml",
    "crates/policysql-wasm/src/lib.rs",
    "crates/policysql-wasm/Cargo.toml",
  ]) {
    assert.ok(files.includes(required), required);
  }
  const crates = new Set(files.filter((file) => file.startsWith("crates/")).map((file) => file.split("/")[1]));
  // Every crate policysql-wasm links today (`cargo tree -p policysql-wasm -e normal`).
  for (const crate of [
    "policysql-catalog", "policysql-core", "policysql-execution", "policysql-gateway",
    "policysql-ir", "policysql-parser", "policysql-policy", "policysql-sqlite",
    "policysql-transaction", "policysql-turso", "policysql-wasm",
  ]) {
    assert.ok(crates.has(crate), crate);
  }
  assert.ok(!crates.has("policysql-testkit"));
  assert.ok(!files.some((file) => file.split("/").some((part) => part.startsWith("."))));
});
