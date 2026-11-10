// The digest of the Rust sources the committed WASM in `pkg/` is built from.
//
// `pkg/` is committed and the deploy tests, `verify`, and CI all run the committed module
// without rebuilding it, so a Rust change that is not rebuilt ships untested (PR #117 review:
// two merged changes were missing from the module). `build:wasm` writes this digest to
// `pkg/source-digest.txt` after a successful build, and `test/wasm-freshness.test.mjs`
// recomputes it from the working tree. A toolchain-independent digest of the inputs is used
// instead of comparing a rebuilt module byte for byte, because CI follows `stable`.
//
// Inputs: the root `Cargo.toml`, `Cargo.lock`, and `rust-toolchain.toml`, and for
// `policysql-wasm` and every crate it reaches through `path` entries of a `[dependencies]`
// table, its `Cargo.toml` and every file under its `src/`.
//
//   node scripts/source-digest.mjs          prints the digest
//   node scripts/source-digest.mjs --write  writes pkg/source-digest.txt
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const deploymentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(deploymentRoot, "../..");
export const digestPath = path.join(deploymentRoot, "pkg", "source-digest.txt");

/** Crate directory names reached from `policysql-wasm` through `[dependencies]` paths. */
function crateClosure(root) {
  const seen = new Set();
  const pending = ["policysql-wasm"];
  while (pending.length > 0) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const manifest = fs.readFileSync(path.join(root, "crates", name, "Cargo.toml"), "utf8");
    let inDependencies = false;
    for (const line of manifest.split("\n")) {
      const table = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (table) {
        inDependencies = table[1].trim() === "dependencies";
        continue;
      }
      const dependency = inDependencies && line.match(/path\s*=\s*"\.\.\/([A-Za-z0-9_-]+)"/);
      if (dependency) pending.push(dependency[1]);
    }
  }
  return [...seen].sort();
}

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(full) : entry.isFile() ? [full] : [];
  });
}

export function sourceFiles(root = repositoryRoot) {
  const files = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"].map((name) => path.join(root, name));
  for (const name of crateClosure(root)) {
    const crate = path.join(root, "crates", name);
    files.push(path.join(crate, "Cargo.toml"), ...filesUnder(path.join(crate, "src")));
  }
  return files
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .sort();
}

export function sourceDigest(root = repositoryRoot) {
  const hash = createHash("sha256");
  for (const relative of sourceFiles(root)) {
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const digest = sourceDigest();
  if (process.argv.includes("--write")) {
    fs.writeFileSync(digestPath, `${digest}\n`);
    console.log(`wrote ${path.relative(deploymentRoot, digestPath)}: ${digest}`);
  } else {
    console.log(digest);
  }
}
