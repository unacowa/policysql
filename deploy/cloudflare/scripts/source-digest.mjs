// Ties the committed WASM in `pkg/` to the Rust sources it is built from.
//
// `pkg/` is committed and the deploy tests, `verify`, and CI all run the committed module
// without rebuilding it, so a Rust change that is not rebuilt ships untested (PR #117 review:
// two merged changes were missing from the module). `build:wasm` writes
// `pkg/source-digest.txt` after a successful build: the digest of the sources and the
// sha256 of each built artifact. `test/wasm-freshness.test.mjs` recomputes both. A
// toolchain-independent digest of the inputs is used instead of comparing a rebuilt module
// byte for byte, because CI follows `stable`.
//
// The inputs fail closed: every crate under `crates/` except the test-only
// `policysql-testkit` (its `Cargo.toml`, an optional `build.rs`, and every file under `src/`),
// the root `Cargo.toml`, `Cargo.lock`, and `rust-toolchain.toml`, and `.cargo/` if present.
// A crate the module does not use only causes an unnecessary rebuild. Dotfiles (editor swap
// files) are skipped and text is hashed with LF line endings, so a CRLF checkout agrees.
//
//   node scripts/source-digest.mjs          prints the record
//   node scripts/source-digest.mjs --write  writes pkg/source-digest.txt
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const deploymentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(deploymentRoot, "../..");
const packageRoot = path.join(deploymentRoot, "pkg");
export const digestPath = path.join(packageRoot, "source-digest.txt");
/** Built files whose content the record pins. */
export const ARTIFACTS = [
  "policysql_wasm_bg.wasm",
  "policysql_wasm.js",
  // `tsc` checks `src/` against these declarations.
  "policysql_wasm.d.ts",
  "policysql_wasm_bg.wasm.d.ts",
  "package.json",
];
/** Crates that the WASM module never links (test helpers). */
const EXCLUDED_CRATES = new Set(["policysql-testkit"]);

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".")) return [];
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    if (entry.isFile()) return [full];
    // A symlink (or anything else) could point outside the scanned set: fail closed.
    throw new Error(`source-digest: unsupported entry ${full}`);
  });
}

/**
 * The scanned set is complete only while every workspace member lives in `crates/` and no
 * `[patch]` redirects a dependency elsewhere; checked by `test/wasm-freshness.test.mjs`.
 */
export function workspaceLayoutProblems(root = repositoryRoot) {
  const manifest = fs.readFileSync(path.join(root, "Cargo.toml"), "utf8");
  const problems = [];
  if (/^\s*\[patch[.\]]/m.test(manifest)) problems.push("a [patch] table");
  const members = manifest.match(/^\s*members\s*=\s*\[([^\]]*)\]/m);
  if (!members) {
    problems.push("no workspace members list");
  } else {
    for (const member of members[1].matchAll(/"([^"]+)"/g)) {
      if (!member[1].startsWith("crates/")) problems.push(`member ${member[1]} outside crates/`);
    }
  }
  return problems;
}

export function sourceFiles(root = repositoryRoot) {
  const files = [
    ...["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"].map((name) => path.join(root, name)),
    ...filesUnder(path.join(root, ".cargo")),
  ];
  const crates = fs.readdirSync(path.join(root, "crates"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !EXCLUDED_CRATES.has(entry.name));
  for (const entry of crates) {
    const crate = path.join(root, "crates", entry.name);
    files.push(path.join(crate, "Cargo.toml"), ...filesUnder(path.join(crate, "src")));
    if (fs.existsSync(path.join(crate, "build.rs"))) files.push(path.join(crate, "build.rs"));
  }
  return files
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .sort();
}

/** Text with CRLF folded to LF; binary content (a NUL byte) unchanged. */
function canonicalContent(bytes) {
  if (bytes.includes(0)) return bytes;
  return Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
}

export function sourceDigest(root = repositoryRoot) {
  const hash = createHash("sha256");
  for (const relative of sourceFiles(root)) {
    hash.update(relative);
    hash.update("\0");
    hash.update(canonicalContent(fs.readFileSync(path.join(root, relative))));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function artifactDigest(name) {
  return createHash("sha256").update(fs.readFileSync(path.join(packageRoot, name))).digest("hex");
}

/** The record `build:wasm` writes: `sources <hex>` and one `<artifact> <sha256>` per line. */
export function currentRecord() {
  return [`sources ${sourceDigest()}`, ...ARTIFACTS.map((name) => `${name} ${artifactDigest(name)}`)].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const record = currentRecord();
  if (process.argv.includes("--write")) {
    fs.writeFileSync(digestPath, `${record}\n`);
    console.log(`wrote ${path.relative(deploymentRoot, digestPath)}`);
  }
  console.log(record);
}
